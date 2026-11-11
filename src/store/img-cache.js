// 图片本地缓存。
//
// 为什么：QQ 的图片地址几分钟就过期。她经常是"过一会儿才想起来存那张"，
// 那时候 URL 已经拉不动了（2026-11-11：34 分钟后要存，直接过期）。
// 收到带图消息时先落一份本地副本，之后看/存都走本地。
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HOME, ".dsh/onebot-bridge/imgcache");
const INDEX = join(DIR, "index.json");
const MAX_FILES = 300;
const MAX_AGE_MS = 72 * 3600 * 1000;

function ensure() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    // 忽略
  }
}

function loadIndex() {
  try {
    return JSON.parse(readFileSync(INDEX, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveIndex(ix) {
  try {
    ensure();
    writeFileSync(INDEX, JSON.stringify(ix), "utf8");
  } catch {
    // 忽略
  }
}

function extOf(buf, hint) {
  const h = String(hint || "").toLowerCase();
  if (h.includes("gif") || (buf[0] === 0x47 && buf[1] === 0x49)) return ".gif";
  if (h.includes("webp") || (buf[8] === 0x57 && buf[9] === 0x45)) return ".webp";
  if (h.includes("png") || (buf[0] === 0x89 && buf[1] === 0x50)) return ".png";
  return ".jpg";
}

/** 把一条消息里的图落盘（失败就算了，不影响主流程） */
export async function cacheMessageImages({ messageId, images, imagePayloadFrom, logger }) {
  try {
    const id = String(messageId || "").trim();
    if (!id || !Array.isArray(images) || !images.length) return 0;
    ensure();
    const ix = loadIndex();
    let saved = 0;
    for (let i = 0; i < images.length && i < 4; i += 1) {
      const im = images[i];
      if (!im) continue;
      try {
        const got = await imagePayloadFrom(im);
        const buf = got?.data ? Buffer.from(got.data) : null;
        if (!buf || !buf.length) continue;
        const ext = extOf(buf, got?.mediaType || im?.file || "");
        const file = join(DIR, `${id}-${i + 1}${ext}`);
        writeFileSync(file, buf);
        ix[id] = ix[id] || [];
        ix[id][i] = { path: file, at: Date.now(), ext };
        saved += 1;
      } catch {
        // 单张失败不影响其他
      }
    }
    if (saved) {
      saveIndex(ix);
      prune();
    }
    return saved;
  } catch (err) {
    logger?.warn?.("[onebot] 图片缓存失败：" + (err?.message ?? err));
    return 0;
  }
}

/** 取缓存里的图（按消息 id + 第几张） */
export function cachedImage(messageId, which = 1) {
  try {
    const ix = loadIndex();
    const arr = ix[String(messageId || "")];
    if (!Array.isArray(arr)) return null;
    const one = arr[Math.max(0, Math.min(arr.length - 1, Number(which || 1) - 1))];
    if (!one?.path) return null;
    if (!existsSync(one.path)) return null;
    return { path: one.path, ext: one.ext, at: one.at };
  } catch {
    return null;
  }
}

function prune() {
  try {
    const files = readdirSync(DIR)
      .filter((f) => f !== "index.json")
      .map((f) => ({ f, at: statSync(join(DIR, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    const now = Date.now();
    const drop = files.filter((x) => now - x.at > MAX_AGE_MS);
    const over = files.length - MAX_FILES;
    if (over > 0) drop.push(...files.slice(0, over));
    for (const d of drop) {
      try {
        unlinkSync(join(DIR, d.f));
      } catch {
        // 忽略
      }
    }
    if (drop.length) {
      const ix = loadIndex();
      for (const k of Object.keys(ix)) {
        ix[k] = (ix[k] || []).filter((x) => x?.path && existsSync(x.path));
        if (!ix[k].length) delete ix[k];
      }
      saveIndex(ix);
    }
  } catch {
    // 忽略
  }
}

export default { cacheMessageImages, cachedImage };
