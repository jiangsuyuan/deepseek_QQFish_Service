// 读某个频道最近的消息（给回看用）。
//
// 规则（创造者定的，越简单越好）：
//   · 只看"她最后一句之后"的消息
//   · 如果最近这些里没有她的话，就返回最近几条
//   · 她说完之后没有新消息 → 返回空，调用方就别打扰她
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

function channelPath(channel, day) {
  const [kind, id] = String(channel || "").split(":");
  if (!kind || !id) return null;
  if (kind !== "group" && kind !== "private") return null;
  return join(HOME, ".dsh/onebot-bridge/messages", kind, String(id), day + ".jsonl");
}

function todayName() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * @param {string} channel  group:<id> / private:<id>
 * @param {number} n        最多取几条
 * @returns {{rows: Array<{id:string,who:string,text:string,mine:boolean}>, afterMine: boolean}}
 */
export function tailRows(channel, n = 8) {
  const p = channelPath(channel, todayName());
  if (!p) return { rows: [], afterMine: false };
  let lines;
  try {
    lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-300);
  } catch {
    return { rows: [], afterMine: false };
  }
  const parsed = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      parsed.push({
        id: String(o.id || ""),
        who: o.d === "o" ? "你" : o.n || "对方",
        text: String(o.x || "").slice(0, 60),
        mine: o.d === "o",
      });
    } catch {
      // 跳过坏行
    }
  }
  // 找她最后一句
  let lastMine = -1;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    if (parsed[i].mine) {
      lastMine = i;
      break;
    }
  }
  if (lastMine < 0) {
    // 她没说过话：取最近几条，原样标出她自己（如果有）
    return { rows: parsed.slice(-n), afterMine: false };
  }
  const after = parsed.slice(lastMine + 1);
  return { rows: after.slice(-n), afterMine: true };
}
