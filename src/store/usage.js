// 上下文用量统计（只读，不改任何链路）。
//
// 数据来自 DSH 的两个只读服务：
//   ctx.tokenMeter.measure(session)              → 当前请求/表面压力
//   ctx.sessionProjections.stateOf(s, 'contextBreakdown') → system / tools / messages 构成
//
// 目的：量清楚「每次请求里工具定义占多少」——在拿到这个数字之前，任何
// 「精简工具」的优化都是猜的。
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_PATH = join(HOME, ".dsh/onebot-bridge/usage.jsonl");
const SAMPLE_MS = 5 * 60 * 1000;

export function createUsageStats(app) {
  const { ctx, sessions, logger } = app;
  const last = new Map(); // key -> 上次的 totalTokens
  let timer = null;

  /** 取一个会话的当前用量与构成；拿不到就返回 null（绝不抛） */
  function sampleOf(key) {
    const entry = sessions?.entries?.get?.(key);
    const session = entry?.handle?.agent?.session;
    if (!session) return null;
    let m = null;
    let b = null;
    // cordis 的服务不一定在 ctx 上直接可见，优先用 ctx.get
    const meter = ctx?.get?.("tokenMeter") ?? ctx?.tokenMeter ?? null;
    const projections = ctx?.get?.("sessionProjections") ?? ctx?.sessionProjections ?? null;
    try {
      m = meter?.measure?.(session) ?? null;
    } catch {
      // 没装 token-meter 就只做空转
    }
    try {
      b = projections?.stateOf?.(session, "contextBreakdown") ?? null;
    } catch {
      // 没装投影就只报总量
    }
    const total = Number(m?.totalTokens) || 0;
    if (!total && !b) return null;
    return {
      total,
      surface: Number(m?.surfaceTokens) || 0,
      system: Number(b?.systemTokens) || 0,
      tools: Number(b?.toolsTokens) || 0,
      messages: Number(b?.messageTokens) || 0,
    };
  }

  function sample(reason = "tick") {
    const rows = [];
    try {
      for (const [key, entry] of sessions?.entries ?? []) {
        if (!entry?.handle?.agent?.session) continue;
        const s = sampleOf(key);
        if (!s) continue;
        const prev = last.get(key);
        last.set(key, s.total);
        rows.push({ key, ...s, delta: prev == null ? 0 : Math.max(0, s.total - prev) });
      }
    } catch {
      return null;
    }
    if (!rows.length) {
      if (reason === "boot") logger?.info?.("[onebot] 上下文用量：暂时没有可测的会话");
      return null;
    }

    const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const agg = {
      at: new Date().toISOString(),
      reason,
      sessions: rows.length,
      total: sum("total"),
      system: sum("system"),
      tools: sum("tools"),
      messages: sum("messages"),
      top: rows.sort((a, b) => b.total - a.total).slice(0, 3).map((r) => ({ key: r.key, total: r.total, tools: r.tools })),
    };
    try {
      mkdirSync(dirname(USAGE_PATH), { recursive: true });
      appendFileSync(USAGE_PATH, JSON.stringify(agg) + "\n");
    } catch {
      // 写不进去不影响运行
    }
    const pct = (x) => (agg.total ? Math.round((x / agg.total) * 100) : 0);
    logger?.info?.(
      `[onebot] 上下文用量：${agg.sessions} 个会话｜合计 ${agg.total} tokens` +
        `｜tools ${agg.tools} (${pct(agg.tools)}%)｜system ${agg.system} (${pct(agg.system)}%)｜msgs ${agg.messages} (${pct(agg.messages)}%)`,
    );
    return agg;
  }

  /** 一个回合刚结束时量一次：这时 session 还开着，能读到完整构成 */
  function note(session, key = "") {
    if (!session) return null;
    const meter = ctx?.get?.("tokenMeter") ?? ctx?.tokenMeter ?? null;
    const projections = ctx?.get?.("sessionProjections") ?? ctx?.sessionProjections ?? null;
    let m = null;
    let b = null;
    try { m = meter?.measure?.(session) ?? null; } catch {}
    try { b = projections?.stateOf?.(session, "contextBreakdown") ?? null; } catch {}
    const total = Number(m?.totalTokens) || 0;
    if (!total && !b) return null;
    const row = {
      at: new Date().toISOString(),
      reason: "turn",
      key,
      total,
      system: Number(b?.systemTokens) || 0,
      tools: Number(b?.toolsTokens) || 0,
      messages: Number(b?.messageTokens) || 0,
    };
    try {
      mkdirSync(dirname(USAGE_PATH), { recursive: true });
      appendFileSync(USAGE_PATH, JSON.stringify(row) + "\n");
    } catch {}
    const pct = (x) => (row.total ? Math.round((x / row.total) * 100) : 0);
    logger?.info?.(
      `[onebot] 回合用量 ${key}｜${row.total} tokens｜tools ${row.tools} (${pct(row.tools)}%)｜system ${row.system}｜msgs ${row.messages}`,
    );
    return row;
  }

  function start(ms = SAMPLE_MS) {
    if (timer) return;
    timer = setInterval(() => sample("tick"), ms);
    timer.unref?.();
    // 启动后 90 秒先采一次：那时会话基本都还开着，能尽早看到基线
    setTimeout(() => sample("boot"), 90_000).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { sample, note, start, stop };
}
