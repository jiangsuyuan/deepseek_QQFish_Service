# 桌面客户端（WinForms，单文件，无依赖）

一个 **136 KB** 的 Windows 聊天窗口，自带 SSH 隧道，贴屏幕右边常驻。

不依赖系统托盘 —— 因为 Win11 对**未签名程序**的托盘图标有限制（实测微信/QQ 有图标，自编译的 exe 没有）。

## 形态

```
启动
  ↓
屏幕右侧中间出现一个 56×56 的圆角小方块（贴边球）
  ↓
点一下 → 展开成 400×800 的聊天窗口
  ↓
点 ×  → 缩回小球
```

**拖动**：按住小球拖到任何位置，松手不会展开。
**点 × 之外的退出方式**：右键 → 退出。

## 特性

| 项 | 说明 |
|---|---|
| **自带 SSH 隧道** | 启动时自动建，端口通了就复用 |
| **隧道重连** | 标题栏「重连」按钮；轮询连续失败 3 次也会自动重建 |
| **只杀自己建的隧道** | 靠 `tunnel.pid` 记录，不动你在别处开的 ssh |
| **token 不出 Rust** | 存在 `%APPDATA%\fish-tray\settings.json`，由 C# 读出来拼 URL，界面上任何地方都看不到 |
| **聊天记录** | 2 秒轮询 `/history`，本地乐观显示 + 去重 |
| **气泡样式** | 左灰右蓝、圆角、工具调用是彩色中文小标签 |
| **日夜切换** | 标题栏月亮/太阳按钮，记住偏好 |
| **窗口圆角** | 12px；气泡 10px；工具标签 8px；输入框 8px；按钮 6-8px |

## 编译

只需要 Windows 自带的 .NET Framework 4.8 编译器，**不用装任何 SDK**：

```powershell
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

& $csc /nologo /target:winexe `
    /win32icon:app.ico `
    /resource:fish.jpg,FishTray.fish.jpg `
    /out:FishTray.exe `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    /r:System.Web.Extensions.dll /r:System.Net.Http.dll /r:System.Core.dll `
    AssemblyInfo.cs Main.cs
```

产物 **141 KB**（含 91 KB 的图标图片）。`FishTray.exe` 已经编译好放在这个目录里，**不需要自己编译也能直接跑**。

## 首次运行

会弹一个配置窗，填四项：

| 字段 | 例子 |
|---|---|
| 服务器地址 | `http://127.0.0.1:3081` |
| token | （服务端 WebUI 的 token） |
| SSH 密钥 | `D:\keys\id_ed25519_xxx` |
| SSH 服务器 | `root@1.2.3.4` |

保存在 `%APPDATA%\fish-tray\settings.json`。

## 代码结构

`Main.cs` 约 1200 行，一个文件：

| 类 | 作用 |
|---|---|
| `Settings` | 读写 `%APPDATA%\fish-tray\settings.json` |
| `Palette` | 日间/夜间两套配色 |
| `Log` | 写 `exe 同目录\run.log`（`%APPDATA%` 可能被安全软件拦） |
| `Tunnel` | SSH 隧道管理（建、复用、只杀自己的） |
| `Api` | HTTP（`/history` GET、`/send` POST） |
| `Msg` | 消息模型 |
| `Bubble` | 自绘气泡（圆角、工具中文名+分类配色） |
| `R` | 圆角路径/裁剪工具 |
| `IconBtn` | 自绘图标按钮（叉 / 月牙 / 太阳），不走字体 |
| `ChatForm` | 主窗口（贴边常驻、拖动、主题切换、轮询） |
| `SetupForm` | 首次配置窗 |

## 踩过的坑

1. **托盘图标在 Win11 不显示**：`NotifyIcon` 设了 `Visible=true` 也看不到。对比发现微信/QQ 的 exe **有数字签名**，自编译的 `NotSigned`。`ShowBalloonTip` 能弹（说明 `Shell_NotifyIcon` 通），但图标不出现。最后改成贴边常驻绕开。
2. **`BackColor = Color.Transparent` 会崩**：`Control` 默认不支持，必须先 `SetStyle(ControlStyles.SupportsTransparentBackColor, true)`。
3. **`Region` 设了不生效**：`Size` 是在构造函数里赋的，那时 `OnResize` 可能已经跑过。要在构造末尾显式调一次。
4. **`MinimumSize` 会卡住收起**：收起时 `Width = 7` 被 `MinimumSize(380,600)` 拦住，实际还是 380。收起前要 `MinimumSize = Size.Empty`。
5. **`Icon.ToBitmap()` 有时返回全透明图**：`MakeFishIcon(...).ToBitmap()` 画出来是空的。改用 `Graphics.DrawImage` 直接画。
6. **`FillMode.Alternate` 是异或不是减法**：画月牙时两个圆会变成"一个圆 + 一个月牙"。要用 `Region.Exclude`。
7. **雅黑没有 `☾` 字形**：会显示成 `(`。图标按钮一律自绘。
8. **消息双份**：本地乐观显示 + 轮询回推会画两遍。记住刚发的原文，回来时比对吞掉。
9. **主题切换气泡不变色**：气泡颜色在构造时定死，`Invalidate()` 只重绘不换色。要 `ApplyPalette()` 重新赋值。

## 图标位置

**小球拖到哪，下次收起就还在哪**（2026-10-31 修）。

之前每次收起都强制归位到屏幕右侧中央，拖动等于白拖。现在：

```csharp
Point collapsedPos;      // 记住的位置
bool hasCollapsedPos;

// 拖动结束
collapsedPos = Location;
hasCollapsedPos = true;

// 收起时
if (hasCollapsedPos) { Left = collapsedPos.X; Top = collapsedPos.Y; }
else { /* 第一次才用默认位置 */ }
```

**展开时围绕小球**（不是固定在右下角）：

```csharp
Height = Math.Min(800, wa.Height - 40);   // 屏矮就缩，别伸出边界

int iconRight   = collapsedPos.X + COLLAPSED_W;
int iconCenterY = collapsedPos.Y + COLLAPSED_H / 2;
int tx = iconRight - Width;
int ty = iconCenterY - 40;

var pos = ClampToScreen(tx, ty, Width, Height, wa);   // 越界推回来
```

`ClampToScreen` 用 `Screen.FromControl(this).WorkingArea`（**当前屏幕**，多显示器也对）。

## 已知限制

- 图片消息只显示 `［图片］路径`，没真正加载缩略图
- 只有 Windows 版（`System.Windows.Forms`）
- 没做开机自启
- 小球位置只在**本次运行**内记住，重启回到屏幕右侧中间（要持久化得写进 `settings.json`）
