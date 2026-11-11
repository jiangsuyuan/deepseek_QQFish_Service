// 统一的「图在哪」定位逻辑。
//
// 背景：看图和存图以前各写一套坐标系——
//   look_image    认 messageId / url / 附近有图的候选
//   save_sticker  只认"这一轮"和"5 分钟内的上一条"
// 结果她看得到、存不到（2026-11-11 那次）。
//
// 这个模块只做一件事：给一个频道 + 一些线索，返回那张图。
//   url > messageId > 这一轮她看到的 > 最近一次带图消息
/**
 * 会话条目 → 消息日志的键（group:xxx / private:xxx）
 * 注意：entry.key 是分段会话键（conv:group:1:3），跟消息日志不是一套。
 * 2026-11-11 存表情失败就是这里用错了键。
 */
export function channelKeyOfEntry(entry) {
  const t = entry?.lastTarget;
  if (!t) return "";
  if (String(t.message_type) === "group" && t.group_id) return "group:" + String(t.group_id);
  if (String(t.message_type) === "private" && t.user_id) return "private:" + String(t.user_id);
  return "";
}

export function createImageLocator({ findMsgInLog, logger } = {}) {
  /** 按消息 id 找这条消息里的第 which 张图 */
  function byMessageId(key, messageId, which = 1) {
    const id = String(messageId || "").trim();
    if (!id) return { ok: false, reason: "没给 messageId" };
    const rec = key && typeof findMsgInLog === "function" ? findMsgInLog(key, id) : null;
    if (!rec) return { ok: false, reason: `找不到 #${id} 这条消息` };
    const imgs = Array.isArray(rec.img) ? rec.img : [];
    if (!imgs.length) return { ok: false, reason: `#${id} 这条里没有图` };
    const i = Math.max(0, Math.min(imgs.length - 1, Number(which || 1) - 1));
    return {
      ok: true,
      raw: imgs[i],
      index: i + 1,
      total: imgs.length,
      from: `#${rec.id || id}${rec.n ? " · " + rec.n : ""}`,
    };
  }

  /** 这一轮她看到的图（进回合时记下的） */
  function fromTurn(entry, which = 1) {
    const seen = Array.isArray(entry?.currentTurnImages) ? entry.currentTurnImages : [];
    if (!seen.length) return { ok: false, reason: "这一轮没有图" };
    const i = Math.max(0, Math.min(seen.length - 1, Number(which || 1) - 1));
    return { ok: true, raw: seen[i], index: i + 1, total: seen.length, from: "这一轮" };
  }

  /** 最近一次带图消息（5 分钟内有效） */
  function fromLast(entry, which = 1) {
    const list = Array.isArray(entry?.lastImages) ? entry.lastImages : [];
    if (!list.length) return { ok: false, reason: "没有最近的图" };
    const age = Date.now() - Number(entry?.lastImagesAt || 0);
    if (age > 5 * 60_000) return { ok: false, reason: "最近那张图有点久了（超过 5 分钟）" };
    const i = Math.max(0, Math.min(list.length - 1, Number(which || 1) - 1));
    return { ok: true, raw: list[i], index: i + 1, total: list.length, from: "刚才那条" };
  }

  /**
   * 统一入口。
   * @returns {{ok:boolean, raw?:any, from?:string, reason?:string, candidates?:string[]}}
   */
  function locate({ key, entry, messageId, url, which = 1 }) {
    if (url) return { ok: true, raw: { url: String(url) }, index: 1, total: 1, from: "你给的地址" };
    if (messageId) {
      const r = byMessageId(key, messageId, which);
      if (r.ok) return r;
      // 这条没图：把可能的原因带回去，别只说"没有"
      return { ok: false, reason: r.reason, candidates: [] };
    }
    const t = fromTurn(entry, which);
    if (t.ok) return t;
    const l = fromLast(entry, which);
    if (l.ok) return l;
    return { ok: false, reason: "这一轮没有图，最近那条也过期了；给我 messageId 或者让我重新看一次" };
  }

  return { locate, byMessageId, fromTurn, fromLast };
}
