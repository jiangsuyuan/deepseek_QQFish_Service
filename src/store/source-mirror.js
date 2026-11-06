// 源码镜像：把整棵插件源码（index.js + src/）同步到 /opt/fish-src，供她自读。
//
// 3.0 拆目录以后，原来只同步 index.js 的做法会让她只看得到装配层——
// 业务逻辑全在 src/ 下。所以这里镜像整棵树，并保留相对路径：
//   /opt/fish-src/index.js
//   /opt/fish-src/src/features/chat.js
//
// 副本一律只读（她只能看不能改）。
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

export const MIRROR_ROOT = "/opt/fish-src";

/** 镜像里的所有 .js（相对路径，index.js 排最前） */
export function listSourceFiles(root = MIRROR_ROOT) {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(relative(root, p));
    }
  };
  if (existsSync(join(root, "index.js"))) out.push("index.js");
  walk(join(root, "src"));
  return out.sort((a, b) => (a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b)));
}

export function readSource(rel, root = MIRROR_ROOT) {
  return readFileSync(join(root, rel), "utf8");
}

/** 跨文件搜关键词，返回 [{file, line, code}] */
export function searchSource(kw, limit = 5, root = MIRROR_ROOT) {
  const hits = [];
  for (const f of listSourceFiles(root)) {
    let lines;
    try {
      lines = readSource(f, root).split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(kw)) continue;
      // 片段带绝对行号：她引用位置时不会数错
      const from = Math.max(0, i - 3);
      const numbered = lines
        .slice(from, i + 9)
        .map((l, k) => `${from + k + 1}: ${l}`)
        .join("\n");
      hits.push({
        file: f,
        line: i + 1,
        from: from + 1,
        code: numbered.slice(0, 1600),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** 按 `name: "xxx"` 这种标记定位，返回 "src/tools/chat.js:123" */
export function findInSource(needle, root = MIRROR_ROOT) {
  for (const f of listSourceFiles(root)) {
    let lines;
    try {
      lines = readSource(f, root).split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) return { file: f, line: i + 1, where: `${f}:${i + 1}` };
    }
  }
  return null;
}

/** 把 liveDir 下的 index.js + src/ 镜像到 /opt/fish-src（只读） */
export function mirrorSource(liveDir, root = MIRROR_ROOT) {
  mkdirSync(root, { recursive: true });
  const copied = [];
  const copyOne = (rel) => {
    const from = join(liveDir, rel);
    const to = join(root, rel);
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, 0o444);
    copied.push(rel);
  };
  copyOne("index.js");
  const walk = (dir, base = "src") => {
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = `${base}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.name.endsWith(".js")) copyOne(rel);
    }
  };
  const srcDir = join(liveDir, "src");
  if (existsSync(srcDir)) {
    try {
      rmSync(join(root, "src"), { recursive: true, force: true });
    } catch {
      // 删不掉就覆盖
    }
    walk(srcDir);
  }
  let bytes = 0;
  for (const rel of copied) {
    try {
      bytes += statSync(join(root, rel)).size;
    } catch {
      // 忽略
    }
  }
  return { files: copied.length, kb: Math.round(bytes / 1024) };
}
