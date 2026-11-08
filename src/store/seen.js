// 已读去重 + 拒答名单。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

const SEEN_PATH = join(HOME, ".dsh/onebot-bridge/seen.json");

const REFUSE_PATH = join(HOME, ".dsh/onebot-bridge/refusals.json");

let refuseState = {};

function isRefused(uid) {
  const rec = refuseState[String(uid)];
  return !!(rec && Number(rec.until || 0) > Date.now());
}

function refusePerson(uid, minutes, meta = {}) {
  refuseState[String(uid)] = {
    until: Date.now() + Math.max(5, Number(minutes) || 120) * 60_000,
    reason: String(meta.reason ?? "").slice(0, 80),
    key: String(meta.key ?? ""),
    at: Date.now(),
  };
  try {
    writeFileSync(REFUSE_PATH, JSON.stringify(refuseState, null, 1));
  } catch {
    // 写不进去也不影响本次生效
  }
  return refuseState[String(uid)];
}

const seenState = (() => {
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf8"));
  } catch {
    return {};
  }
})();

let seenDirty = false;

function markSeen(key, tsMs, messageId) {
  const rec = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
  if (tsMs && tsMs > (rec.lastTime ?? 0)) rec.lastTime = tsMs;
  if (messageId) {
    rec.ids = Array.isArray(rec.ids) ? rec.ids : [];
    const id = String(messageId);
    if (!rec.ids.includes(id)) rec.ids.push(id);
    if (rec.ids.length > 300) rec.ids = rec.ids.slice(-300);
  }
  seenDirty = true;
}

function flushSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
    writeFileSync(SEEN_PATH, JSON.stringify(seenState));
  } catch {
    // 忽略
  }
}

export { HOME, SEEN_PATH, REFUSE_PATH, refuseState, isRefused, refusePerson, seenState, seenDirty, markSeen, flushSeen };

/** 载入拒答名单 */
export function setRefuseState(v) {
  refuseState = v && typeof v === "object" ? v : {};
}
