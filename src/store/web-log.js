// 联网/阅读留痕：一条索引 + 一份原文。
//
// 索引进 readings.jsonl（沿用原文件，加字段），原文进 web-data/<hash>.txt。
// 摘要 gist 优先取页面首段；取不到就留空，后面沉淀时补。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HOME, ".dsh/onebot-bridge");
const READINGS = join(ROOT, "readings.jsonl");
const BLOBDIR = join(ROOT, "web-data");
const MAX_BLOB = 500 * 1024;

function pickText(result) {
  try {
    if (typeof result === "string") return result;
    const c = result?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => x?.text || "").join("\n");
    if (typeof result?.text === "string") return result.text;
    return JSON.stringify(result ?? "").slice(0, 20000);
  } catch {
    return "";
  }
}

/** 从结果里尽量抓标题和摘要素材 */
function gistOf(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.slice(0, 200);
}

export function recordReading({ tool, args, result }) {
  try {
    const url = String(args?.url || args?.href || "").trim();
    if (!url && tool !== "read_page") return { ok: false };
    const text = pickText(result);
    if (!text || text.length < 40) return { ok: false, reason: "内容太短，不记" };
    mkdirSync(BLOBDIR, { recursive: true });
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
    const blobPath = join(BLOBDIR, hash + ".txt");
    const body = text.slice(0, MAX_BLOB);
    if (!existsSync(blobPath)) writeFileSync(blobPath, body, "utf8");
    const title = (() => {
      const m = String(text).match(/<title[^>]*>([^<]{1,120})<\/title>/i);
      if (m) return m[1].trim();
      const first = String(text).split("\n").map((x) => x.trim()).find((x) => x && x.length < 60);
      return first || url || "(无标题)";
    })();
    const row = {
      at: Date.now(),
      src: "chat",
      title: title.slice(0, 80),
      url,
      gist: gistOf(text),
      ref: "web-data/" + hash + ".txt",
      chars: text.length,
      why: String(args?.why || "").slice(0, 100),
    };
    appendFileSync(READINGS, JSON.stringify(row) + "\n", "utf8");
    return { ok: true, ref: row.ref };
  } catch {
    return { ok: false };
  }
}

/** 按关键词/天数查读过的内容（供 my_memory kind=read 用） */
export function searchReadings({ query, days = 30, limit = 20 } = {}) {
  try {
    const cut = Date.now() - Number(days) * 86400_000;
    let rows = readFileSync(READINGS, "utf8").split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    rows = rows.filter((r) => (r.at || 0) >= cut);
    if (query) {
      const q = String(query);
      rows = rows.filter((r) => String(r.title || "").includes(q) || String(r.gist || "").includes(q) || String(r.url || "").includes(q));
    }
    return rows.slice(-Number(limit));
  } catch {
    return [];
  }
}

export function readBlob(ref) {
  try {
    return readFileSync(join(ROOT, String(ref)), "utf8");
  } catch {
    return "";
  }
}
