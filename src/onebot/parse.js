// OneBot 消息解析：CQ 码、消息段、@ 与引用。
import { safeSegData } from "../util/text.js";
import { createHash } from "node:crypto";

function conversationKey(ev) {
  return ev.message_type === "group" ? `group:${ev.group_id}` : `private:${ev.user_id}`;
}

function sessionIdBase(key) {
  return `ob-${createHash("sha256").update(`dsh-onebot-bridge\0${key}`).digest("hex").slice(0, 12)}`;
}

const SEG_LABEL = {
  video: "视频",
  record: "语音",
  audio: "语音",
  json: "卡片",
  xml: "卡片",
  markdown: "卡片",
  light_app: "卡片",
  ark: "卡片",
  share: "链接卡片",
  music: "音乐",
  location: "位置",
  contact: "名片",
  poke: "戳一戳",
  dice: "骰子",
  rps: "猜拳",
  shake: "窗口抖动",
  mface: "表情",
  face: "表情",
};

function parseCqString(raw, selfId) {
  const unesc = (s) =>
    String(s)
      .replace(/&#91;/g, "[")
      .replace(/&#93;/g, "]")
      .replace(/&#44;/g, ",")
      .replace(/&amp;/g, "&");
  const images = [];
  const replyIds = [];
  const mentions = [];
  let hasAt = false;
  const re = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gi;
  let m;
  while ((m = re.exec(raw))) {
    const kind = String(m[1] || "").toLowerCase();
    const attrs = String(m[2] || "");
    const pick = (k) => {
      const mm = attrs.match(new RegExp("(?:^|,)" + k + "=([^,]*)"));
      return mm ? unesc(mm[1]) : "";
    };
    if (kind === "at") {
      const qq = pick("qq");
      if (qq === "all" || qq === String(selfId)) hasAt = true;
      else if (qq) mentions.push({ qq, name: unesc(pick("name")) });
    } else if (kind === "image") {
      images.push({ url: unesc(pick("url") || pick("file")), file: unesc(pick("file")), summary: "" });
    } else if (kind === "reply") {
      const rid = unesc(pick("id"));
      if (rid) replyIds.push(rid);
    }
  }
  const text = unesc(raw.replace(/\[CQ:[^\]]*\]/gi, "")).trim();
  return { text: text || (images.length ? "[图片]" : ""), hasAt, images, forwards: [], files: [], replyIds, replySummary: "", mentions, unk: [] };
}

function parseMessage(ev, selfId) {
  try {
    const segs = Array.isArray(ev?.message) ? ev.message : [];
    if (!segs.length && typeof ev?.message === "string" && ev.message) {
      return parseCqString(ev.message, selfId);
    }
    let text = "";
    let hasAt = false;
    const images = [];
    const forwards = [];
    const files = [];
    const replyIds = [];
    const mentions = [];
    const unk = [];
    let replySummary = "";
    for (const seg of segs) {
      if (!seg || typeof seg !== "object") continue;
      const type = String(seg.type || "");
      const data = seg.data && typeof seg.data === "object" ? seg.data : {};
      try {
        if (type === "text") {
          text += String(data.text ?? "");
        } else if (type === "at") {
          const atQq = String(data.qq ?? "").trim();
          const atName = String(data.name ?? data.card ?? "").trim();
          if (atQq && atQq !== "all" && atQq !== String(selfId)) mentions.push({ qq: atQq, name: atName });
          if (atQq === "all" || atQq === String(selfId)) hasAt = true;
          // 把 @ 的人名也加进文本——不然「你还记得@风声 么」会变成「你还记得 么」，
          // 人名丢了，recall 搜不到，她还以为「那边什么都没有」。
          if (atName) {
            text += "@" + atName + " ";
          } else if (atQq && atQq !== String(selfId) && atQq !== "all") {
            // 有的客户端不给昵称，退化成 QQ 号也比丢掉强
            text += "@" + atQq + " ";
          }
        } else if (type === "image") {
          const imgUrl = String(data.url || data.file || "");
          const imgFile = String(data.file || "");
          if (imgUrl || imgFile) {
            images.push({
              url: imgUrl,
              file: imgFile,
              summary: String(data.summary || ""),
            });
          }
        } else if (type === "reply") {
          const rid = String(data.id ?? data.message_id ?? "");
          if (rid) replyIds.push(rid);
          // 摘要文本：拿不到原消息时至少知道引用了啥
          const sum = String(data.content ?? data.summary ?? "").trim();
          if (sum) replySummary = sum.slice(0, 120);
        } else if (type === "face") {
          text += "";
        } else if (type === "forward") {
          const id = String(data.id ?? data.message_id ?? data.resid ?? "");
          forwards.push({ id, rawKeys: Object.keys(data), raw: data });
        } else if (type === "file") {
          files.push({
            id: String(data.file_id ?? data.id ?? data.file ?? ""),
            busid: data.busid,
            name: String(data.name ?? data.file_name ?? data.file ?? "文件"),
            size: Number(data.file_size ?? data.size ?? 0),
          });
        } else {
          // 不认识的段（视频/语音/红包卡片/位置/未来新类型…）：原样留下，绝不抛
          unk.push({ t: type || "unknown", d: safeSegData(data) });
        }
      } catch {
        unk.push({ t: type || "unknown", d: "" });
      }
    }
    text = text.trim();
    if (images.length > 0 && !text) text = "[图片]";
    // 只剩占位（视频/语音/红包）：给她一个能读懂的字，而不是空
    if (!text && unk.length) {
      const tags = unk.map((u) => SEG_LABEL[u.t] || u.t).filter(Boolean).slice(0, 3);
      text = tags.map((t) => "［" + t + "］").join("");
    }
    return { text, hasAt, images, forwards, files, replyIds, replySummary, mentions, unk };
  } catch (err) {
    // 解析层最后一道闸：宁可这条为空，也不能炸掉整条消息流
    return {
      text: "",
      hasAt: false,
      images: [],
      forwards: [],
      files: [],
      replyIds: [],
      replySummary: "",
      mentions: [],
      unk: [],
      parseError: String(err?.message ?? err).slice(0, 120),
    };
  }
}

export { conversationKey, sessionIdBase, SEG_LABEL, parseCqString, parseMessage };
