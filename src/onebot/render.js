// 消息记录渲染成一行文字。

function recTag(t) {
  const T = {
    video: "视频",
    record: "语音",
    audio: "语音",
    json: "卡片",
    xml: "卡片",
    share: "链接卡片",
    music: "音乐",
    location: "位置",
    contact: "名片",
    poke: "戳一戳",
    mface: "表情",
    markdown: "卡片",
    ark: "卡片",
  };
  return T[String(t)] || String(t || "未知");
}

function renderMsgRec(r) {
  if (!r || typeof r !== "object") return "";
  const d = new Date((Number(r.t) || 0) * 1000);
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  let s = `[${hm}] ${String(r.n || r.u || "某人")}：${String(r.x || "")}`;
  if (Array.isArray(r.img) && r.img.length) s += ` ［图×${r.img.length}］`;
  if (r.fw) s += ` ［转发×${Number(r.fw.n) || 1}］`;
  if (Array.isArray(r.files) && r.files.length) {
    s += ` ［文件:${String(r.files[0]?.name || "").slice(0, 20)}］`;
  }
  if (Array.isArray(r.unk) && r.unk.length) {
    s += r.unk.slice(0, 3).map((u) => `［${recTag(u?.t)}］`).join("");
  }
  if (r.atMe) s += " （@你）";
  if (r.qid) s += ` ↩︎${String(r.qid).slice(-6)}`;
  return s;
}

export { recTag, renderMsgRec };
