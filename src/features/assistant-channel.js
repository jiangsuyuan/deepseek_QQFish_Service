// 助手通道：创造者（或替他跑活的 agent）和她之间的专用通道。
// 不混进 QQ 对话，也不混进看板的时间线——单独一份进出记录。
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HOME, ".dsh/onebot-bridge/assistant");
const INBOX = join(DIR, "inbox.jsonl");
const OUTBOX = join(DIR, "outbox.jsonl");
const SEEN = join(DIR, "seen.json");

function ensure() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    // 忽略
  }
}

function loadSeen() {
  try {
    return JSON.parse(readFileSync(SEEN, "utf8")) || { ids: [] };
  } catch {
    return { ids: [] };
  }
}

function saveSeen(v) {
  try {
    ensure();
    writeFileSync(SEEN, JSON.stringify(v), "utf8");
  } catch {
    // 忽略
  }
}

export function readInbox() {
  ensure();
  try {
    return readFileSync(INBOX, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 还没看过的消息 */
export function unreadInbox() {
  const seen = new Set(loadSeen().ids || []);
  return readInbox().filter((m) => m.id && !seen.has(m.id));
}

export function markSeen(ids) {
  const cur = loadSeen();
  const set = new Set(cur.ids || []);
  for (const id of ids) set.add(String(id));
  saveSeen({ ids: [...set].slice(-500) });
}

export function reply(body) {
  ensure();
  const rec = { at: Date.now(), from: "her", text: String(body || "").slice(0, 4000) };
  try {
    appendFileSync(OUTBOX, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // 忽略
  }
  return rec;
}

export function postFromOwner(text, who = "创造者") {
  ensure();
  const rec = { id: "m" + Date.now().toString(36), at: Date.now(), from: String(who), text: String(text || "").slice(0, 4000) };
  try {
    appendFileSync(INBOX, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // 忽略
  }
  return rec;
}

export default { readInbox, unreadInbox, markSeen, reply, postFromOwner };
