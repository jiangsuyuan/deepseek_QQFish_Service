import { AUDIT_PATH, audit } from "../core/audit.js";
import { readFileSync } from "node:fs";
// 帮助与创造者指令的说明文本。

function renderRecall(hits) {
    if (!hits?.length) return "";
    const lines = hits.map((h) => {
      const d = h.at ? new Date(h.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      const who = h.role ? `${h.role}：` : "";
      return `· [${d}] ${who}${h.text}`;
    });
    return `[你回忆起的事]\n${lines.join("\n")}\n\n`;
  }

function helpText() {
    return [
      "【聊天】",
      "· 私聊随意；群里 @ 我 / 打「@昵称」必回",
      "· 只叫「肥鱼」「大鱼」→ 叫我必回；闲聊提到我 70% 接",
      "· 聊过一次后 1 分钟免 @ 续聊（≤5 轮）；10 秒内换人接手会先判断新旧目标",
      "· 懂图、看链接、展转发；情绪到了只发表情 / 小黄脸",
      "· 表情包列表 / 看表情 12 → 看库、看单张",
      "· 被难堪到底 → 声明不再理他，之后一段时间他 @ 也不回",
      "",
      "【记忆与查询】",
      "· 昨天状态 / 前天状态 / 状态 10-24 / 最近三天 → 历史数据",
      "· 印象深刻的人 / 对他们的印象",
      "· 你对 123456789 的印象 → 单人档案",
      "· 各个群的印象 → 这群干什么的、常聊什么、都是什么人、说话风格、氛围，熟的人排在最后",
      "· 群 123456789 你记得谁 / 你对群 123456789 的印象",
      "· 你都记得我什么",
      "· 你现在是什么样 → 性格、风格、记忆存量、自省",
      "· 全部想法 / 全部自省 → 完整清单（分条，不截断）",
      "· 事实、观点、反思一直累积，不冲掉旧的；她可自行改写或删除",
      "",
      "【她自己会做】",
      "· 热点：每 1–2 小时看心情说一句；每日 9 点简讯",
      "· 说说：120–240 分钟问一次要不要发，0–2 条/天，全看她心情",
      "· 内省每小时；反思 22 点；日记 23 点",
      "· 热群插话：≥2 条/分、我 10 分钟没参与、90 分钟没插过 → 可能插一句",
      "· 冷群找话题：2 小时没人说话才抛一次（每群每天 1 次）",
      "· 连发搭话：连发 3 条纯文字、等 30 分钟没人接 → 搭一句（每群每天 ≤2）",
      "· 好友申请：先私聊问你要不要通过",
      "· 风控模式（默认）：2 条/分、每人 8 次/时、先等 2 秒、合并回复、23–7 点静默",
      "",
      "【你可以直接对我说】",
      "· 状态 / 统计 / 发言统计 / 各群活跃 / 掉线记录 / 最近错误 / 插件状态",
      "· 闭嘴 / 安静半小时 → 静音；恢复说话 解除",
      "· 停下 → 打断回合｜用 low / 切到 high → 思考档位",
      "· 在 123456789 群说一句 xxx → 代你发（不带 @）",
      "· 去 123456789 @ 100000001 → 找某人搭话（一次）",
      "· 记住，我在上海 → 写进长期事实｜以后叫我创造者 → 改称呼",
      "· 退群 123456789 → 退出（记忆保留）",
      "· 同意 / 拒绝 → 入群邀请；同意好友 / 拒绝好友 → 好友申请",
      "· 提醒我 明天9点 交周报；查看提醒 / 取消提醒",
      "· 风控模式 开/关 → 切换慢节奏 / 原节奏",
      "· 发条说说 / 发条说说：事情 → 她用自己的口吻发",
      "· 帮助 → 这张表",
      "",
      "【群里的规矩】",
      "· 只认 @、名字、续聊；风控 2 条/分、8 次/时；普通 6 条/分、30 次/时",
      "· 别人让我跑服务器命令一律拒，只有你能放行",
      "· 只有社交工具（表情/画图/新闻/搜网页/记事），无服务器权限",
      "· 搜网页 8 次/时；AI 画图 2 次/时；SVG 不限；存表情 3 张/时，库 300 张 / 30MB",

    ].join("\n");
  }

async function handleOwnerNatural(ev, text) {
  // 所有指令都交给 agent——她理解你的话，自己调工具（set_config /
  // manage_group / handle_request / set_nickname ...）。
  // 这里保留空壳，因为调用处还在检查返回值。
  // 原来的 30+ 个正则分支（静音/风控开关/主动开关/改称呼/加群/频率/字数...）
  // 已全部删掉，功能由工具替代。
  return false;
}

function recentDialog(limit = 12) {
    try {
      const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const recs = [];
      for (const line of lines) {
        if (!line.includes(ymd)) continue;
        try {
          const r = JSON.parse(line);
          if (r.kind === "inbound" || r.kind === "reply") recs.push(r);
        } catch {
          // 忽略
        }
      }
      return recs
        .slice(-limit)
        .map((r) => (r.kind === "inbound" ? `对方：${r.text}` : `我：${r.text}`))
        .join("\n");
    } catch {
      return "";
    }
  }

export { renderRecall, helpText, handleOwnerNatural, recentDialog };
