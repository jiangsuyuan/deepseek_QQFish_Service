// 她自己的心情。
//
// 不做"每轮让模型猜"，只记她自己说的：
//   · feel 工具：她觉得心里变了，就自己记一笔（心情值 + 一句为什么）
//   · 衰减：没人碰它，就慢慢回到基线（纯代码，不花钱）
//   · 注入：只有明显偏离基线时才在系统提示里带一句，平时不打扰
//
// 数据：~/.dsh/onebot-bridge/mood.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HOME, ".dsh/onebot-bridge/mood.json");
const BASE = 70;
const HALF_LIFE_H = 3; // 3 小时回到一半
const SHOW_GAP = 12; // 偏离基线多少才告诉她
const KEEP = 200;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function createMood({ logger } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(readFileSync(PATH, "utf8"));
    } catch {
      cache = { mood: BASE, base: BASE, why: "", updatedAt: 0, history: [] };
    }
    if (typeof cache.mood !== "number") cache.mood = BASE;
    if (typeof cache.base !== "number") cache.base = BASE;
    if (!Array.isArray(cache.history)) cache.history = [];
    return cache;
  }

  function save(s) {
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      writeFileSync(PATH, JSON.stringify(s, null, 1), "utf8");
    } catch {
      // 忽略
    }
  }

  /** 衰减：没被动过时心情向基线回落，半衰期 3 小时 */
  function decay(s, now = Date.now()) {
    const last = Number(s.updatedAt) || now;
    const hours = Math.max(0, (now - last) / 3600000);
    if (hours <= 0) return s;
    const k = Math.pow(0.5, hours / HALF_LIFE_H);
    s.mood = Number((s.base + (s.mood - s.base) * k).toFixed(1));
    return s;
  }

  /** 她现在的心情（会先算衰减） */
  function current() {
    const s = decay(load());
    return s;
  }

  /** 她自己记一笔：mood 直接给目标值；也可以给 delta */
  function feel({ mood, delta, why } = {}) {
    const s = decay(load());
    const before = s.mood;
    let next = Number(mood);
    if (!Number.isFinite(next) && Number.isFinite(delta)) next = s.mood + Number(delta);
    if (!Number.isFinite(next)) return { ok: false, reason: "要么给 mood(0-100)，要么给 delta" };
    s.mood = clamp(Number(next.toFixed(1)), 0, 100);
    s.why = String(why || "").slice(0, 120);
    s.updatedAt = Date.now();
    s.history = [...s.history, { at: s.updatedAt, mood: s.mood, from: before, why: s.why }].slice(-KEEP);
    save(s);
    logger?.info?.(`[onebot] 心情 ${before.toFixed(0)} → ${s.mood}（${s.why || "没说为什么"}）`);
    return { ok: true, mood: s.mood, before, why: s.why };
  }

  /** 拼进系统提示的那一句：只在她明显偏离基线、或者最近刚变过时才说 */
  function line() {
    try {
      const s = current();
      const gap = Math.abs(s.mood - s.base);
      const justNow = Date.now() - Number(s.updatedAt || 0) < 2 * 3600000;
      if (gap < SHOW_GAP && !justNow) return "";
      const label =
        s.mood >= 85 ? "很好" : s.mood >= 70 ? "不错" : s.mood >= 55 ? "一般" : s.mood >= 35 ? "有点低落" : "很低落";
      const why = s.why ? `（${s.why}）` : "";
      return `（你现在心情${label}，${s.mood.toFixed(0)}/100${why}。要不要把这点情绪带出来，你自己决定。）`;
    } catch {
      return "";
    }
  }

  /** 给她用的工具 */
  function register() {
    return {
      name: "feel",
      description:
        "记一笔你自己的心情。心里确实变了才记，没变就别记。\n" +
        "可以给一个目标值（0-100，70 是平常），也可以只给涨跌（比如 +8 / -12）。\n" +
        "记完会慢慢回到平常，半衰期三小时；只有明显偏离时才会被别人看到。",
      parameters: {
        mood: { type: "number", description: "心情目标值 0-100（70 = 平常）" },
        delta: { type: "number", description: "或者只给涨跌，比如 8 或 -12" },
        why: { type: "string", description: "一句为什么，比如「被说了一句难听的」" },
      },
      execute: async (args) => feel(args || {}),
    };
  }

  function status() {
    const s = current();
    return { mood: s.mood, base: s.base, why: s.why, updatedAt: s.updatedAt, history: s.history.length };
  }

  return { feel, line, current, status, register, PATH };
}
