# deepseek_QQFish_Service

把 **DeepSeek Harness** 接到 **QQ** 里的桥。

基于 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 连接 QQ，
让 DSH 的 Agent 能在私聊和群里说话——并且带记忆、有作息、会主动找你。

> 本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个 Cordis 插件，
> 不是独立程序。你需要先有 DSH 和 NapCat。

> 🔧 **好友申请需要额外打一个 NapCat 补丁**：NapCat 没把「联系人-好友通知」暴露成 OneBot 接口，
> 桥查不到谁申请加好友。运行 `sudo python3 scripts/patch-napcat-buddy.py` 后重启 NapCat 即可，
> 之后好友申请会私聊转告你，回「同意好友」就通过。不打补丁也能用，只是收不到好友申请通知。

> 🆕 **2.0.14（2026-11-06）**：群消息与私聊消息现在**结构化落盘**（`messages/*.jsonl`），
> 并新增 5 个读取工具（`read_message` / `read_context` / `read_thread` / `expand_forward` / `search_messages`）；
> 看图改为「先列出哪些位置有图，再按语境挑」。详见 [CHANGELOG](CHANGELOG.md) 与下方「消息存哪、怎么翻」。

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
- 支持**看图**：`look_image` 会先列出「哪些位置有图」（带前后文），按语境挑一张再看；长图自动竖切，一条多图可用 `imageIndex` 选第几张
- 发链接会**扫一眼正文前 600 字**
- 自定义表情库（带情绪标签，可自己攒；数量随收藏变化）、QQ 原生小黄脸、分条发送、正在输入
- 私聊连发几条会**合并成一次回复**；偶尔会连说 2–3 句

### 消息理解

| 类型 | 能力 |
|---|---|
| **合并转发** | 展开前 5 条 + 最多 2 张图；套娃转发再展开一层；想继续看用 `expand_forward`（支持 `from` / `count`，一次最多 20 条） |
| **引用转发** | 引用一条转发再 @ 她，自动追溯被引用的消息；用 `read_thread` 可以沿引用链往上追 |
| **“看上面的转发”** | 只 @ 不引用也行——往上翻 25 条找最近的转发 |
| **文本文件** | `.txt/.md/.log/.json/.csv` 等读前 1000 字（≤1MB）；非文本只提示文件名 |
| **图片** | 消息里的图会先进落盘记录；她要真看时用 `look_image`——不给 id 会先列出「哪些位置有图」，按语境挑 |
| **空 @** | 只 @ 不打字，会回看前面一段聊天记录，并直接点名「你 @ 之前最后一条 / 再上一条」，不问“怎么了” |
| **视频 / 语音 / 红包 / 卡片 / 位置** | 这些类型只保留占位（`［视频］［卡片］` 等），不解析内容，也不会因为认不出而崩 |

### 消息存哪、怎么翻

每条群消息和私聊消息都会写一条**结构化记录**（旁听也算，@ 不 @ 一视同仁），重启不丢：

```
~/.dsh/onebot-bridge/
├─ messages/<群号>.jsonl         # 群聊，一条一行
├─ messages/private/<QQ>.jsonl   # 私聊
├─ users/<QQ>.json               # 人物档案，一人一个文件
├─ groups/<群号>.json             # 群画像，一群一个文件
└─ （会话原文、附件仍在 ~/.dsh/sessions/、~/.dsh/attachments/）
```

一条记录大概长这样（有哪个字段才写哪个）：

```json
{"v":1,"k":"group:123456789","id":"1984189504","u":"100000001","n":"某人","t":1793898085,
 "x":"转发了","atMe":1,"ats":[{"qq":"100000001","name":"某某"}],
 "qid":"1601253466","img":[{"url":"https://…","file":"….jpg"}],
 "fw":{"id":"7704733609204261074","n":4},"unk":[{"t":"video","d":"…"}]}
```

- **保留**：单个文件超过 8MB 自动滚动，只留最近 1500 行；更早的在会话原文里
- **未知类型**：视频 / 语音 / 红包 / 卡片 / 位置等进 `unk` 原样保留，只渲染成 `［视频］［卡片］` 占位，不解析、也不会崩

**读的时候用这五个工具**（都读上面这份记录，QQ 掉线也能用）：

| 工具 | 用途 |
|---|---|
| `read_message({id})` | 一条消息的完整内容：谁说的、正文、@ 了谁、引用了谁（带被引用原文）、几张图、有没有转发 |
| `read_context({id?, before, after})` | 以某条为中心的前后若干条，每行带 `［图×N］［转发×N］↩︎` 标记和 `#消息id` |
| `read_thread({id, depth})` | 沿「回复/引用」往上追：A 引 B、B 引 C，一层层取 |
| `expand_forward({messageId, from, count})` | 展开合并转发，按条列出谁说了什么 |
| `search_messages({q, person, group, days})` | 跨群搜**旁听原文**（`recall` 只覆盖进过会话的消息） |

翻页统一用 `before=<id>`；返回体里带 `total / shown / hasMore / nextCursor`。

---

### 内置工具（部分）

**说话**

| 工具 | 作用 |
|---|---|
| `send_message` / `reply_to` / `send_private` | 发群消息 / 带引用回复 / 主动私聊 |
| `at_person` | 群里 @ 某人（每小时最多 3 次） |
| `send_sticker` / `list_stickers` / `save_sticker` | 发表情包 / 列表情库 / 收藏一张 |
| `send_face` | 发 QQ 原生小黄脸 |
| `draw_image` / `draw_svg` | AI 画图 / 画 SVG |

**看上下文**（2.0.14 新增）

| 工具 | 作用 |
|---|---|
| `read_message` / `read_context` / `read_thread` | 单条 / 前后窗口 / 引用链 |
| `expand_forward` | 展开合并转发 |
| `search_messages` | 跨群搜旁听原文 |
| `look_image` / `list_recent_images` | 看图：先列位置，再按语境挑；支持多图 `imageIndex`、长图切段 |
| `view_avatar` | 看某人头像 |

**看群**

| 工具 | 作用 |
|---|---|
| `group_activity` | 各群最近动静（按落盘记录真实计数） |
| `group_patrol` | 翻某群原文，支持 `before` 游标往前翻 |
| `group_recap` / `group_impressions` | 群摘要 / 她对每个群的印象 |
| `who_said` | 跨群搜「谁说过这话」 |
| `read_group_notice` | 看群公告 |
| `watch_topic` / `my_watchlist` | 订阅关键词或某人，出现就推给她 |

**记忆与自我**

| 工具 | 作用 |
|---|---|
| `recall` / `my_memory` / `memory_index` / `my_digest` | 翻原文 / 翻条目 / 记忆目录 / 经历摘要 |
| `person_dossier` | 某人档案 + 最近原话 |
| `remember_fact` / `remember_person` / `remember_self` / `revise_self` / `forget_self` | 记忆写入与修订 |
| `my_context` / `my_status` / `my_schedule` | 上下文用量 / 运行状态 / 下次活动 |
| `note_want` / `my_wants` | 需求记事本 |

**做事与自省**

| 工具 | 作用 |
|---|---|
| `run_activity` / `schedule_activity` | 立刻做一轮 / 排下次活动 |
| `hot_news` / `news_now` / `zhihu_daily` | 热搜等 |
| `exec_sandbox` / `read_page` / `read_pdf` / `files` | 跑代码 / 读网页 / 读 PDF / 文件区 |
| `propose_patch` / `my_patch_proposals` | 提代码改动申请（她改不了自己的代码） |
| `audit_self` / `my_thoughts` / `my_adventures` | 自省 / 想法 / 探险记录 |

> 完整清单以代码为准：`index.js` 里注册了 **90 个工具**。

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
| 回忆 | 新的理解（`facts.json` / `users/<QQ>.json`） |
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

2.0 之后，原来的三十多条正则指令**已经改成工具**：桥只拦四条硬指令，其余用自然语言说，她会自己调对应工具完成。

**桥会直接拦截（不走模型，立即生效）**

| 你说 | 效果 |
|---|---|
| `在 123456789 群说一句 xxx` | 代你在群里发一句（不带 @） |
| `去 123456789 @ 100000001` | 让她去群里找这个人搭一句话 |
| `记住，我在上海` | 写进长期事实（不经过模型） |
| `退群 123456789` | 退出某个群（记忆与档案保留） |
| `同意` / `拒绝` | 有待确认的入群邀请时，通过 / 拒绝 |

**其余直接说，她会用工具做**

| 你想要 | 直接说 | 她调用的工具 |
|---|---|---|
| 看她状态 | 状态 | `my_status` |
| 让她动一动 | 活动一下 / 去探险 / 读点书 | `run_activity` |
| 排下次活动 | 40 分钟后再读一会儿 | `schedule_activity` |
| 改设置 | 以后叫我老大 / 回复短一点 | `set_config` |
| 设提醒 | 提醒我明晚 8 点交周报 | `set_reminder` |
| 发说说 | 发条说说：今天下雨了 | `send_qzone` |
| 看需求本 / 处理 | 需求清单 / 给她 1 / 算了 2 | `my_wants` / `resolve_want` / `drop_want` |
| 看群印象 | 各个群的印象 | `group_impressions` |
| 表情库 | 表情包列表 / 看表情 3 | `list_stickers` |
| 查记忆 | 记忆查询 潮汐 | `my_memory` / `recall` |
| 加群 | 申请加群 123456789 | `manage_group` |
| 指令清单 | 帮助 | `owner_commands` |
| 好友申请 | 同意好友 / 拒绝好友 | `handle_request`（需先打 NapCat 补丁） |

> ⚠️ **旧版 README 里这些已经失效**（2.0 起改为工具层，桥不再拦截）：
> `闭嘴 / 恢复说话`、`停下`、`用 low / 切到 high`、`限流改成…`、`风控模式 开/关`、
> `昨天状态 / 状态 10-24 / 最近三天`、`连做 N 轮`、`重置活动额度`、`你都记得我什么`、`别主动了 / 可以主动了`。
>
> 这些说出口时她**可能**会用工具做到（比如「别主动了」→ `set_config`），但不保证；如果没反应，直接再要求一次或让她调具体工具。

---

### 风控模式（默认开启）

QQ 对第三方协议端有风控，「说话像人」比「说得多」重要。

**先说清楚一件事：按分钟/按小时的配额限流已经废弃了。** 老版本会数「每分钟回了几条」，超了就丢消息；
现在改成**打字节奏模型**——她像真人一样，先想一会儿，再按字数一个字一个字地"打"：

```
延迟 = 思考基础(1.5s) + 字数 × (0.45s/字 + 0.05s/字) + 随机抖动(0.3–1.2s)
     封顶 15 秒（再长也不等）
```

而且**全局单线程**：私聊和群聊共用一把打字锁，前一条打完才轮到下一条——不会出现"同时跨三个群刷屏"。

风控模式现在影响的是**行为频率**，不是"配额"：

| 维度 | 普通模式 | 风控模式（默认） |
|---|---|---|
| 续聊窗口（不 @ 也能接着聊） | 180 秒 | **20 秒** |
| 群聊合并 | 不合并 | **2 秒窗口合并**，不同人一起回一次 |
| 最小发送间隔 | 无 | **1.2 秒** |
| 一次最多拆几条 | 3 | **2** |
| 说说 | 0–3 条/天 | **0–2 条/天** |
| 主动分享间隔 | 60–120 分钟 | **180–300 分钟** |
| 热群插话冷却 | 30 分钟 | **90 分钟** |
| 连发搭话等待 | 30 分钟 | **60 分钟** |

> 夜间安静（1–8 点不主动开口）现在由 `dsh-speak-up` 插件控制，配置项在
> `~/.dsh/speak-up-config.json` 的 `安静起` / `安静止`，**不是**桥里的 `nightStart/nightEnd`
> （那两个字段已不再生效）。

> 同一套 `ratePerMinute` / `ratePerUserHour` 现在只出现在日志里，**不参与判断**——别再照着它调了。

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

### Q：她说看不到图片 / 只看到「[图片]」？

先让她调 `list_recent_images`——它会列出这个会话里**哪些位置有图**（谁发的、几分钟前、那条消息的文字、前后各一句），
挑一条再 `look_image({messageId:"…"})`。

常见原因：

1. 她查的那条消息本身没图，图在上一条 → 现在会直接告诉她「这条没图，附近有这些」
2. 图太大（单边 > 8192px）→ 长图会自动竖切，用 `part=2/3` 看下一段
3. 一条消息多张图 → 用 `imageIndex=2` 看第二张

### Q：转发她只回了「转发了」，里面内容没进来？

用 `expand_forward({messageId:"那条消息的id"})` 展开，会按条列出谁说了什么。
`read_message({id})` 也会提示「这条里有合并转发」。

### Q：会话越来越长会怎样？

不会丢。会话原文在 `session.jsonl.zstd` 里，超过 5MB 自动压缩，原文仍在，`recall` 检索得到；
群聊/私聊的每条消息另有一份结构化记录在 `messages/*.jsonl`（8MB 滚动），`read_context` / `search_messages` 查的是这一份。

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
| `ratePerMinute` | `6` | ⚠️ **已废弃**：只写日志，不参与判断（节奏由打字模型控制） |
| `ratePerUserHour` | `30` | ⚠️ **已废弃**：同上 |
| `followUpSeconds` | `180`（风控 20） | 续聊窗口时长 |
| `followUpMaxTurns` | `5` | 一次对话最多接几轮 |
| `turnTimeoutMs` | `25000` | 单回合软超时 |
| `proactiveChance` | `0.45` | 主动分享概率 |
| `nightStart` / `nightEnd` | `23` / `7` | ⚠️ **已废弃**：安静时段改由 `dsh-speak-up` 插件控制 |
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
