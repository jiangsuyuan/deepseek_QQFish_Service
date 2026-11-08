// 文本处理：纯函数，不依赖任何运行时状态。

function safeSegData(data) {
  try {
    const s = JSON.stringify(data ?? {});
    return s.length > 400 ? s.slice(0, 400) : s;
  } catch {
    return "";
  }
}

function smartCut(text, max) {
  const t = String(text || "");
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  // 优先切在句末
  const m = head.match(/[\s\S]*[。！？…!?\n]/);
  if (m && m[0].trim().length >= max * 0.55) return m[0].trim();
  // 退一步切在逗号/分号
  const m2 = head.match(/[\s\S]*[，；、,;]/);
  if (m2 && m2[0].trim().length >= max * 0.55) return m2[0].trim() + "…";
  return head.trim() + "…";
}

function stripLoneSurrogates(input) {
  const s = String(input ?? "");
  if (!s) return s;
  try {
    // 先按码点规整，再去掉落单的代理
    return s
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  } catch {
    // 环境不支持 lookbehind 时退化为只处理高位
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  }
}

function safeSlice(input, max) {
  const s = String(input ?? "");
  if (s.length <= max) return s;
  try {
    const arr = Array.from(s);
    return arr.slice(0, max).join("");
  } catch {
    return s.slice(0, max);
  }
}

function humanizePunct(input) {
  let t = String(input || "").trim();
  if (!t) return t;
  if (!/[。．]$/.test(t)) return t; // 本来就没中文句号，不动
  const len = t.length;
  // 短句统一不写句号（人类 87% 如此），只给长段保留——规则简单，风格才统一
  if (len <= 40) {
    t = t.slice(0, -1).trimEnd();
    t = t.replace(/[，,、]$/, "").trimEnd();
  }
  return t;
}

function splitMessage(text, cfg) {
  const t = String(text || "").trim();
  if (!t) return [""];
  if (!cfg.splitReplies) return [t];
  const max = Math.max(1, cfg.maxParts || 3);
  if (t.length <= 90) return [t];
  const chunks = t
    .split(/\n{2,}|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  let parts = chunks;
  if (parts.length <= 1) {
    const sentences = t.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
    if (sentences.length <= 1) return [t];
    const out = [];
    let buf = "";
    for (const sen of sentences) {
      if (out.length >= max - 1) {
        buf += sen;
      } else if (buf.length + sen.length > 80) {
        out.push(buf);
        buf = sen;
      } else {
        buf += sen;
      }
    }
    if (buf) out.push(buf);
    parts = out;
  } else {
    const merged = [parts[0]];
    for (let i = 1; i < parts.length; i++) {
      const last = merged[merged.length - 1];
      if (merged.length < max && last.length + parts[i].length < 70) {
        merged[merged.length - 1] = `${last} ${parts[i]}`;
      } else {
        merged.push(parts[i]);
      }
    }
    parts = merged;
  }
  if (parts.length > max) {
    const head = parts.slice(0, max - 1);
    head.push(parts.slice(max - 1).join(" "));
    parts = head;
  }
  return parts;
}

export { safeSegData, smartCut, stripLoneSurrogates, safeSlice, humanizePunct, splitMessage };
