import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AUDIT_PATH, summarizeDay, audit } from "../core/audit.js";
import { SEND_STATE } from "../util/send-state.js";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

// 状态与统计文本。

export function createStats(ctx) {
  const { client, ensureGroupNames, groupLabel, sessions, state } = ctx;
  async function statusText(dateStr) {
      const cnt = await ensureCounts();
      const d = new Date();
      const ymd = dateStr || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayLabel = dateStr ? ymd.slice(5) : "今天";
      const st = summarizeDay(ymd) ?? {};
      const mins = Math.floor(process.uptime() / 60);
      const lines = [
        `在线：${client.connected ? "是" : "否"}`,
        `好友：${cnt.friends} 人｜群：${cnt.groups} 个`,
        `会话：${sessions.entries.size} 个`,
        `${dayLabel}：收到 ${st.inbound ?? 0} 条，回了 ${st.replies ?? 0} 条`,
        `用量：约 ${(((st.totalTokens ?? 0) / 10000) || 0).toFixed(1)} 万 tokens`,
        `限流：${st.limited ?? 0} 次；主动开口 ${st.proactive ?? 0} 次`,
        `已运行：${mins} 分钟`,
        "未静音",
      ];
      return lines.join("\n");
    }

  async function ensureCounts() {
      if (Date.now() - state.countsCache.at < 5 * 60000 && state.countsCache.at) return state.countsCache;
      try {
        const [fl, gl] = await Promise.all([
          client.call("get_friend_list", {}, 8000).catch(() => []),
          client.call("get_group_list", {}, 8000).catch(() => []),
        ]);
        const fArr = Array.isArray(fl) ? fl : (fl?.data ?? []);
        const gArr = Array.isArray(gl) ? gl : (gl?.data ?? []);
        state.countsCache = {
          at: Date.now(),
          friends: Array.isArray(fArr) ? fArr.length : 0,
          groups: Array.isArray(gArr) ? gArr.length : 0,
        };
      } catch {
        // 拿不到就用旧值
      }
      return state.countsCache;
    }

  async function statsText(dateStr) {
      await ensureGroupNames();
      const cnt = await ensureCounts();
      const d = new Date();
      const ymd = dateStr || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const byKind = {};
      const byGroup = new Map();
      try {
        const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          if (!line.includes(ymd)) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
          const g = String(r.key ?? "");
          if (g.startsWith("group:")) {
            const gid = g.slice(6);
            byGroup.set(gid, (byGroup.get(gid) ?? 0) + 1);
          }
        }
      } catch {
        // 读不到就算了
      }

      let drops = 0;
      let downMinutes = 0;
      let lastDrop = "";
      try {
        const lines = readFileSync(join(HOME, ".dsh/onebot-bridge/alert.log"), "utf8")
          .split("\n")
          .filter((l) => l.includes(ymd));
        for (const l of lines) {
          if (l.includes("检测到 3001 不通")) drops += 1;
          const m = l.match(/已恢复（掉线 (\d+) 分钟）/);
          if (m) downMinutes += Number(m[1]);
          if (l.includes("检测到")) lastDrop = l.slice(11, 16);
        }
      } catch {
        // 忽略
      }

      const st = summarizeDay(ymd) ?? {};
      const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      const top = (k) => byKind[k] ?? 0;

      return [
        dateStr ? `${ymd} 统计` : `今日统计（截至 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}）`,
        `好友：${cnt.friends} 人｜群：${cnt.groups} 个｜会话：${sessions.entries.size} 个`,
        `消息：收 ${st.inbound ?? 0} / 回 ${st.replies ?? 0}｜token 约 ${((st.totalTokens ?? 0) / 10000).toFixed(1)} 万`,
        `主动：分享 ${top("proactive")} / 简讯 ${top("daily_brief")} / 说说 ${top("qzone") + top("qzone_manual")} / 冷群 ${top("quiet_topic")} / 热群 ${top("active_join")}`,
        `工具：表情包 ${top("sticker")} / 新闻 ${top("news")} / @人 ${top("at_person")} / 补回复 ${top("catchup") + top("poll_mention")}`,
        `异常：错误 ${top("error")}｜掉线 ${drops} 次${drops ? `（累计 ${downMinutes} 分钟${lastDrop ? "，最近 " + lastDrop : ""}）` : ""}`,
        groups.length ? `各群：\n${groups.map(([g, n]) => `· ${groupLabel(g)}：${n} 条`).join("\n")}` : "",
        `节奏：单线程打字模型｜近 30 秒已发 ${SEND_STATE.recent.filter((x) => Date.now() - x < 30000).length} 条`,
        `限流：${st.limited ?? 0} 次`,
      ]
        .filter(Boolean)
        .join("\n");
    }

  return { ensureCounts, statusText, statsText };
}

export { HOME };
