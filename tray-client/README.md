# 桌面聊天客户端（Tauri）

一个 4 MB 的 Windows 托盘程序：缩在右下角，点一下弹出 400×800 的窄高聊天框。
纯聊天，不含网页端的管理功能。

## 体积

```
fish-tray.exe   4.27 MB
依赖            无（用系统自带的 WebView2）
```

对比 Electron 方案（150 MB+），只有 1/35。

## 功能

- 托盘图标，左键点开 / 右键菜单（打开、退出）
- 窗口贴右下角，可拖动、可缩放
- 点关闭按钮 = 缩回托盘（不退出）
- 聊天气泡（复用网页端样式）
- 工具调用的彩色中文气泡
- 日夜切换（记住偏好）
- 首次运行弹配置窗（服务器地址 + token）
- token 存在 Rust 侧，前端 JS 拿不到
- 每 2 秒轮询新消息

## 编译

需要：Rust 工具链、Node.js、WebView2（Win10 1803+ / Win11 自带）。

```bash
npm install
npx tauri build
```

产物：
```
src-tauri/target/release/fish-tray.exe
```

首次编译约 3 分钟（依赖下载另算）。国内建议配置镜像：

```toml
# ~/.cargo/config.toml
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
```

```bash
export RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup
```

## 使用

1. 双击 `fish-tray.exe`
2. 首次运行填服务器地址和 token：
   - 地址形如 `http://1.2.3.4:3081` 或 `https://xxx.trycloudflare.com`
3. 点「保存并连接」
4. 之后点托盘图标就能聊天

## 服务器端要求

网页端默认绑 `127.0.0.1`，客户端从外部连不上。三种办法：

| 方式 | 说明 |
|---|---|
| **Cloudflare Tunnel**（推荐） | 不用开放端口，自带 HTTPS，不会断 |
| **公网直连** | 把 `webuiBind` 改成 `0.0.0.0`，开放端口，建议加 HTTPS |
| **SSH 隧道** | `ssh -L 3081:127.0.0.1:3081`，客户端填 `http://127.0.0.1:3081` |

## 已知限制

- 只做聊天，没有网页端的「页面 / 动态区 / 快捷入口」
- 用轮询而不是 SSE（2 秒延迟）
- 没有开机自启（可以自己加个快捷方式到启动目录）
- 打包成 NSIS 安装包需要从 GitHub 下载工具，网络差时可能失败（exe 本身不受影响）
