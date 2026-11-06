// 审计日志与日报统计。
import { readFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "./logger.js";

const HOME = process.env.HOME || homedir();

function ymdOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function summarizeDay(dateStr) {
  try {
    const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
    const recs = [];
    for (const line of lines) {
      if (!line.includes(dateStr)) continue;
      try {
        const r = JSON.parse(line);
        if (String(r.ts).startsWith(dateStr)) recs.push(r);
      } catch {
        // 跳过坏行
      }
    }
    const inbound = recs.filter((r) => r.kind === "inbound");
    const replies = recs.filter((r) => r.kind === "reply");
    const usage = recs.filter((r) => r.kind === "usage");
    const proactive = recs.filter((r) => r.kind === "proactive" || r.kind === "relay" || r.kind === "daily_brief");
    const limited = recs.filter((r) => r.kind === "rate_limited");
    const byHour = {};
    for (const r of inbound) {
      const h = String(new Date(r.ts).getHours()).padStart(2, "0");
      byHour[h] = (byHour[h] ?? 0) + 1;
    }
    const byKey = {};
    for (const r of inbound) byKey[r.key] = (byKey[r.key] ?? 0) + 1;
    const sum = (k) => usage.reduce((a, b) => a + Number(b[k] ?? 0), 0);
    return {
      date: dateStr,
      inbound: inbound.length,
      replies: replies.length,
      proactive: proactive.length,
      limited: limited.length,
      turns: usage.length,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      totalTokens: sum("totalTokens"),
      byHour,
      byKey,
    };
  } catch {
    return null;
  }
}

function renderStats(st) {
  if (!st) return "";
  const peak = Object.entries(st.byHour).sort((a, b) => b[1] - a[1])[0];
  const keys = Object.entries(st.byKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k.replace("group:", "群").replace("private:", "私聊")} ${v} 条`);
  const tok = st.totalTokens >= 10000
    ? `${(st.totalTokens / 10000).toFixed(1)} 万`
    : String(st.totalTokens);
  const bits = [
    `昨天一共聊了 ${st.inbound} 条，我回了 ${st.replies} 条`,
    keys.length ? `主要来自 ${keys.join("、")}` : "",
    peak ? `最热闹是 ${peak[0]}:00 前后（${peak[1]} 条）` : "",
    st.proactive ? `我自己主动开口 ${st.proactive} 次` : "",
    st.turns ? `模型调用 ${st.turns} 轮、约 ${tok} tokens` : "",
    st.limited ? `被限流 ${st.limited} 次` : "",
  ].filter(Boolean);
  return bits.join("；") + "。";
}

const AUDIT_PATH = join(HOME, ".dsh/onebot-bridge/audit.log");

let auditEnabled = true;

function audit(rec) {
  if (!auditEnabled) return;
  try {
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch {
    // 审计写失败不影响对话
  }
}

function rotateAudit() {
  try {
    const st = statSync(AUDIT_PATH);
    if (st.size > 5 * 1024 * 1024) {
      renameSync(AUDIT_PATH, AUDIT_PATH + ".1");
    }
  } catch {
    // 文件不存在就算了
  }
}

export { HOME, ymdOffset, summarizeDay, renderStats, AUDIT_PATH, auditEnabled, audit, rotateAudit };

/** 动态开关审计（配置热更新用） */
export function setAuditEnabled(v) {
  auditEnabled = !!v;
}
