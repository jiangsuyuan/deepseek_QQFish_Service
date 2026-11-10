// 判"这条是不是聊完了"：低信息量回执、纯表情、纯标点。
// 用途：对方只回了个"嗯"，这一段就该结束了，别再把她叫起来。
const WORD = /^(嗯+|哦+|喔+|好+|行|对|是|收到|谢谢|谢|哈哈+|hhh+|666|6|草|笑死|ok|okay|行吧|可以|可能|也许|\+1|1|喵|耶|啊这)$/i;

export function isPerfunctory(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length > 4) return false;
  if (WORD.test(t)) return true;
  // 纯表情 / 纯标点 / 只有一个问号
  if (/^[\p{Emoji}\p{P}\p{S}\s]+$/u.test(t)) return true;
  return false;
}
