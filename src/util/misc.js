// 零散工具。

function cleanQzone(text) {
  return String(text || "")
    .trim()
    .replace(/^[，。、；：:!！?？~～…\s"'“”‘’「」【】]+/, "")
    .replace(/["'“”‘’]$/, "")
    .trim();
}

function parrotOf(text, source) {
  const norm = (s) => String(s || "").replace(/[\s，。、；：:!！?？~～…"'“”‘’（）()【】\[\]]/g, "");
  const t = norm(text);
  const s = norm(source);
  if (!t || s.length < 8) return false;
  let hit = 0;
  let tot = 0;
  for (let i = 0; i + 5 <= s.length; i += 3) {
    tot += 1;
    if (t.includes(s.slice(i, i + 5))) hit += 1;
  }
  return tot >= 2 && hit / tot >= 0.55;
}

function extractReply(session, firstSeq) {
  let text = "";
  let error = null;
  // 新版本 DSH：session.snapshotEvents(fromSeq) 返回只读事件数组；
  // 旧版本可能是 session.events 属性。两个都兼容。
  let events = [];
  try {
    if (typeof session.snapshotEvents === "function") {
      events = session.snapshotEvents(firstSeq) ?? [];
    } else if (Array.isArray(session.events)) {
      events = session.events;
    }
  } catch {
    events = [];
  }
  for (const ev of events) {
    if (typeof ev.seq === "number" && ev.seq < firstSeq) continue;
    if (ev.type === "assistant/message") {
      const blocks = ev.data?.message?.content ?? [];
      const joined = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (joined.trim()) text = joined;
    } else if (ev.type === "turn/end") {
      const reason = ev.data?.reason ?? ev.data;
      if (reason?.kind === "error") error = reason.error?.message ?? "agent turn failed";
    }
  }
  if (!text && error) throw new Error(error);
  return text;
}

function textOverlaps(a, b) {
    try {
      const norm = (x) => String(x || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
      const A = norm(a);
      const B = norm(b);
      if (A.length < 4 || B.length < 4) return false;
      const grams = new Set();
      for (let i = 0; i < B.length - 1; i++) grams.add(B.slice(i, i + 2));
      let hit = 0;
      for (let i = 0; i < A.length - 1; i++) {
        if (grams.has(A.slice(i, i + 2))) hit += 1;
      }
      return hit / Math.max(1, A.length - 1) >= 0.2;
    } catch {
      return false;
    }
  }

function parseDuration(text, fallbackMs) {
    const t = String(text || "");
    const h = t.match(/(\d+|半|一|两|二|三)\s*(小时|时)/);
    const m = t.match(/(\d+)\s*(分钟|分)/);
    const cn = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3 };
    if (h) return (Number(h[1]) || cn[h[1]] || 1) * 3600000;
    if (m) return Number(m[1]) * 60000;
    return fallbackMs;
  }

function timeContext() {
    const now = new Date();
    const h = now.getHours();
    const mi = String(now.getMinutes()).padStart(2, "0");
    const wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    const weekend = now.getDay() === 0 || now.getDay() === 6;

    let mood;
    if (h >= 1 && h < 6) {
      mood = "凌晨了，你基本睡了，被叫到只敷衍一句，别展开聊。";
    } else if (h >= 23) {
      mood = "夜深了，但你还挺精神（你是夜猫子），正常聊就行，只是别太亢奋。";
    } else if (h < 9) {
      mood = "早上刚醒，精神一般，话不多。";
    } else if (h < 12) {
      mood = "上午，精神不错。";
    } else if (h < 14) {
      mood = "中午，有点困。";
    } else if (h < 18) {
      mood = "下午，正常状态。";
    } else {
      mood = "晚上，比较放松。";
    }
    return `[现在是 周${wd} ${String(h).padStart(2, "0")}:${mi}${weekend ? "（周末）" : ""}] ${mood}`;
  }

function extractRealInbound(raw) {
    const t = String(raw || "").trim();
    if (!t) return "";

    // ⚠️ 顺序很重要：先尝试提取真实消息，再判断是不是纯内部提示。
    // 因为真实的私聊 prompt 长这样：
    //   （QQ 聊天场景：像真人发消息一样简短…）
    //   [QQ私聊] 竹叶不知秋：你好
    // 开头是「（QQ 聊天」，但里面确实有真人说的话。
    const m1 = t.match(/\[消息内容\]\s*([\s\S]*?)(?:\n\[|\n（QQ |\n（内部|\n（这次|$)/);
    if (m1 && m1[1].trim()) {
      // 再兜一层：切掉可能残留的内部提示
      let out = m1[1].trim();
      out = out.split(/\n（QQ 聊天/)[0].split(/\n（内部/)[0].split(/\n（这次/)[0];
      return out.trim().slice(0, 8000);
    }

    const m3 = t.match(/\[(?:QQ群消息|QQ私聊|网页聊天|网页聊天·助手代发)\][^：:\n]*[：:]\s*([\s\S]*)/);
    if (m3 && m3[1].trim()) {
      let out = m3[1].trim();
      out = out.split(/\n（QQ 聊天/)[0].split(/\n（内部/)[0];
      return out.trim().slice(0, 8000);
    }

    // DSH 自己注入的运行时说明，不是人说的话
    if (/^(Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding|Current runtime context|Current DSH file policy|Approval prompts are disabled|Current DeepSeek Harness implementation checkout|Current working directory)/i.test(t)) {
      return "";
    }
    if (/Time sampled while preparing|Browser time zone for this request|Current runtime context\. This snapshot supersedes/i.test(t) && t.length < 1200) {
      return "";
    }

    // 到这里说明没提取到真实消息 —— 再看是不是纯内部提示
    if (/^（(内部|这次|对方连着|QQ 聊天|你在|这是你|刚才|下面|想一想)/.test(t)) return "";
    if (
      /内部整理|内部反思|内部回顾|内部探索|不要发消息|不发给任何人|只输出/.test(t) &&
      t.length < 200
    ) {
      return "";
    }
    // 活动产出（JSON 计划之类）也不是对话
    if (/^\s*\{\s*"looked"/.test(t)) return "";

    // 兜底前先排掉 prompt 模板（这些不是人说的话）
    if (
      /（QQ 聊天[:：]|（QQ私聊[:：]|像真人发消息|长度要有变化|不要用 markdown|不要复述我的问题|只输出|不要发消息|点了智慧会发/.test(
        t,
      )
    ) {
      return "";
    }
    // 看起来就是正常对话
    if (t.length <= 400 && !/\[消息内容\]|\[群聊最近|\[你想起的\]|\[你自己的话\]/.test(t)) {
      return t;
    }
    return "";
  }

function makeEvent(kind, source, payload) {
    return {
      id: "evt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      kind,
      at: Date.now(),
      source: source || {},
      payload: payload || {},
      status: "unread",
    };
  }

function eventTarget(e) {
    const src = e?.source || {};
    const kind = e?.kind || "";
    const isGroup = src.type === "group" || kind === "mentioned" || kind === "replied" || kind === "quiet_group";
    if (isGroup) {
      const gid = Number(src.groupId);
      if (!gid) return null;
      return { message_type: "group", group_id: gid, user_id: Number(src.userId) || 0 };
    }
    if (kind === "private_message") {
      const uid = Number(src.userId);
      if (!uid) return null;
      const ev = { message_type: "private", user_id: uid };
      // 群临时会话：来源群必须带上，否则 send_private_msg 发不出去
      if (src.originGroup) ev.__groupTemp = Number(src.originGroup);
      return ev;
    }
    return null;
  }

function WAKE_KEY() {
    const h = new Date();
    return "self:main-" + h.getFullYear() + String(h.getMonth() + 1).padStart(2, "0") +
      String(h.getDate()).padStart(2, "0") + "-" + String(h.getHours()).padStart(2, "0");
  }

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

export function createMisc(app = {}) {
  const {} = app;
  function textOfEvent(ev) {
      try {
        if (ev.type === "user/message") {
          const blocks = ev.data?.content ?? [];
          const raw = blocks
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
            .trim();
          // 桥发给她的 prompt 也记成 user/message，里面混着内部提示词。
          // 真正的对方消息在这里面：[消息内容] xxx 或 [QQ私聊] 名字：xxx
          const real = extractRealInbound(raw);
          if (!real) return { text: "", role: "" }; // 纯内部提示，不收
          // 把「谁说的」也带上——不然「搜某人 QQ 号」永远搜不到，
          // 因为 extractRealInbound 的正则会把「发言人 149（100000004）」整段吃掉。
          let speaker = "";
          const mg = raw.match(
            /\[QQ群消息\][^\n]*?发言人\s*([^：:\n]+)[：:]/,
          );
          if (mg) speaker = mg[1].trim();
          else {
            const mp = raw.match(
              /\[(?:QQ私聊|网页聊天|网页聊天·助手代发)\]\s*([^：:\n]+)[：:]/,
            );
            if (mp) speaker = mp[1].trim();
          }
          const text = speaker ? speaker + "：" + real : real;
          return { text, role: "对方", speaker, raw: real };
        }
        if (ev.type === "assistant/message") {
          const blocks = ev.data?.message?.content ?? [];
          const text = blocks
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
            .trim();
          return { text, role: "我", speaker: "我", raw: text };
        }
      } catch {
        // 忽略
      }
      return { text: "", role: "" };
    }

  return { textOfEvent };
}

export { cleanQzone, parrotOf, extractReply, textOverlaps, parseDuration, timeContext, extractRealInbound, makeEvent, eventTarget, WAKE_KEY, todayKey };
