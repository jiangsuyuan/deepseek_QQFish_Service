// 会话分段：一个频道一段连续对话，隔太久就换新会话。
//
// 为什么：以前所有频道共用 self:main-HH（按小时），一小时内所有轮次都累加，
// 第 8 轮要重发前 7 轮全文。分段后每段只有 2-3 轮，上下文降约八成。
//
// 规则：群聊 30 分钟 / 私聊 60 分钟，或者段内回合数超过上限，就先换新段。
import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HOME, ".dsh/onebot-bridge/conv-segments.json");

const WINDOW_MS = { group: 30 * 60 * 1000, private: 60 * 60 * 1000 };
const MAX_TURNS = 12; // 段内最多这么多回合，防高频群撑爆

export function createSessionSegments(app = {}) {
  const { logger } = app;
  let map = null;

  function load() {
    if (map) return map;
    try {
      map = JSON.parse(readFileSync(PATH, "utf8")) || {};
    } catch {
      map = {};
    }
    return map;
  }

  function save() {
    try {
      writeFileSync(PATH, JSON.stringify(map, null, 1), "utf8");
    } catch {
      // 写不进去就用内存里的，下次重启会重置段号（可接受）
    }
  }

  /** 频道标识：group:<id> / private:<id>；不认识的返回空 */
  function channelOf(e) {
    if (!e) return "";
    const src = e.source || {};
    const isGroup = src.type === "group" || e.kind === "mentioned" || e.kind === "replied" || e.kind === "quiet_group";
    if (isGroup && src.groupId) return "group:" + src.groupId;
    if (!isGroup && src.userId) return "private:" + src.userId;
    return "";
  }

  /**
   * 取这个频道当前该用的会话键。
   * 返回 { key, fresh, prevAt } —— fresh=true 表示刚开新段（调用方可以注入"上次这里"）。
   */
  function keyFor(channel) {
    const m = load();
    const rec = m[channel] || { seg: 1, lastAt: 0, turns: 0 };
    const kind = channel.startsWith("group:") ? "group" : "private";
    const win = WINDOW_MS[kind] || WINDOW_MS.group;
    const now = Date.now();
    const stale = rec.lastAt && now - rec.lastAt > win;
    const tooLong = rec.turns >= MAX_TURNS;
    let fresh = false;
    if (stale || tooLong) {
      rec.seg = (rec.seg || 1) + 1;
      rec.turns = 0;
      fresh = true;
      logger?.info?.(
        `[onebot] 会话分段 ${channel} -> 第 ${rec.seg} 段（${stale ? "隔了 " + Math.round((now - rec.lastAt) / 60000) + " 分钟" : "满 " + MAX_TURNS + " 回合"}）`,
      );
    }
    const prevAt = rec.lastAt;
    rec.lastAt = now;
    m[channel] = rec;
    save();
    return { key: `conv:${channel}:${rec.seg}`, fresh, prevAt, seg: rec.seg };
  }

  /** 这一轮跑完了 */
  function noteTurn(channel) {
    const m = load();
    const rec = m[channel];
    if (!rec) return;
    rec.turns = (rec.turns || 0) + 1;
    rec.lastAt = Date.now();
    save();
  }

  /** 顺手清理很老的段（保留最近 3 段） */
  function gc() {
    const m = load();
    let changed = false;
    for (const [ch, rec] of Object.entries(m)) {
      if ((rec.seg || 1) > 3) {
        m[ch] = { seg: rec.seg, lastAt: rec.lastAt || 0, turns: rec.turns || 0 };
      }
      if (!rec.lastAt) { delete m[ch]; changed = true; }
    }
    if (changed) save();
  }

  /** 取这个频道最近几条消息，用来在换段时接上话（不走模型，纯读文件） */
  function lastLines(channel, n = 2) {
    try {
      const [kind, id] = String(channel).split(":");
      if (!kind || !id) return [];
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const f = joinPath(HOME, ".dsh/onebot-bridge/messages", kind, id, day + ".jsonl");
      const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-n);
      return rows
        .map((l) => {
          try {
            const o = JSON.parse(l);
            return `${o.d === "o" ? "我" : o.n || "对方"}：${String(o.x || "").slice(0, 40)}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  return { channelOf, keyFor, noteTurn, gc, lastLines, WINDOW_MS, MAX_TURNS };
}
