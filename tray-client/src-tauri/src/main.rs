#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use std::process::Command;
use tauri::{Manager, PhysicalPosition, WebviewWindow};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Default, Serialize, Deserialize, Clone)]
struct Settings {
    base: String,
    token: String,
    #[serde(default, rename = "sshKey")]
    ssh_key: String,
    #[serde(default, rename = "sshHost")]
    ssh_host: String,
    #[serde(default = "default_port")]
    port: u16,
}

fn default_port() -> u16 {
    3081
}

fn appdata() -> std::path::PathBuf {
    std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn settings_path() -> std::path::PathBuf {
    let mut p = appdata();
    p.push("fish-tray");
    let _ = std::fs::create_dir_all(&p);
    p.push("settings.json");
    p
}

fn boot_log(msg: &str) {
    let mut p = appdata();
    p.push("fish-tray");
    let _ = std::fs::create_dir_all(&p);
    p.push("boot.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", msg);
    }
}

fn load_settings() -> Settings {
    let mut s: Settings = std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if s.port == 0 {
        s.port = 3081;
    }
    s
}

#[tauri::command]
fn get_settings() -> Settings {
    load_settings()
}

#[tauri::command]
fn save_settings(s: Settings) -> Result<(), String> {
    let txt = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), txt).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ApiReply {
    ok: bool,
    status: u16,
    body: String,
}

#[tauri::command]
async fn api_get(path: String) -> Result<ApiReply, String> {
    let s = load_settings();
    if s.base.is_empty() {
        return Ok(ApiReply { ok: false, status: 0, body: "还没配置服务器地址".into() });
    }
    let sep = if path.contains('?') { "&" } else { "?" };
    let url = format!("{}{}{}token={}", s.base.trim_end_matches('/'), path, sep, s.token);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(r) => {
            let st = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            Ok(ApiReply { ok: st >= 200 && st < 300, status: st, body })
        }
        Err(e) => Ok(ApiReply { ok: false, status: 0, body: format!("{e}") }),
    }
}

#[derive(Serialize, Deserialize)]
struct SendBody {
    text: String,
    #[serde(default)]
    from: String,
}

#[tauri::command]
async fn api_send(text: String, from: Option<String>) -> Result<ApiReply, String> {
    let s = load_settings();
    if s.base.is_empty() {
        return Ok(ApiReply { ok: false, status: 0, body: "还没配置服务器地址".into() });
    }
    let url = format!("{}/send?token={}", s.base.trim_end_matches('/'), s.token);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let payload = SendBody { text, from: from.unwrap_or_default() };
    match client.post(&url).json(&payload).send().await {
        Ok(r) => {
            let st = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            Ok(ApiReply { ok: st >= 200 && st < 300, status: st, body })
        }
        Err(e) => Ok(ApiReply { ok: false, status: 0, body: format!("{e}") }),
    }
}

fn port_open(port: u16) -> bool {
    match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(600)).is_ok(),
        Err(_) => false,
    }
}

fn kill_our_tunnels(port: u16) {
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | Where-Object {{ $_.CommandLine -like '*-L {port}:*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let _ = cmd.output();
}

#[tauri::command]
fn ensure_tunnel() -> serde_json::Value {
    let s = load_settings();
    let port = s.port;

    if port_open(port) {
        return serde_json::json!({ "ok": true, "reused": true });
    }
    if s.ssh_key.is_empty() || s.ssh_host.is_empty() {
        return serde_json::json!({ "ok": false, "error": "还没填 SSH 密钥路径和服务器地址" });
    }

    kill_our_tunnels(port);

    let forward = format!("{port}:127.0.0.1:{port}");
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-i",
        &s.ssh_key,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=NUL",
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        &forward,
        &s.ssh_host,
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    match cmd.spawn() {
        Ok(c) => {
            for _ in 0..12 {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if port_open(port) {
                    boot_log(&format!("tunnel up, pid={}", c.id()));
                    return serde_json::json!({ "ok": true, "reused": false, "pid": c.id() });
                }
            }
            serde_json::json!({ "ok": false, "error": "隧道进程起了但端口没通" })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": format!("ssh 启动失败：{e}") }),
    }
}

fn place_bottom_right(win: &WebviewWindow) {
    if let Ok(Some(mon)) = win.current_monitor() {
        let size = mon.size();
        let scale = mon.scale_factor();
        let w = (400.0 * scale) as i32;
        let h = (800.0 * scale) as i32;
        let x = size.width as i32 - w - (12.0 * scale) as i32;
        let y = size.height as i32 - h - (48.0 * scale) as i32;
        let _ = win.set_position(PhysicalPosition::new(x.max(0), y.max(0)));
    }
}

fn main() {
    boot_log("main entered");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            api_get,
            api_send,
            ensure_tunnel
        ])
        .setup(|app| {
            boot_log("setup entered");

            // 建隧道（失败不影响窗口）
            let r = ensure_tunnel();
            boot_log(&format!("ensure_tunnel -> {r}"));

            // 窗口摆右下角
            if let Some(win) = app.get_webview_window("chat") {
                boot_log("window found");
                place_bottom_right(&win);
            } else {
                boot_log("window NOT found");
            }

            boot_log("setup done");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
