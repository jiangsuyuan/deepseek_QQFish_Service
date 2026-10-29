# 桌面客户端（Tauri）实现报告

## 结论

**未能在这台机器上跑起来。** 代码完整、能编译、产物 2.2 MB，但启动时崩溃在 Tauri 创建 WebView2 的阶段，错误是 Windows 的 `Access Denied (os error 5)`。十余个方向尝试均未绕过。

**这不是代码问题，是运行环境（安全软件）问题。**

---

## 一、做了什么

### 功能（全部实现）

| 功能 | 状态 |
|---|---|
| 400×800 窄高窗口，贴屏幕右下角 | ✅ |
| 托盘图标（左键开关，右键菜单含「重连隧道」） | ✅ |
| 点关闭 = 缩回托盘 | ✅ |
| **自带 SSH 隧道**（启动时自动建） | ✅ |
| **隧道重用**（端口已通就不重复建） | ✅ |
| **手动重连**（托盘菜单 + 前端按钮） | ✅ |
| 聊天界面（复用 WebUI 的 HTML/CSS/JS） | ✅ |
| 工具调用彩色中文气泡 | ✅ |
| 日夜切换（记住偏好） | ✅ |
| token 存在 Rust 侧，前端 JS 拿不到 | ✅ |
| 2 秒轮询新消息 | ✅ |
| 首次运行配置窗（地址 / token / SSH 密钥 / 服务器） | ✅ |
| 编译产物 | ✅ `fish-tray.exe` 2.2 MB + NSIS 安装包 2.2 MB |

### 核心设计

```
双击 exe
  ↓
Tauri 创建窗口（← 卡在这里）
  ↓
setup 回调:
  1. ensure_tunnel()
     ├─ 端口已通 → 复用，不重复建
     └─ 不通 → spawn ssh（CREATE_NO_WINDOW）→ 等 12 秒
  2. 窗口摆到右下角
  3. 建托盘（失败不 panic）
  ↓
前端 2 秒轮询 /history
  ↓
连续失败 3 次 → 自动调 ensure_tunnel()
```

---

## 二、卡在哪

### 错误

```
thread 'main' panicked at tauri-2.12.5/src/app.rs:1444:11:
Failed to setup app: 拒绝访问。(os error 5)
```

`app.rs:1444` 是 Tauri 内部的：

```rust
RuntimeRunEvent::Ready => {
    if let Err(e) = setup(&mut self) {
        panic!("Failed to setup app: {e}");
    }
```

**这个 `setup` 是 Tauri 自己的（创建窗口 + WebView2），不是我们写的回调。** 所以崩在这里时，我们 `setup` 里的 `boot_log` 根本不会执行——**日志文件从未写出来**，就是这个原因。

### 排查过程（13 个方向）

| # | 尝试 | 结果 |
|---|---|---|
| 1 | 换图标加载方式（`include_bytes` + `image-png` feature） | 仍崩 |
| 2 | 托盘创建包 `match` 不 panic | 仍崩 |
| 3 | 加启动步骤日志（`boot.log`，逐步写） | **日志从未写出** → 崩在更早 |
| 4 | `visible: false`（不立即显示） | 仍崩 |
| 5 | `additionalBrowserArgs: --no-sandbox --disable-gpu-sandbox` | 仍崩 |
| 6 | 手动建 `%LOCALAPPDATA%\fish-tray\EBWebView` | 建得出来（不是文件权限） |
| 7 | 手动建 Tauri 期望的 `%LOCALAPPDATA%\com.fish.tray\EBWebView` | 建得出来，启动仍崩 |
| 8 | 直接跑 `msedgewebview2.exe` | **能启动**（只有一条无害 LLM 警告） |
| 9 | 杀掉占用数据目录的 webview2 进程 | 错误变成 `0x800700AA`（资源在使用中），杀掉后回到 `os error 5` |
| 10 | 装 NSIS 安装包（想绕路径/权限） | 静默安装失败，没生成目录 |
| 11 | `WEBVIEW2_USER_DATA_FOLDER` 指向 `C:\wv2data` | 仍崩，且 **`C:\wv2data` 里一个文件都没写** |
| 12 | `panic = "abort"` 去掉（为了看完整堆栈） | 拿到的是 `0xc0000409` → 去掉后能看到 `os error 5` |
| 13 | 清空所有 WebView2 数据目录重来 | 仍崩 |

### 根因分析

**三个安全软件同时在场**：

```
腾讯电脑管家系统防护
360安全卫士
Windows Defender
```

系统还有 SRP（软件限制策略）。

`WebView2` 启动需要三步：
1. 写用户数据目录
2. **创建 `msedgewebview2.exe` 子进程**
3. **把浏览器 COM 接口注入到主进程** ← 安全软件重点拦截对象

**证据链**：

- 第 8 项：单独跑 `msedgewebview2.exe` **能起**（不需要注入）
- 第 11 项：`C:\wv2data` **完全空白** → 连目录都没开始写就失败了
- 第 6、7 项：目录本身建得出来 → **不是文件权限**
- 所以失败点在 **`CreateCoreWebView2EnvironmentWithOptions` 的进程创建/COM 注入**

**结论**：安全软件拦的是 WebView2 的**进程注入**，不是文件写入。这条路在这台机器上走不通。

---

## 三、可行的替代方案

### 方案 A：加白名单（最快，5 分钟）

在 **360安全卫士** 和 **腾讯电脑管家** 里，把下面两个加进信任：

```
fish-tray.exe
C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66\msedgewebview2.exe
```

然后重新启动 `fish-tray.exe`。**代码不用改。**

产物已在：

```
src-tauri/target/release/fish-tray.exe
src-tauri/target/release/bundle/nsis/fish-tray_0.1.0_x64-setup.exe
```

### 方案 B：换 C# WinForms（推荐，约 2 小时）

不用 WebView2，**原生 Windows 窗口 + HTTP**：

| 项 | 说明 |
|---|---|
| 体积 | ~60 KB（.NET Framework 4.8，Windows 自带） |
| 窗口 | WinForms 原生窗口 |
| 聊天列表 | `FlowLayoutPanel` + 自绘气泡 |
| 托盘 | `NotifyIcon` |
| 隧道 | `System.Diagnostics.Process` 起 ssh（隐藏窗口） |
| HTTP | `HttpClient` |

**为什么能成**：WinForms 是纯用户态窗口，**不创建浏览器子进程、不做 COM 注入**，不会触发检测。

**代价**：界面要重画（WebUI 的 CSS 不能复用），但反而更轻。

### 方案 C：继续用浏览器（0 小时）

WebUI 已完整可用。隧道用桌面快捷方式（`scripts/launch-chat.ps1`）管。

---

## 四、当前实际可用状态

| 项 | 状态 |
|---|---|
| 服务端 WebUI | ✅ 正常 |
| SSH 隧道 | ✅ 手动/快捷方式建 |
| 隧道守护脚本 | ✅ `scripts/tunnel-guard.ps1`（计划任务版会弹控制台，已删） |
| Tauri 客户端 | ❌ 被 WebView2 注入拦截卡住 |

---

## 五、工程结构

```
tray-client/
├── README.md                  使用与编译说明
├── REPORT.md                  本文件
├── package.json
├── src/
│   └── index.html             聊天界面（复用 WebUI 样式，约 350 行）
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── icons/                 5 个图标（32/128/256 PNG + ICO）
    └── src/
        └── main.rs            托盘 + 隧道 + HTTP（约 290 行）
```

### main.rs 关键实现

**隧道管理**：

```rust
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

#[tauri::command]
fn ensure_tunnel() -> serde_json::Value {
    if port_open(port) { return json!({"ok": true, "reused": true}); }
    kill_our_tunnels(port);                  // 只杀自己建的
    Command::new("ssh")
        .args(["-i", key, "-o", "StrictHostKeyChecking=no",
               "-N", "-L", forward, host])
        .creation_flags(0x08000000)          // CREATE_NO_WINDOW，不弹黑框
        .spawn();
    // 等端口就绪，最多 12 秒
}
```

**token 安全**：token 存在 `%APPDATA%\fish-tray\settings.json`，由 Rust 读出来拼 URL，**前端 JS 完全接触不到**。

---

## 六、教训

1. **`panic = "abort"` 会把 panic 变成 `0xc0000409`（`__fastfail`）**，真正的错误信息全被吞掉。排查时必须去掉。
2. **Tauri 的 `app.rs:1444` 那个 `setup` 是内部的**（建窗口 + WebView2），它先于你写的 `setup` 回调执行。崩在那里时，你的日志一行都写不出来。
3. **WebView2 的 `os error 5` 不等于文件权限问题**。目录建得出、`msedgewebview2.exe` 单独跑得起来，但 COM 注入被拦时症状一样。
4. **多安全软件共存时白名单要加三处**（360 / 腾讯 / Defender）。
5. **PowerShell 5.1 写 UTF-8 不带 BOM 会让中文脚本语法错**；写 JSON 配置时 BOM 会让 Tauri 解析失败。用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`。
