// 把「程序错误」从「网络抖动」里拎出来。
//
// 项目里 500 多个 catch 大多是为了不让一次失败拖垮整个回合。但它们把
// ReferenceError / TypeError 也一起吞了 —— 那两类不是抖动，是代码写错了，
// 吞掉之后功能会静默失效，几年都没人知道（比如 draw_svg 挂了两天）。
//
// 这里不拦不抛，只在边界上把它们记成一条 warn，并累计次数。
const counts = new Map();
const KEYS = new Set(["ReferenceError", "TypeError", "SyntaxError"]);

export function noteError(err, where = "") {
  try {
    const name = String(err?.name || "");
    if (!KEYS.has(name)) return false;
    const key = `${name}@${where}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    const first = String(err?.stack || err?.message || "").split("\n").slice(0, 2).join(" | ");
    return { key, count: counts.get(key), first };
  } catch {
    return false;
  }
}

export function errorSummary() {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, n]) => `${k}×${n}`);
}
