#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, WebviewWindow,
};

/// 服务器地址和 token（首次运行由前端设置，存在这里）
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    base: String,
    token: String,
}

fn settings_path() -> std::path::PathBuf {
    let mut p = dirs_config();
    p.push("fish-tray");
    let _ = std::fs::create_dir_all(&p);
    p.push("settings.json");
    p
}

fn dirs_config() -> std::path::PathBuf {
    std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_settings() -> Settings {
    load_settings()
}

#[tauri::command]
fn save_settings(base: String, token: String) -> Result<(), String> {
    let s = Settings { base, token };
    let txt = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), txt).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ApiReply {
    ok: bool,
    status: u16,
    body: String,
}

/// 统一请求：前端不用管 token，只发路径
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
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(r) => {
            let st = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            Ok(ApiReply { ok: st >= 200 && st < 300, status: st, body })
        }
        Err(e) => Ok(ApiReply { ok: false, status: 0, body: format!("连不上：{e}") }),
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
        Err(e) => Ok(ApiReply { ok: false, status: 0, body: format!("连不上：{e}") }),
    }
}

/// 把窗口摆到右下角
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

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("chat") {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            place_bottom_right(&win);
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            api_get,
            api_send
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开聊天", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let mut builder = TrayIconBuilder::with_id("main")
                .tooltip("竹筒肥鱼")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = ev
                    {
                        toggle_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            let _ = builder.build(app);
            Ok(())
        })
        .on_window_event(|win, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = win.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
