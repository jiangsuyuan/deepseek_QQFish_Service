# 开发约定

这个文件写给以后维护它的人（或 AI）。项目本身是一个人 + 一个 AI 在维护，所以约定尽量少、尽量机械。

## 提交节奏

**每次修改确认无误后立即提交，不要攒。**

一次提交 = 一个可描述的变化。改完的东西如果还躺在工作区没提交，下次改别的就会混在一起。

判断"确认无误"的标准：

1. `node --check index.js` 通过
2. 服务能起来（`systemctl restart dsh-web` 后日志出现 `已连接`）
3. 改动的功能实际跑过一次（至少看日志确认走到了）
4. 没有引入运行时错误（`journalctl -u dsh-web --since "2 min ago" | grep -i 失败`）

## 每次提交必须更新 CHANGELOG

**这是硬要求。** 提交里没有 `CHANGELOG.md` 的改动，等于没写文档。

格式：

```markdown
## 1.x.y · YYYY-MM-DD

一两句说这版在解决什么问题。

### 新增
- 功能点：一句话说清它能干什么，附上关键参数/阈值

### 改进
- 改了什么、从多少变成多少、为什么

### 修复
- 症状 + 根因（不要只写"修复了 bug"）

### 升级注意
- 需要改配置的地方、行为变化、兼容性问题
```

写的时候注意：

- **写"为什么"**，不要只写"改了什么"。三个月后看到"调整了延迟"会一脸问号。
- **带上数字**。`句号密度从 105/百条降到 30` 比 `优化了标点` 有用得多。
- **修复类写根因**。`logger is not defined` 这种，要写清是"类方法里用了外层变量"。

## 版本号

语义化版本，但宽松执行：

| 变化 | 版本 |
|---|---|
| 加功能、改行为 | 次版本 +1（1.1.x → 1.2.0） |
| 只修 bug / 只调参数 | 修订号 +1（1.1.2 → 1.1.3） |
| 破坏性变化（配置不兼容） | 主版本 +1 |

`package.json` 里的版本和 CHANGELOG 的标题必须一致。

## 发布前必做：隐私清洗

服务器上跑的代码含有真实群号、QQ 号、机器人昵称。**同步到发布仓库前必须清洗**：

```powershell
# 群号 → 占位
$t = $t.Replace('943851627', '123456789')
# 昵称 → 通用
$t = $t.Replace('(竹筒肥鱼|肥鱼|大鱼|鱼鱼)', '(肥鱼|大鱼|鱼鱼)')
# 注释里的昵称
$t = $t.Replace('「@竹筒肥鱼」', '「@昵称」')
```

清洗后扫描一次，确认零命中：

```powershell
Select-String -Path index.js -Pattern '真实群号|真实QQ号|机器人昵称|服务器IP|token'
```

另外注意：**PowerShell 的 `Set-Content -Encoding UTF8` 会加 BOM**，用 `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))` 写。

## 改代码时容易踩的坑

按踩坑频率排序，都是这个项目里真实踩过的：

### 1. 作用域（最常见的运行时崩溃）

`logger` / `cfg` / `client` / `sessions` 都在 `apply()` 里定义。**`OneBotClient` 类的方法访问不到它们**，必须用 `this.logger`、`this.cfg`。

`node --check` 查不出这类问题，只能在运行时崩。往类里加代码后，搜一遍裸变量名。

### 2. 消息处理有两条路径

```
主流程（被 @ / 续聊）→ allowed() 之后
旁听分支           → allowed() 之前，通常直接 return
```

想加"旁听时也做点什么"的功能，代码要放在**旁听分支里**（`allowed()` 之前）。放错位置的表现是：功能永远不触发（因为旁听消息在到达前就 return 了）。

### 3. 时间戳有两种

- `Date.now()`：收到消息的时间
- `Number(ev.time) * 1000`：消息实际发生的时间

NapCat 补推离线消息时，两者能差几小时。**做"多久没说话""活跃度"这类判断必须用消息时间**，否则补推的旧消息会被当成刚发生。

### 4. 去重有三层

| 层 | 作用 | 存哪 |
|---|---|---|
| `recentIds` | 短时间重复进 | 内存 |
| `seen.ids` | 已回复 | `seen.json` |
| `processingIds` | 并发 | 内存 |

**绕开正常流程直接回消息的地方（比如指令处理）必须手动 `markSeen`**，否则补回复机制会把同一条指令反复执行。

### 5. 空 content 会污染会话

`user.message.content` 是空数组时 API 返回 400，而且这条空消息会留在 session 文件里，**之后每次请求都 400**，重建 agent 也没用（session 文件还在）。

发消息前确保 content 非空。

## 测试

改完手动验一遍就行，重点是看日志：

```bash
# 服务状态
systemctl is-active dsh-web napcat

# 连接
journalctl -u dsh-web --since "2 min ago" | grep "已连接"

# 报错
journalctl -u dsh-web --since "5 min ago" | grep -iE "失败|error|not defined"

# 掉线记录
tail -20 ~/.dsh/onebot-bridge/alert.log
```

## 备份

改 `napcat.mjs` 前一定备份（升级会覆盖）：

```bash
cp napcat.mjs napcat.mjs.bak-$(date +%m%d)
```

`index.js` 的大改也建议留一份：

```bash
cp index.js index.js.bak-$(date +%m%d-%H%M)
```
