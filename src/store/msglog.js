// 消息落盘：按群/按天分片的读写、游标翻页、迁移与清理。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../core/logger.js";

const HOME = process.env.HOME || homedir();

const MSG_LOG_DIR = join(HOME, ".dsh/onebot-bridge/messages");

const MSG_LOG_PRIVATE_DIR = join(MSG_LOG_DIR, "private");

const MSG_LOG_GROUP_DIR = join(MSG_LOG_DIR, "group");

const MSG_LOG_DAY_MAX_LINES = 20000;

const MSG_LOG_DAY_KEEP_LINES = 15000;

const MSG_LOG_KEEP_DAYS = 180;

const MSG_LOG_STATE = { fail: 0, lastWarn: 0, mem: [] };

function msgLogKeyOf(ev) {
  const mt = String(ev?.message_type ?? "");
  if (mt === "group" && ev?.group_id) return "group:" + String(ev.group_id);
  if (mt === "private" && ev?.user_id) return "private:" + String(ev.user_id);
  return "";
}

function msgLogIsPrivate(key) {
  return String(key || "").startsWith("private:");
}

function msgLogDirFor(key) {
  const k = String(key || "");
  if (k.startsWith("private:")) {
    const uid = k.slice(8);
    if (!/^\d{5,20}$/.test(uid)) return "";
    return join(MSG_LOG_PRIVATE_DIR, uid);
  }
  const gid = k.startsWith("group:") ? k.slice(6) : k;
  if (!/^\d{5,20}$/.test(gid)) return "";
  return join(MSG_LOG_GROUP_DIR, gid);
}

function msgLogLegacyFileFor(key) {
  const k = String(key || "");
  if (k.startsWith("private:")) {
    const uid = k.slice(8);
    if (!/^\d{5,20}$/.test(uid)) return "";
    return join(MSG_LOG_PRIVATE_DIR, uid + ".jsonl");
  }
  const gid = k.startsWith("group:") ? k.slice(6) : k;
  if (!/^\d{5,20}$/.test(gid)) return "";
  // 旧版群文件直接放在 messages/ 根目录
  return join(MSG_LOG_DIR, gid + ".jsonl");
}

function msgLogDay(tsSec) {
  const d = new Date((Number(tsSec) || Math.floor(Date.now() / 1000)) * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function msgLogFileFor(key, tsSec) {
  const dir = msgLogDirFor(key);
  if (!dir) return "";
  return join(dir, msgLogDay(tsSec) + ".jsonl");
}

function msgLogDayFiles(key) {
  const dir = msgLogDirFor(key);
  const out = [];
  if (!dir) return out;
  try {
    for (const f of readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) out.push(join(dir, f));
    }
  } catch {
    return out;
  }
  out.sort();
  const legacy = msgLogLegacyFileFor(key);
  if (legacy && existsSync(legacy)) out.unshift(legacy);
  return out;
}

function appendMsgRec(key, rec) {
  const file = msgLogFileFor(key, rec?.t);
  if (!file) return;
  mkdirSync(dirnameOf(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n");
  MSG_LOG_STATE.fail = 0;
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > MSG_LOG_DAY_MAX_LINES) {
      writeFileSync(file, lines.slice(-MSG_LOG_DAY_KEEP_LINES).join("\n") + "\n");
    }
  } catch {
    // 裁剪失败不影响写入
  }
}

function dirnameOf(p) {
  const i = String(p).lastIndexOf("/");
  return i > 0 ? String(p).slice(0, i) : p;
}

function recordMessage(ev, parsed) {
  try {
    const key = msgLogKeyOf(ev);
    if (!key) return;
    const rec = {
      v: 1,
      k: key,
      d: "i",
      id: String(ev?.message_id ?? ""),
      g: key.startsWith("group:") ? key.slice(6) : "",
      u: String(ev?.user_id ?? ""),
      n: String(ev?.sender?.card || ev?.sender?.nickname || "").slice(0, 40),
      t: Number(ev?.time) || Math.floor(Date.now() / 1000),
      x: String(parsed?.text || "").slice(0, 500),
      atMe: parsed?.hasAt ? 1 : 0,
    };
    const ats = (parsed?.mentions || []).slice(0, 10);
    if (ats.length) rec.ats = ats;
    if (parsed?.replyIds?.[0]) rec.qid = String(parsed.replyIds[0]);
    if (parsed?.replySummary) rec.q = String(parsed.replySummary).slice(0, 200);
    const img = (parsed?.images || []).slice(0, 4).map((x) => ({
      url: String(x?.url || "").slice(0, 300),
      file: String(x?.file || "").slice(0, 200),
    }));
    if (img.length) rec.img = img;
    if (parsed?.forwards?.length) {
      rec.fw = { id: String(parsed.forwards[0]?.id || ""), n: parsed.forwards.length };
    }
    const files = (parsed?.files || []).slice(0, 5).map((f) => ({
      name: String(f?.name || "").slice(0, 80),
      size: Number(f?.size) || 0,
    }));
    if (files.length) rec.files = files;
    const unk = (parsed?.unk || []).slice(0, 5);
    if (unk.length) rec.unk = unk;
    appendMsgRec(key, rec);
  } catch (err) {
    MSG_LOG_STATE.fail += 1;
    MSG_LOG_STATE.mem.push(Date.now());
    if (MSG_LOG_STATE.mem.length > 200) MSG_LOG_STATE.mem.shift();
    const now = Date.now();
    if (now - (MSG_LOG_STATE.lastWarn || 0) > 60_000) {
      MSG_LOG_STATE.lastWarn = now;
      try {
        getLogger()?.warn?.(`[onebot] 消息落盘失败（连续 ${MSG_LOG_STATE.fail} 次）：${err?.message ?? err}`);
      } catch {
        // 连日志都写不了就算了
      }
    }
  }
}

function recordOutbound(ev, text, opts = {}) {
  try {
    const key = msgLogKeyOf(ev);
    if (!key) return;
    const body = String(text ?? "").trim();
    if (!body) return;
    const rec = {
      v: 1,
      k: key,
      d: "o",
      id: String(opts.messageId || "out-" + Date.now().toString(36)),
      g: key.startsWith("group:") ? key.slice(6) : "",
      u: String(opts.selfId ?? ""),
      n: "我",
      t: Math.floor(Date.now() / 1000),
      x: body.slice(0, 500),
    };
    if (opts.qid) rec.qid = String(opts.qid);
    if (opts.to) rec.to = String(opts.to);
    appendMsgRec(key, rec);
  } catch {
    // 落盘失败不影响发送
  }
}

function parseMsgLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // 单行坏了跳过
    }
  }
  return out;
}

function readMsgLog(key, limit = 500) {
  const want = Math.max(1, Number(limit) || 500);
  const files = msgLogDayFiles(key);
  if (!files.length) return [];
  const chunks = [];
  let got = 0;
  for (let i = files.length - 1; i >= 0 && got < want; i -= 1) {
    try {
      const lines = readFileSync(files[i], "utf8").split("\n").filter(Boolean);
      const take = lines.slice(-Math.min(want - got, lines.length));
      const rows = parseMsgLines(take);
      chunks.unshift(...rows);
      got += rows.length;
    } catch {
      // 单个文件读失败跳过
    }
  }
  return chunks;
}

function cmpMsgRec(a, b) {
  const ta = Number(a?.t) || 0;
  const tb = Number(b?.t) || 0;
  if (ta !== tb) return ta - tb;
  const ia = String(a?.id ?? "");
  const ib = String(b?.id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function encodeCursor(rec) {
  try {
    return Buffer.from(JSON.stringify({ t: Number(rec?.t) || 0, id: String(rec?.id ?? "") })).toString("base64url");
  } catch {
    return "";
  }
}

function decodeCursor(cur) {
  if (!cur) return null;
  try {
    const o = JSON.parse(Buffer.from(String(cur), "base64url").toString("utf8"));
    if (!o || typeof o !== "object") return null;
    return { t: Number(o.t) || 0, id: String(o.id ?? "") };
  } catch {
    return null;
  }
}

function readMsgLogPage(key, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const before = decodeCursor(opts.before);
  const after = decodeCursor(opts.after);
  const sinceSec = Number(opts.sinceSec) || 0;
  const files = msgLogDayFiles(key);
  if (!files.length) return { rows: [], hasMore: false, nextCursor: "" };
  const all = [];
  for (let i = files.length - 1; i >= 0; i -= 1) {
    try {
      const text = readFileSync(files[i], "utf8");
      const day = String(files[i].match(/(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1] || "";
      // 文件首行时间早于 sinceSec 就整段跳过（按天分片，够用）
      if (sinceSec && day) {
        const dayStart = Date.parse(day + "T00:00:00+08:00") / 1000;
        if (Number.isFinite(dayStart) && dayStart + 86400 < sinceSec) continue;
      }
      all.push(...parseMsgLines(text.split("\n").filter(Boolean)));
      // 翻到够用就停：最多取 limit 的 8 倍，避免每次扫全部历史
      if (all.length >= Math.max(limit * 8, 400)) break;
    } catch {
      // 单个文件失败跳过
    }
  }
  all.sort(cmpMsgRec);
  let rows = all;
  if (sinceSec) rows = rows.filter((r) => (Number(r.t) || 0) >= sinceSec);
  if (before) {
    rows = rows.filter(
      (r) => cmpMsgRec(r, { t: before.t, id: before.id }) < 0 || (Number(r.t) === before.t && String(r.id) !== before.id && cmpMsgRec(r, { t: before.t, id: before.id }) < 0),
    );
  }
  if (after) rows = rows.filter((r) => cmpMsgRec(r, { t: after.t, id: after.id }) > 0);
  // 取最新的 limit 条（从旧到新返回）
  const hasMore = rows.length > limit;
  const page = rows.slice(-limit);
  const nextCursor = hasMore && page.length ? encodeCursor(page[0]) : "";
  return { rows: page, hasMore, nextCursor };
}

function readMsgLogPageMulti(keys, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const sinceSec = Number(opts.sinceSec) || 0;
  const all = [];
  for (const k of keys) {
    const page = readMsgLogPage(k, { ...opts, limit: 200 });
    all.push(...page.rows);
  }
  all.sort(cmpMsgRec);
  let rows = all;
  if (sinceSec) rows = rows.filter((r) => (Number(r.t) || 0) >= sinceSec);
  const before = decodeCursor(opts.before);
  const after = decodeCursor(opts.after);
  if (before) rows = rows.filter((r) => cmpMsgRec(r, { t: before.t, id: before.id }) < 0);
  if (after) rows = rows.filter((r) => cmpMsgRec(r, { t: after.t, id: after.id }) > 0);
  const hasMore = rows.length > limit;
  const page = rows.slice(-limit);
  const nextCursor = hasMore && page.length ? encodeCursor(page[0]) : "";
  return { rows: page, hasMore, nextCursor };
}

function findMsgInLog(key, id) {
  const target = String(id || "").trim();
  if (!target) return null;
  const rows = readMsgLog(key, 3000);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (String(rows[i]?.id) === target) return rows[i];
  }
  return null;
}

function listMsgKeys() {
  const out = [];
  const scan = (root, prefix, isDir) => {
    try {
      for (const name of readdirSync(root)) {
        if (isDir) {
          if (/^\d{5,20}$/.test(name)) out.push(prefix + name);
        } else if (name.endsWith(".jsonl") && /^\d{5,20}\.jsonl$/.test(name)) {
          out.push(prefix + name.replace(/\.jsonl$/, ""));
        }
      }
    } catch {
      // 目录还不存在
    }
  };
  scan(MSG_LOG_GROUP_DIR, "group:", true);
  scan(MSG_LOG_PRIVATE_DIR, "private:", true);
  scan(MSG_LOG_DIR, "group:", false);
  scan(MSG_LOG_PRIVATE_DIR, "private:", false);
  return Array.from(new Set(out));
}

function migrateLegacyLogs() {
  let moved = 0;
  for (const key of listMsgKeys()) {
    const legacy = msgLogLegacyFileFor(key);
    if (!legacy || !existsSync(legacy)) continue;
    try {
      const rows = parseMsgLines(readFileSync(legacy, "utf8").split("\n").filter(Boolean));
      const byDay = new Map();
      for (const r of rows) {
        const f = msgLogFileFor(key, r?.t);
        if (!f) continue;
        if (!byDay.has(f)) byDay.set(f, []);
        byDay.get(f).push(r);
      }
      for (const [f, list] of byDay) {
        mkdirSync(dirnameOf(f), { recursive: true });
        appendFileSync(f, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
      }
      renameSync(legacy, legacy + ".migrated");
      moved += 1;
    } catch {
      // 迁移失败就留着旧文件，读的时候仍会带上
    }
  }
  if (moved) getLogger()?.info?.(`[onebot] 消息落盘已迁移为按天分片：${moved} 个会话`);
}

function pruneOldLogs() {
  const cutoff = Date.now() / 1000 - MSG_LOG_KEEP_DAYS * 86400;
  let removed = 0;
  const pruneDir = (dir) => {
    try {
      for (const name of readdirSync(dir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        const t = Date.parse(m[1] + "T00:00:00+08:00") / 1000;
        if (Number.isFinite(t) && t + 86400 < cutoff) {
          unlinkSync(join(dir, name));
          removed += 1;
        }
      }
    } catch {
      // 目录不存在
    }
  };
  try {
    for (const gid of readdirSync(MSG_LOG_GROUP_DIR)) pruneDir(join(MSG_LOG_GROUP_DIR, gid));
  } catch {
    // 忽略
  }
  try {
    for (const uid of readdirSync(MSG_LOG_PRIVATE_DIR)) {
      if (/^\d{5,20}$/.test(uid)) pruneDir(join(MSG_LOG_PRIVATE_DIR, uid));
    }
  } catch {
    // 忽略
  }
  if (removed) getLogger()?.info?.(`[onebot] 清理了 ${removed} 个过期消息分片`);
}

export { HOME, MSG_LOG_DIR, MSG_LOG_PRIVATE_DIR, MSG_LOG_GROUP_DIR, MSG_LOG_DAY_MAX_LINES, MSG_LOG_DAY_KEEP_LINES, MSG_LOG_KEEP_DAYS, MSG_LOG_STATE, msgLogKeyOf, msgLogIsPrivate, msgLogDirFor, msgLogLegacyFileFor, msgLogDay, msgLogFileFor, msgLogDayFiles, appendMsgRec, dirnameOf, recordMessage, recordOutbound, parseMsgLines, readMsgLog, cmpMsgRec, encodeCursor, decodeCursor, readMsgLogPage, readMsgLogPageMulti, findMsgInLog, listMsgKeys, migrateLegacyLogs, pruneOldLogs };
