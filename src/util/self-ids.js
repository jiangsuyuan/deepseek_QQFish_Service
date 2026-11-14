// 「哪些号是我」。
// 换号之后旧号的发言仍是她自己说的——判断自己的消息不能只认当前 selfId。
export function selfIdList(cfg) {
  const cur = String(cfg?.selfId ?? "").trim();
  const list = Array.isArray(cfg?.selfIds) ? cfg.selfIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (cur && !list.includes(cur)) list.push(cur);
  return list;
}

export function isSelf(cfg, uid) {
  const u = String(uid ?? "").trim();
  if (!u) return false;
  return selfIdList(cfg).includes(u);
}

export function isSelfAt(cfg, qq) {
  const q = String(qq ?? "").trim();
  if (!q) return false;
  if (q === "all") return true;
  return selfIdList(cfg).includes(q);
}
