// 创造者的临时嘱托：只在做活动之前给她看，过期自动失效。
// 和「人格」「需求本」不是一回事——它是一次性的、有时限的交代。
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HOME, ".dsh/onebot-bridge");
const FILE = join(DIR, "commission.json");
const DEFAULT_HOURS = 72;

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    // 忽略
  }
}

/** 当前有效的嘱托；没有或过期返回 null */
export function activeCommission() {
  try {
    if (!existsSync(FILE)) return null;
    const c = JSON.parse(readFileSync(FILE, "utf8"));
    if (!c || !String(c.text || "").trim()) return null;
    const exp = Number(c.expiresAt || 0);
    if (exp && Date.now() > exp) return null;
    return {
      text: String(c.text).slice(0, 2000),
      at: Number(c.at || 0),
      by: String(c.by || "创造者"),
      expiresAt: exp,
    };
  } catch {
    return null;
  }
}

export function setCommission(text, hours = DEFAULT_HOURS, by = "创造者") {
  ensureDir();
  const rec = {
    text: String(text || "").slice(0, 2000),
    at: Date.now(),
    by: String(by),
    expiresAt: Date.now() + Math.max(1, Number(hours) || DEFAULT_HOURS) * 3600_000,
  };
  writeFileSync(FILE, JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

export function clearCommission() {
  try {
    if (existsSync(FILE)) unlinkSync(FILE);
    return true;
  } catch {
    return false;
  }
}

export default { activeCommission, setCommission, clearCommission };
