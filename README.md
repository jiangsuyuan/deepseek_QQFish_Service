# deepseek_QQFish_Service

把 **DeepSeek Harness** 接到 **QQ** 里的桥。

基于 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 连接 QQ，
让 DSH 的 Agent 能在私聊和群里说话——并且带记忆、有作息、会主动找你。

> 本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个 Cordis 插件，
> 不是独立程序。你需要先有 DSH 和 NapCat。

> 📊 **完整流程图**：[`docs/flow.html`](docs/flow.html)
> 8 张图覆盖消息链路、指令分发、群聊私聊分支、Agent 与回复、定时任务、健康自愈、记忆数据流、工具调用链。

> 🤖 **让 AI 帮你部署**：把你的 AI agent 指向 [`DEPLOY.md`](DEPLOY.md)——
> 那是可执行的步骤清单，每步带验证命令和失败排查，专门写给 agent 看的。

---

## ⚠️ 先看这里：强烈建议部署在服务器上

**不要把机器人装在你自己的电脑上。** 它需要 24 小时在线，
而你电脑一关机、一睡眠，机器人就失联了；家里宽带 IP 变化还会导致 QQ 频繁要求重新验证。

推荐架构是「服务器跑服务，本机只当客户端」：

```
┌──────────────┐        SSH 隧道          ┌───────────────────────────┐
│   你的电脑     │ ───────────────────────> │   一台 Linux 服务器         │
│              │   3080 / 6099            │                           │
│  浏览器        │                          │   DSH Web（配置 + 对话）    │
│  终端          │                          │   dsh-onebot-bridge       │
└──────────────┘                          │   NapCat（QQ 协议端）       │
                                          │   Xvfb / ffmpeg            │
                                          └───────────────────────────┘
```

你**安装、配置、看日志**都在服务器上（SSH）；
**日常使用**只需要浏览器打开本地地址（SSH 隧道转发）。

---

## 准备工作

### 1. 服务器

| 项 | 最低 | 推荐 |
|---|---|---|
| 系统 | Linux x86_64（CentOS 8+ / Ubuntu 20.04+） | Ubuntu 22.04 |
| glibc | ≥ 2.28 | — |
| 内存 | 2GB | 4GB |
| 磁盘 | 10GB | 20GB |
| 网络 | 能访问 QQ 服务器与 `api.deepseek.com` | — |

> 按量付费的小规格云服务器就够，一个月十几块。

### 2. QQ 账号（机器人）

| 项 | 说明 |
|---|---|
| 一个 QQ 号 | **强烈建议用小号**，不要用主号 |
| 密码（可选） | 配置后可减少扫码次数 |
| 关闭设备锁 | 否则每次登录都要验证，机器人会反复掉线 |
| 不要频繁在手机上登录同一账号 | 会把它踢下线（`KickedOffLine`） |

> ⚠️ **风险提示**：第三方协议登录可能触发腾讯风控，轻则掉线，重则限制登录。
> 请自行评估风险，不要在重要账号上使用。

### 3. 管理员（你）

| 项 | 说明 |
|---|---|
| 一个 QQ 号 | 你自己，用于下发管理指令 |
| **必须先加机器人为好友** | 否则机器人无法主动私聊你（报警、入群确认、状态汇报都靠私聊） |
| 把机器人拉进群 | 或让群友邀请（它会把邀请转发给你确认） |

管理员的身份由配置里的 `ownerId` 认定，不是 QQ 好友关系；
但**好友关系是私聊能送达的前提**。

### 4. API Key（重要：不要泄露）

| 项 | 说明 |
|---|---|
| DeepSeek API Key | 到 [platform.deepseek.com](https://platform.deepseek.com) 申请并充值 |
| 存放方式 | **只放环境变量** `DEEPSEEK_API_KEY`，**不要写进任何文件** |
| 费用预估 | 日常聊天约 0.5–2 元/天 |

> 🔐 **安全红线**：
> - 不要把 key 写进 `config.json`、`index.js`、README 或任何会提交到 Git 的文件
> - 不要把 `~/.dsh/` 下的任何文件提交到仓库
> - 如果 key 曾经泄露过（比如截图、日志、聊天记录），**立刻去后台重置**
> - 用 `.gitignore` 挡住本地配置，提交前用 `git status` 确认没有意外文件

---

## 安装

### 第一步：环境

```bash
# 在服务器上执行
bash scripts/install.sh
```

脚本会装：Node 24、pnpm、DSH CLI、Xvfb、ffmpeg。

### 第二步：NapCat

按 [NapCat 官方文档](https://napneko.github.io) 安装 Linux 版，然后：

```bash
napcat          # 交互式安装，选择 CLI 模式
```

> 本项目**不分发** NapCat 的任何代码。请从其官方仓库获取，
> 并遵守其许可（禁止商业用途）。

### 第三步：扫码登录

```bash
systemctl start napcat

# 二维码在：
~/Napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png
```

**扫码时勾选「快速登录」**——否则每次重启都要重新扫，
而 QQ 被踢下线是常态。

### 第四步：开启 OneBot 接口

编辑 `~/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/onebot11_<QQ号>.json`：

```json
{
  "network": {
    "websocketServers": [{
      "name": "bridge",
      "enable": true,
      "host": "127.0.0.1",
      "port": 3001,
      "messagePostFormat": "array",
      "reportSelfMessage": false,
      "token": "换成一串你自己生成的随机字符",
      "enableForcePushEvent": true
    }]
  }
}
```

重启 NapCat 生效。

### 第五步：装插件

```bash
# 1. 桥本体
dsh plugin --profile web add /path/to/这个仓库

# 2. 配套插件（记忆、主动搭话、朗读、B 站、心情）
bash scripts/install-plugins.sh web
```

> 配套插件是**推荐必备**的：没有它们桥也能对话，
> 但会失去长期记忆、主动搭话、心情起伏这些"人味"能力。
> 详见下方「配套插件」章节。

### 第六步：配置

```bash
mkdir -p ~/.dsh/onebot-bridge
cp config.example.json ~/.dsh/onebot-bridge/config.json
```

至少改这四个值：

| 字段 | 填什么 |
|---|---|
| `selfId` | 机器人的 QQ 号 |
| `ownerId` | **你的** QQ 号 |
| `token` | 与第四步里一致的随机串 |
| `prewarmGroups` | 想让机器人常驻的群号（可空） |

再设置 API Key（systemd 方式）：

```bash
systemctl edit dsh-web
```

加入：

```ini
[Service]
Environment=DEEPSEEK_API_KEY=你的key
```

### 第七步：启动验证

```bash
systemctl restart dsh-web
```

然后用你的 QQ **私聊机器人**，发：

```
帮助
```

收到功能清单就说明一切正常。

---

## 日常使用（SSH 隧道）

在你**本机**新开一个终端：

```bash
ssh -N \
  -L 3080:127.0.0.1:3080 \
  -L 6099:127.0.0.1:6099 \
  root@你的服务器IP
```

保持它开着，然后浏览器访问：

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:3080` | DSH 主界面（对话、设置、插件） |
| `http://127.0.0.1:6099/webui` | NapCat 管理面板（扫码、看登录状态） |

首次访问 DSH 需要 token，在服务器上取：

```bash
journalctl -u dsh-web -n 50 | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1
```

> 隧道只在你的电脑和服务器之间生效，公网访问不到 3080/6099。
> 也不要为了省事把端口开到公网。

---

## 她能做什么

### 对话

- 私聊直接说话；群里 @ 她或叫名字
- 群里聊过一次后，**1 分钟内不用 @ 也能接着聊**（最多 5 轮）
- 支持**图片理解**（DeepSeek 视觉）
- 发链接会**扫一眼正文前 600 字**
- 表情包（70 张带情绪标签）、emoji、分条发送、正在输入
- 私聊连发几条会**合并成一次回复**；偶尔会连说 2–3 句

### 消息理解

| 类型 | 能力 |
|---|---|
| **合并转发** | 展开前 5 条 + 最多 2 张图；套娃转发再展开一层；觉得有意思可调 `read_forward_more` 看后面 |
| **引用转发** | 引用一条转发再 @ 她，自动追溯被引用的消息 |
| **“看上面的转发”** | 只 @ 不引用也行——往上翻 25 条找最近的转发 |
| **文本文件** | `.txt/.md/.log/.json/.csv` 等读前 1000 字（≤1MB）；非文本只提示文件名 |
| **空 @** | 只 @ 不打字，会回看前面 10 条聊天记录再接话，不问“怎么了” |

### 内置工具

| 工具 | 作用 |
|---|---|
| `send_sticker` | 发一张表情包 |
| `hot_news` | 查当前热搜（问“最近有什么新鲜事”时用） |
| `at_person` | 群里 @ 某人（每小时最多 3 次） |
| `recall` | 回忆很久以前的对话（原文归档检索） |
| `read_forward_more` | 继续展开合并转发 |
| `remember_fact` / `remember_person` | 记住事实 / 记住某人的特点 |
| `remember_self` | 记录她自己的想法 |

### 记忆

| 层 | 内容 | 范围 |
|---|---|---|
| 人格 | 她是谁、怎么说 | 配置文件 |
| 人物档案 | 对每个人的印象、称呼、关系阶段 | 跨群 |
| 全局事实 | 城市、职业、喜好 | 跨会话 |
| 自我观点 | 她自己的看法 | 跨会话，会反思演化 |
| 群话题 | 其他群最近在聊什么（脱敏） | 跨群 |
| 会话历史 | 逐字原文，可 `recall` 检索 | 单会话 |

### 主动行为

| 类型 | 频率 |
|---|---|
| 热点分享 | 每 1–2 小时随机 |
| 每日简讯 | 每天 9:00（含聊天统计） |
| 说说 | 每天 0–3 条 |
| 热群插话 | 群很热闹但很久没叫她 |
| 冷群找话题 | 6 小时没人说话 |
| 早上补回 | 昨晚错过的消息统一回一次 |

### 管理指令（仅 owner 私聊）

自然语言即可，不需要斜杠：

```
帮助                  → 列出全部功能
状态                  → 在线情况、今日消息数、token 用量
闭嘴 / 安静半小时       → 临时静音；「恢复说话」解除
停下                  → 打断正在跑的回合
用 low / 切到 high     → 换思考档位
在 123456789 群说一句 xxx  → 代发一句（不带 @）
去 123456789 @ 100000001   → 去群里找这个人搭话
记住，我在上海          → 写进长期事实
退群 123456789          → 退出某个群（记忆保留）
同意 / 拒绝             → 回复别人的入群邀请
你都记得我什么          → 列出她记住的关于你的事
别主动了 / 可以主动了    → 主动行为总开关
限流改成每分钟 10 条     → 改配置并持久化
以后叫我老大            → 设置称呼
```

---

## 稳定性

### 掉线自动恢复

QQ 掉线是常态（`KickedOffLine`）。项目自带一个看门狗，每 2 分钟检查一次：

```
3001 不通超过 2 分钟
  ├─ 最近 6 分钟在等扫码？ → 不动，避免打断你
  ├─ 否则 → 自动 systemctl restart napcat（走快速登录）
  │    ├─ 恢复 → 记录「自动恢复成功」
  │    └─ 失败 → 记录「票据失效，需要扫码」
  └─ 每小时最多重启 2 次
```

安装：

```bash
sudo bash scripts/install-watchdog.sh
```

### 掉线邮件告警（可选，⚠️ 未实测）

看门狗支持配置邮箱，掉线超过 3 分钟时发一封告警（12 小时内不重复）。

配置 `~/.dsh/onebot-bridge/mail.json`：

```json
{
  "host": "smtp.qq.com",
  "port": 465,
  "user": "你的QQ邮箱@qq.com",
  "pass": "SMTP授权码（不是登录密码）",
  "to": "接收告警的邮箱@qq.com"
}
```

> ⚠️ **这个功能没有经过实际发送验证**——开发环境没有可用的 SMTP 授权码。
> 代码路径（`smtplib.SMTP_SSL` + QQ 邮箱 465）是完整的，但第一次启用时
> 请手动跑一次 `python3 scripts/watchdog.py` 并看 `alert.log`，确认能收到信。
>
> QQ 邮箱授权码获取：邮箱设置 → 账户 → 开启 SMTP 服务 → 生成授权码。
> 新注册的 QQ 邮箱可能需要等 14 天才能开启。配好之后，掉线时你会收到：

```
主题：[QQ 机器人] 掉线提醒
正文：NapCat 的 OneBot 端口 3001 已连续不通 N 分钟。
      自动恢复已尝试过，若仍不通大概率需要重新扫码。
      二维码：~/Napcat/.../qrcode.png
```

---

## 常见问题

### Q：为什么不回复我的私聊？

1. 你不在白名单里（`allowUsers` 非空时）
2. **你不是它的好友**，消息被 QQ 拦截
3. 它正在静音（说「恢复说话」解除）

### Q：为什么老是掉线？

QQ 对第三方协议端有登录态限制：

- 同一账号在手机登录会把机器人踢下线（`KickedOffLine`）
- 长时间无操作、异地 IP 变化也会触发
- 新设备首日最容易触发

对策：

- 扫码时勾「快速登录」
- 不要频繁在手机上登录同一账号
- 项目自带看门狗，掉线会自动重启尝试快速登录

### Q：表情包发不出去？

检查 `~/.dsh/onebot-bridge/stickers/` 是否有图、`labels.json` 是否存在。
日志里搜 `请指定正确的 group_id` 通常说明发送目标丢了。

### Q：会话越来越长会怎样？

不会丢。原文永远在 `session.jsonl.zstd` 里，
超过 50MB 才自动压缩，压缩后仍可用 `recall` 检索。

---

## 配置项

**完整字段、填写规则、验证方法见 [DEPLOY.md §6](DEPLOY.md)。** 这里只列最关键的：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `selfId` | ✅ | `0` | 机器人的 QQ 号 |
| `ownerId` | ✅ | `0` | 你的 QQ 号（管理员） |
| `token` | ✅ | — | 与 NapCat `onebot11` 配置一致 |
| `prewarmGroups` | — | `[]` | 想让机器人常驻的群号 |
| `DEEPSEEK_API_KEY` | ✅ | — | **只能放环境变量**，不进文件 |

常用可调项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `ratePerMinute` | `6` | 每会话每分钟最多回几条 |
| `ratePerUserHour` | `30` | 每人每小时上限 |
| `followUpSeconds` | `60` | 续聊窗口时长 |
| `followUpMaxTurns` | `5` | 一次对话最多接几轮 |
| `turnTimeoutMs` | `25000` | 单回合软超时 |
| `proactiveChance` | `0.45` | 主动分享概率 |
| `nightStart` / `nightEnd` | `1` / `6` | 最沉默时段 |
| `qzonePerDayMax` | `3` | 每天最多发几条说说 |
| `tokenDailyAlert` | `5000000` | 当日 token 超多少提醒 |
| `autoConfigurePlugins` | `true` | 新会话自动接入配套插件 |

---

## 致谢与引用

### 运行依赖

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — MIT
  Agent 运行时与插件框架。本项目以 Cordis 插件形式挂载。
- **[NapCat](https://github.com/NapNeko/NapCatQQ)** — Limited Redistribution License
  QQ 协议端，提供 OneBot 11 接口。**本项目不分发 NapCat 的任何代码**，
  用户需自行安装并遵守其许可（禁止商业用途）。
- **[OneBot 11](https://github.com/botuniverse/onebot-11)** — 通信协议标准。

### 设计参考

- **[dsh-qq-bridge](https://github.com/xiaomengxinbb/dsh-qq-bridge)**（Apache-2.0）
  其 `HOST-API.md` 对 DSH agent API（`create`/`resume`、`followup`/`whenIdle`、
  initiator scope）的梳理，是本项目桥接层的重要参考。
- **[pi-qq-bridge](https://github.com/xiaomengxinbb/pi-qq-bridge)**（Apache-2.0）
  上述项目的上游。

### 配套插件（推荐必备）

以下插件提供记忆、主动搭话、朗读、B 站、心情能力，
`bash scripts/install-plugins.sh` 会一并安装：

| 插件 | 作用 | 许可证 |
|---|---|---|
| [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) | 会淡忘的长期记忆 | MIT |
| [dsh-speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up) | 主动搭话（没人在时自己开口） | MIT |
| [dsh-tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge) | 浏览器端朗读 | MIT |
| [dsh-bili-subagent](https://github.com/Yuuyuko-uu/dsh-bili-subagent) | B 站内容子 agent | 见仓库 |
| [dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) | 心情（影响语气底色） | 见仓库 |

> 不装也不会报错——桥会检测不到这些服务，相应能力自动降级。

### 表情包

`assets/stickers/` 中的图片来自社区图库
[aigengtu.com](https://aigengtu.com) 的「大肥鱼 / 鲸鱼娘」系列，
版权归原作者及社区贡献者所有，本项目仅作**非商业性**收录。

如原作者认为不妥，提 issue 即可移除。

---

## 许可

MIT。见 [LICENSE](LICENSE)。

> 本项目仅提供 QQ 与 DeepSeek Harness 之间的桥接实现。
> 使用需要自行安装 NapCat，并遵守其非商业许可。
> 请勿将本项目用于任何商业用途。
