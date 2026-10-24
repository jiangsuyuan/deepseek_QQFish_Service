# DEPLOY.md — 部署清单（给人或 AI 执行）

> 这份文档是**可执行的部署步骤**，每一步都有验证命令和预期输出。
> 如果你是 AI agent 在执行部署：**不要跳过验证**，某步验证失败就停下来排查，不要假设它成功。

---

## 0. 目标形态

```
Linux 服务器
├── Node 24 + pnpm + DSH CLI
├── ~/.dsh/profiles/web        DSH profile（含桥 + 配套插件）
├── ~/Napcat                   NapCat（QQ 协议端）
└── systemd: dsh-web / napcat / qq-watchdog

你的电脑
└── SSH 隧道 + 浏览器（只用来配置和查看）
```

**不要在本地电脑部署。** 机器人需要 24 小时在线。

---

## 1. 前置检查

逐条执行，全部通过再往下。

```bash
uname -m                      # 期望 x86_64
ldd --version | head -1       # 期望 glibc >= 2.28
free -m                       # 期望 Mem total >= 1800
df -h /                       # 期望 Avail >= 8G
id -u                         # 期望 0（root）
curl -sI https://api.deepseek.com | head -1   # 期望 200/401/403 均可（能连通）
```

| 检查 | 不通过怎么办 |
|---|---|
| 非 x86_64 | 换机器 |
| glibc < 2.28 | 换系统（CentOS 7 不行） |
| 内存 < 1800MB | 加内存或换规格 |
| 非 root | `sudo -i` |

---

## 2. 安装运行环境

```bash
bash scripts/install.sh
```

验证：

```bash
node -v        # 期望 v24.x
pnpm -v        # 期望 11.x
dsh --version  # 期望 0.2.x 或更高
```

> 若 `dsh` 命令找不到：`ln -sf /opt/node-v24*-linux-x64/bin/dsh /usr/local/bin/dsh`

---

## 3. 安装 NapCat

按官方文档：https://napneko.github.io

关键点：

```bash
napcat          # 交互式安装，选择 CLI 模式
```

验证：

```bash
ls ~/Napcat/opt/QQ/qq        # 期望存在
```

> 本项目**不分发** NapCat。必须从官方渠道获取，遵守其非商业许可。

---

## 4. 配置并登录 QQ

### 4.1 启动一次，扫码

```bash
systemctl start napcat
sleep 30
ls -l ~/Napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png
```

二维码通过 SSH 隧道拿到浏览器，或用 `scp` 下载后用手机 QQ 扫描。

**扫码时勾选「快速登录」**（否则每次重启都要重扫）。

验证：

```bash
ss -ltn | grep 6099          # 期望有监听
journalctl -u napcat -n 20 | grep -i "Server Started"
```

### 4.2 开启 OneBot WebSocket

找到配置文件：

```bash
ls ~/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/onebot11_*.json
```

把 `network.websocketServers` 改成：

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
      "token": "把这里替换成随机串",
      "enableForcePushEvent": true,
      "heartInterval": 30000
    }]
  }
}
```

生成 token：

```bash
openssl rand -hex 16
```

重启并验证：

```bash
systemctl restart napcat
sleep 30
ss -ltn | grep 3001          # 期望 127.0.0.1:3001
```

---

## 5. 安装 DSH 插件

### 5.1 桥本体

```bash
dsh plugin --profile web add /path/to/this/repo
```

验证：输出里应出现 `+ dsh-onebot-bridge`

### 5.2 配套插件

```bash
bash scripts/install-plugins.sh web
```

验证：输出里 5 个插件都应是 ✅。

> 失败也没关系（桥会降级），但建议重试。

### 5.3 检查装载顺序

```bash
dsh --profile web --dump-config 2>/dev/null | grep -E "onebot-bridge|fish-memory|speak-up|tts-bridge|feiyu-mood|bili"
```

期望能看到这些名字各出现一次。

---

## 6. 配置桥

```bash
mkdir -p ~/.dsh/onebot-bridge
cp config.example.json ~/.dsh/onebot-bridge/config.json
```

### 6.1 必填项（4 个）

| 字段 | 值从哪来 | 示例 |
|---|---|---|
| `selfId` | **机器人** QQ 号 | `100000001` |
| `ownerId` | **你的** QQ 号 | `200000002` |
| `token` | 第 4.2 步生成的随机串 | `a1b2c3...` |
| `prewarmGroups` | 想让机器人常驻的群号数组，可空 | `["123456789"]` |

编辑：

```bash
vi ~/.dsh/onebot-bridge/config.json
```

验证（用 python 读，避免手误）：

```bash
python3 -c "
import json
d=json.load(open('/root/.dsh/onebot-bridge/config.json'))
for k in ('selfId','ownerId','token'):
    v=d.get(k)
    print(k, '=', v, '✅' if v else '❌ 未填')
"
```

### 6.2 关键可调项（按需）

| 字段 | 默认 | 作用 | 什么时候改 |
|---|---|---|---|
| `ratePerMinute` | 6 | 每群每分钟最多回几条 | 群太吵就调小 |
| `ratePerUserHour` | 30 | 每人每小时上限 | 防刷 |
| `followUpSeconds` | 60 | 不 @ 也能接话的窗口 | 想更连贯调大 |
| `followUpMaxTurns` | 5 | 一次对话最多接几轮 | 防无限聊 |
| `turnTimeoutMs` | 25000 | 单回合超时 | 模型慢就调大 |
| `proactiveChance` | 0.45 | 主动分享概率 | 觉得吵调小 |
| `nightStart`/`nightEnd` | 1/6 | 最沉默时段 | 按作息改 |
| `qzonePerDayMax` | 3 | 每天说说条数 | 不想发就设 0 |
| `tokenDailyAlert` | 5000000 | 当日 token 提醒线 | 按预算改 |
| `stickerEnabled` | true | 表情包开关 | 没图就关 |
| `autoConfigurePlugins` | true | 新会话自动接入插件 | 想手动管理就关 |

### 6.3 密钥（只能放环境变量）

```bash
systemctl edit dsh-web
```

写入：

```ini
[Service]
Environment=DEEPSEEK_API_KEY=sk-你的key
```

验证：

```bash
systemctl show dsh-web -p Environment | grep -o 'DEEPSEEK_API_KEY=sk-[a-z0-9]*' | sed 's/\(sk-.\{6\}\).*/\1***/'
```

> 🔐 不要把 key 写进 `config.json`、`index.js`、README。
> 不要提交 `~/.dsh/` 下任何文件。

---

## 7. 启动与验证

```bash
systemctl restart dsh-web
sleep 30
```

### 7.1 服务层

```bash
systemctl is-active napcat dsh-web qq-watchdog.timer
```

期望三行 `active`。

### 7.2 桥层

```bash
journalctl -u dsh-web --since "2 min ago" | grep onebot
```

期望看到：

```
[onebot] 启动：ws=ws://127.0.0.1:3001 self=<你的号>
[onebot] 已连接 ws://127.0.0.1:3001
[onebot] 预热群会话 group:<群号> -> ob-xxxx-1
[onebot] 下次主动分享约 N 分钟后
[onebot] 每日简讯将在 ... 触发
```

### 7.3 插件层

```bash
tail -3 ~/.dsh/fish-memory-diag.log   # 期望 tick：agents=N（N 可能为 0）
ls ~/.dsh/feiyu-mood/state.json       # 期望存在
```

### 7.4 端到端（必须做）

1. **用你的 QQ 私聊机器人**，发 `帮助`
2. 期望收到功能清单

收不到就查：

```bash
journalctl -u dsh-web -f | grep onebot     # 有没有 ← private: 记录
journalctl -u napcat -f | grep 接收         # NapCat 有没有收到
```

| 现象 | 原因 |
|---|---|
| 两边都没日志 | 你不是好友 / 消息没发出 |
| NapCat 有、桥没有 | 桥没连上（查 3001 和 token） |
| 桥有 `←` 但无 `→` | 模型调用失败（查 API key） |

---

## 8. 配置配套插件

通常**自动完成**：新会话出现时桥会写进三个插件的配置。

手动补一次（换机器、换号后）：

```bash
bash scripts/configure-plugins.sh
```

验证：

```bash
python3 -c "
import json
for p in ('fish-memory-config.json','speak-up-config.json'):
    d=json.load(open('/root/.dsh/'+p))
    print(p, '->', d.get('sessions') or d.get('目标会话'))
"
```

---

## 9. 日常访问

本机执行：

```bash
ssh -N -L 3080:127.0.0.1:3080 -L 6099:127.0.0.1:6099 root@服务器IP
```

浏览器：

- `http://127.0.0.1:3080` — DSH（取 token：`journalctl -u dsh-web -n 50 | grep -o 'token=[A-Za-z0-9_-]*'`）
- `http://127.0.0.1:6099/webui` — NapCat 面板

---

## 10. AI 部署时的硬约束

如果你是 AI 在执行，以下规则不可违反：

1. **不要修改 `.gitignore` 里列出的文件**（配置、密钥、运行数据）
2. **不要把 `DEEPSEEK_API_KEY` 写进任何持久文件**，只放 systemd 环境变量
3. **每步都要验证**，不要假设命令成功；失败时读日志再决定下一步
4. **不要为了“一次跑通”而跳过 NapCat 扫码**——这是必须人工的一步
5. **不要改插件源码**——所有能力都通过配置实现
6. **改配置前先备份**：`cp config.json config.json.bak`
7. **重启 dsh-web 会中断正在处理的回合**（桥会自动补回来，但尽量在空闲时重启）

---

## 11. 已知限制

| 限制 | 说明 |
|---|---|
| QQ 登录态会失效 | `KickedOffLine` 是常态，扫码勾「快速登录」可自动恢复 |
| 快速登录票据可能失效 | 失效后必须人工扫码 |
| 图片理解依赖模型 | deepseek-flash 支持视觉，但会显著增加 token |
| 说说接口参数未验证 | `send_qzone_msg` 的 `content` 字段按 schema 推断 |
| 表情包版权 | 社区图，非商业使用 |
