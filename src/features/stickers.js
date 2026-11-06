// 表情包选择与描述缓存。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, join as pathJoin } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();

function loadStickerLabels(dir) {
  try {
    return JSON.parse(readFileSync(pathJoin(dir, "labels.json"), "utf8"));
  } catch {
    return {};
  }
}

const STICKER_NEGS = ["不", "没", "无", "别", "莫", "非", "表", "儿"];

let lastSvgRender = null;

let lastStickerPreview = [];

function stickerContradicts(key, tag) {
  const i = key.indexOf(tag);
  if (i <= 0) return false;
  if (STICKER_NEGS.some((n) => key.slice(0, i).endsWith(n))) return true;
  return /^(不起来|不了|不成|不出|不动|不下去)/.test(key.slice(i + tag.length));
}

const STICKER_ANTONYM = {
  开心: ["委屈", "哭"], 高兴: ["委屈", "哭"], 快乐: ["委屈", "哭"],
  笑: ["哭", "委屈"], 大笑: ["哭"], 得意: ["疲惫"],
  生气: ["疲惫", "委屈"], 兴奋: ["疲惫"], 精神: ["疲惫"],
  困: ["震惊"], 睡: ["震惊"], 舒服: ["疲惫"],
  喜欢: ["拒绝", "冷漠"], 满意: ["委屈"],
};

function pickStickerPool(dir, mood) {
  try {
    const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
    if (!files.length) return null;
    const labels = loadStickerLabels(dir);
    const key = String(mood || "").trim();
    if (!key) return { files, labels, matched: false };

    const match = (f, k) =>
      (labels[f] || []).some((t) => {
        if (!t) return false;
        if (stickerContradicts(k, t)) return false;
        return t === k || t.includes(k) || k.includes(t);
      });

    let hit = files.filter((f) => match(f, key));

    // 被否定挡掉时试一次反义
    if (!hit.length) {
      for (const [pos, negs] of Object.entries(STICKER_ANTONYM)) {
        if (!key.includes(pos) || !stickerContradicts(key, pos)) continue;
        for (const alt of negs) {
          const altHit = files.filter((f) => match(f, alt));
          if (altHit.length) {
            hit = altHit;
            break;
          }
        }
        if (hit.length) break;
      }
    }

    return hit.length ? { files: hit, labels, matched: true } : { files, labels, matched: false };
  } catch {
    return null;
  }
}

function pickSticker(dir, mood) {
  const pool = pickStickerPool(dir, mood);
  if (!pool) return null;
  const name = pool.files[Math.floor(Math.random() * pool.files.length)];
  return {
    path: pathJoin(dir, name),
    name,
    tags: pool.labels[name] || [],
    fallback: !pool.matched,
  };
}

function pickStickerCandidates(dir, mood, n) {
  const pool = pickStickerPool(dir, mood);
  if (!pool) return [];
  const want = Math.max(1, Math.min(5, Number(n) || 3));
  const out = [];
  const usedTagSets = new Set();
  const bag = [...pool.files];

  // 第一轮：优先标签组合不同的
  for (let guard = 0; guard < bag.length * 2 && out.length < want; guard++) {
    if (!bag.length) break;
    const idx = Math.floor(Math.random() * bag.length);
    const nm = bag[idx];
    const tags = pool.labels[nm] || [];
    const sig = [...tags].sort().join("|");
    if (usedTagSets.has(sig) && bag.length > want - out.length) continue;
    bag.splice(idx, 1);
    usedTagSets.add(sig);
    out.push({ path: pathJoin(dir, nm), name: nm, tags });
  }

  // 第二轮：不够就随便补
  while (out.length < want && bag.length) {
    const nm = bag.splice(Math.floor(Math.random() * bag.length), 1)[0];
    out.push({ path: pathJoin(dir, nm), name: nm, tags: pool.labels[nm] || [] });
  }

  return out;
}

function loadStickerDescs(dir) {
  try {
    return JSON.parse(readFileSync(pathJoin(dir, "descs.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

function saveStickerDesc(dir, name, desc) {
  try {
    const d = loadStickerDescs(dir);
    d[name] = String(desc || "").slice(0, 200);
    writeFileSync(pathJoin(dir, "descs.json"), JSON.stringify(d, null, 1), "utf8");
  } catch {
    // 忽略
  }
}

function resolveSticker(dir, key) {
  try {
    const files = readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort();
    const k = String(key || "").trim();
    if (!k || !files.length) return null;
    const labels = loadStickerLabels(dir);
    let name = null;
    if (/^m\d+$/i.test(k)) {
      name = files.find((f) => f.replace(/\.[^.]+$/, "").toLowerCase() === k.toLowerCase()) ?? null;
    } else if (/^\d+$/.test(k)) {
      name = files[Number(k) - 1] ?? null;
    } else {
      name = files.find((f) => f.toLowerCase() === k.toLowerCase()) ?? null;
    }
    if (!name) return null;
    return { path: pathJoin(dir, name), name, tags: labels[name] || [] };
  } catch {
    return null;
  }
}

export { HOME, loadStickerLabels, STICKER_NEGS, lastSvgRender, lastStickerPreview, stickerContradicts, STICKER_ANTONYM, pickStickerPool, pickSticker, pickStickerCandidates, loadStickerDescs, saveStickerDesc, resolveSticker };
