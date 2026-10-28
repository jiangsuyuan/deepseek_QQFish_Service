# deepseek_QQFish_Service

把 **DeepSeek Harness** 接到 **QQ** 里的桥。

基于 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 连接 QQ，
让 DSH 的 Agent 能在私聊和群里说话——并且带记忆、有作息、会主动找你。

> 本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个 Cordis 插件，
> 不是独立程序。你需要先有 DSH 和 NapCat。

> 🔧 **好友申请需要额外打一个 NapCat 补丁**：NapCat 没把「联系人-好友通知」暴露成 OneBot 接口，
> 桥查不到谁申请加好友。运行 `sudo python3 scripts/patch-napcat-buddy.py` 后重启 NapCat 即可，
> 之后好友申请会私聊转告你，回「同意好友」就通过。不打补丁也能用，只是收不到好友申请通知。

> 🛠 **开发约定**：[DEVELOPMENT.md](DEVELOPMENT.md)（提交节奏、CHANGELOG 要求、发布前隐私清洗、这个项目踩过的坑）

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
- 群里聊过一次后，**1 分钟内不用 @ 也能接着聊**（最多 5 轮；风控模式下窗口为 20 秒）
- **换目标判断**：她刚回完 A 的 10 秒内，B 没 @ 也开口了 → 先让模型判断「A 是不是已经不再跟她说」和「B 这句是不是冲她说」，两条都成立才转向 B；A 的窗口只是被插话时保持原样
- 支持**图片理解**（DeepSeek 视觉）
- 发链接会**扫一眼正文前 600 字**
- 自定义表情库（带情绪标签，可自己攒；目前 75 张）、QQ 原生小黄脸、分条发送、正在输入
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
| `revise_self` / `forget_self` | 反思后改写 / 删掉某条旧想法 |
| `save_sticker` / `list_stickers` | 收藏表情 / 列出表情库 |
| `send_face` | 发一个 QQ 原生小黄脸 |
| `refuse_person` | 声明不再回复某人（之后他 @ 也不接） |
| `draw_image` / `draw_svg` | AI 画图 / 画 SVG |

### 记忆

**五层结构**，外加一张记忆网络：

| 层 | 内容 | 文件 | 每轮注入 |
|---|---|---|---|
| **L0 自我认知** | 「我是什么样的」「我觉得我是什么样的」「在别人眼里我好像是什么样的」+ 心里没摆平的事 | `self-model.json` | ✅ 最先 |
| **L1 工作记忆** | 当前对话 | session | ✅ 压缩后 |
| **L2 近期摘要** | 每 20 条记忆压成 150-200 字的「这几天我经历了什么」 | `digest.json` | ✅ |
| **L3 核心自我** | 带类型：`belief` 认定的事 / `care` 在意的 / `want` 想做的 / `change` 变化 | `core.json` | ✅ |
| **L4 长期日志** | 所有活动和聊天的统一记录 | `memory-log.jsonl` | 按需 |
| **L5 专项** | 探险日志 / 书单 / 游戏 / 需求本 | `explore-log.jsonl` 等 | 按需 |

**记忆网络**（`memory-net.json`）：每条记忆是节点，自动连横向边（同主题 / 同一人 / 同期），每节点最多 5 条边。检索时从 2-6 个入口并行游走，最深 10 跳、每跳权重 ×0.82 衰减——「想起来」有时很近、有时很远。

L0 的自我认知**随反思微调**：最短 48 小时改一次，只改有变化的句子（“你不该每天换一个人”），每次改动记进 `self-history.jsonl`，能看到她怎么一点点变。

### 自主活动（她自己的时间）

每轮是**三段式**：思考 → 行动 → 反思。

| 阶段 | 她做什么 |
|---|---|
| **思考** | 拿到六层记忆索引，可以先调工具查任意一层，再决定「这会儿想做什么、为什么、什么心情」 |
| **行动** | 带着结论去做 |
| **反思** | 做得怎样 + **我做这件事的方式有没有问题**（浅尝辄止？绕开难点？只搜一个词就下结论？）+ **缺什么**（缺就 `note_want` 记下来）+ **下次什么时候再来** |

七种活动：

| 活动 | 留下什么 |
|---|---|
| 探险 | `learnings.json` + `explore-log.jsonl`（含「每一步为什么往那儿走」） |
| 读书 | `readings.jsonl`（书单可累积，下次接着读） |
| 玩 | `games.jsonl`（造的小游戏可累积） |
| 思考 | 观点（`self.json`） |
| 写点什么 | 随笔（`activities.jsonl`） |
| 回忆 | 新的理解（`facts.json` / `people.json`） |
| 憧憬未来 | 愿望（`activities.jsonl` + 需求本） |

**休息多久由反思决定**：她写 `[[next: 20m]]` / `2h` / `明天早上`，范围 1 分钟到 8 小时。

### 主动行为

| 类型 | 频率 |
|---|---|
| 热点分享 | 每 3–5 小时随机（风控模式）|
| 每日简讯 | 每天 9:00（含聊天统计） |
| 说说 | 每 2–4 小时问一次要不要发，0–2 条/天（风控）；全看她心情 |
| 热群插话 | ≥2 条/分、她 10 分钟没被叫、90 分钟没插过 → 可能插一句 |
| 冷群找话题 | 6 小时没人说话才抛一次（每群每天 1 次；23–7 点不做）|
| 早上补回 | 昨晚错过的消息统一回一次 |
| 连发搭话 | 连发 3 条纯文字、等 60 分钟没人理 → 搭一句（每群每天 ≤2）|

**时段**：对外发言 9–23 点；她自己想事是 24 小时（内部活动不打扰任何人）。

### 记忆工具

| 工具 | 用途 |
|---|---|
| `recall` | 搜历史对话原文，返回结果标注「对方」/「我」，`only_user` 只搜对方原话 |
| `my_memory` | 按 people / facts / views / reflections / learnings 分类查 |
| `my_digest` | 这几天的经历摘要 |
| `memory_index` | 记忆目录（按主题 / 按天） |
| `person_dossier` | 某人档案 + 共同群 + 他在各群说过什么 |
| `group_recap` | 某群最近话题 |
| `who_said` | 跨群搜某个词是谁说的 |
| `my_adventures` | 探险行程（含每步为什么） |
| `my_status` | 在线时长、掉线次数、今日回复数、记忆存量、最熟的 5 个人 |
| `note_want` / `my_wants` | 需求记事本：想要什么随手记，主人有空处理 |
| `my_changelog` / `my_source` | 看她自己的更新日志和源码片段 |

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
发条说说 / 发条说说：今天下雨了 → 她用自己的口吻写一条（会拦“原样复述”）
全部想法 / 全部自省      → 完整清单（分条发，不截断）
风控模式 开 / 关        → 慢节奏（默认）/ 原节奏
昨天状态 / 状态 10-24 / 最近三天 → 历史报表
各个群的印象            → 每个群的最后活跃、话题、熟人
表情包列表 / 看表情 3   → 表情库清单 / 看单张
需求清单 / 给她 1 / 算了 2 → 处理她的需求记事本
活动一下               → 让她立刻跑一轮（自己决定做什么）
去探险 / 读点书 / 玩会儿 / 想想事 → 指定做什么
连做 5 轮              → 连续跑 5 轮
```

---

### 风控模式（默认开启）

QQ 对第三方协议端有风控，「说话像人」比「说得多」重要。风控模式是默认档，用「风控模式 开 / 关」随时切回原节奏：

| 维度 | 普通模式 | 风控模式（默认） |
|---|---|---|
| 每会话每分钟 | 6 条 | **2 条** |
| 每人每小时 | 30 次 | **8 次** |
| 首条延迟 | 0.15–2 秒 | **约 2 秒 + 拥堵加长**（最多 +6 秒）|
| 最小发送间隔 | 无 | **1.2 秒** |
| 群聊合并 | 不合并 | **2 秒窗口合并**，不同人一起回一次 |
| 续聊窗口 | 180 秒 | **20 秒** |
| 夜间 | 1–6 点静默 | **23–7 点不主动开口** |
| 说说 | 0–3 条/天 | **0–2 条/天** |

拥堵时会按「最近 30 秒已发条数」动态拉长延迟，把发送曲线摊平，避免短时间内跨群连发。

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
超过 5MB 才自动压缩，**原文仍留在会话文件里**，`recall` 检索得到。

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
| `followUpSeconds` | `180`（风控 20） | 续聊窗口时长 |
| `followUpMaxTurns` | `5` | 一次对话最多接几轮 |
| `turnTimeoutMs` | `25000` | 单回合软超时 |
| `proactiveChance` | `0.45` | 主动分享概率 |
| `nightStart` / `nightEnd` | `23` / `7` | 静默时段 |
| `qzonePerDayMax` | `3`（风控 2） | 每天最多发几条说说 |
| `tokenDailyAlert` | `5000000` | 当日 token 超多少提醒 |
| `autoConfigurePlugins` | `true` | 新会话自动接入配套插件 |
| `riskMode` | `true` | 风控模式总开关 |
| `switchTargetEnabled` | `true` | 续聊「换目标」两步判断 |
| `compactThresholdMB` | `5` | 会话文件超过多少 MB 自动压缩（原文仍在，`recall` 可查） |
| `searchPerHour` | `0` | 每小时搜索上限，`0` = 不限 |

**自主活动**（她自己的时间）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `selfActivityEnabled` | `true` | 总开关 |
| `selfActivityPerDay` | `20` | 每天最多几轮 |
| `selfActivityChance` | `0.5` | 每轮检查时的概率 |
| `selfActivityStartHour` / `EndHour` | `0` / `24` | 活动时段（0-24 = 全天） |
| `autoExploreChance` | `0.35` | 单独触发探险时的概率 |
| `autoExploreMinGapMinutes` | `45` | 两次探险最短间隔 |
| `memoryWalkChance` | `0.7` | 每次回复时记忆游走的概率（其余时候不深想） |
| `digestEvery` | `20` | 攒够多少条记忆生成一次摘要 |
| `selfModelMinGapHours` | `48` | 自我认知最短多久调整一次 |

**时段**：`activeStartHour` / `activeEndHour` 管对外发言（默认 9-23），`selfActivityStartHour` / `EndHour` 管内部活动（默认 0-24）。

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
