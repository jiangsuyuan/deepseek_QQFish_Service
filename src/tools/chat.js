import { audit } from "../core/audit.js";
import { sleep } from "../util/time.js";
import { pickSticker } from "../features/stickers.js";
import { findMsgInLog, readMsgLog, listMsgKeys, appendMsgRec } from "../store/msglog.js";
import { parseMessage } from "../onebot/parse.js";
import { renderMsgRec } from "../onebot/render.js";
// 收发消息类工具。

export function registerChatTools(app) {
  const { cfg, client, logger, pushLen, sessions, state, pluginCtx: ctx } = app;
  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "at_person",
            description:
              "在群里 @ 某个人并说一句话。只在确实必要时用：对话直接涉及他、他说的话被晾着需要回应、" +
              "或者你确实需要他回答。不要为了引人注意而 @，不要 @ 不熟的人，也不要连着 @ 好几次。" +
              "普通聊天直接说话就行，不需要 @。",
            parameters: {
              target: { type: "string", description: "可选，group:群号。不填用当前会话" },
              qq: { type: "string", description: "要 @ 的 QQ 号（从群消息里看到的发言人号码）" },
              text: { type: "string", description: "要说的话，30 字以内，自然一点" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              // 优先用参数里的 target（self:main 那种 session 拿不到 lastTarget）
              const explicit = String(args?.target ?? "").trim();
              let target = null;
              if (explicit.startsWith("group:")) {
                target = { message_type: "group", group_id: Number(explicit.slice(6)), user_id: 0 };
              } else {
                const sid = String(exec?.agent?.session?.id ?? "");
                const entry = sid ? sessions.bySessionId(sid) : null;
                target = entry?.lastTarget ?? null;
              }
              if (!target || target.message_type !== "group") {
                return { ok: false, reason: "需要在群里 @ 人——target 填 group:群号" };
              }
              const qq = String(args?.qq ?? "").trim();
              const text = String(args?.text ?? "").trim().slice(0, 60);
              if (!/^\d{5,12}$/.test(qq) || !text) {
                return { ok: false, reason: "qq 或 text 不合法" };
              }
              const now = Date.now();
              state.atPersonTimes = state.atPersonTimes.filter((t) => now - t < 3600_000);
              const limit = Number(cfg.atPersonPerHour) || 3;
              if (state.atPersonTimes.length >= limit) {
                return { ok: false, reason: `本小时 @ 的次数已用完（上限 ${limit} 次）` };
              }
              try {
                await client.sendGroupAt(String(target.group_id), qq, text);
                state.atPersonTimes.push(now);
                audit({ kind: "at_person", groupId: String(target.group_id), qq, text });
                logger.info?.(`[onebot] @ 了 ${qq}：${text.slice(0, 40)}`);
                return { ok: true, sent: text, remaining: limit - state.atPersonTimes.length };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );
        logger.info?.("[onebot] @ 人工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] @ 人工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      const faceTimes = [];
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "send_face",
            description:
              "发一个 QQ 原生小黄脸（聊天框里那种黄脸），情绪到位时才用，平时少发。" +
              "常用编号：14微笑 13呲牙 21可爱 20偷笑 22白眼 27流汗 26惊恐 10尴尬 12调皮 16酷 " +
              "9大哭 6害羞 4得意 11发怒 15难过 32疑问 18抓狂 25困 76赞 79胜利 5流泪 30奋斗。" +
              "只想在文字中间夹一个的话，直接在回复里写 [face:13] 就行，不用调这个工具。",
            parameters: {
              id: { type: "number", description: "小黄脸编号，比如 13（呲牙）、21（可爱）" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const sid = String(exec?.agent?.session?.id ?? "");
              const entry = sid ? sessions.bySessionId(sid) : null;
              const target = entry?.lastTarget;
              if (!target || (!target.group_id && !target.user_id)) {
                return { ok: false, reason: "当前没有 QQ 会话上下文" };
              }
              const id = Math.max(0, Math.min(400, Number(args?.id) || 0));
              const now = Date.now();
              while (faceTimes.length && now - faceTimes[0] > 3600_000) faceTimes.shift();
              const perHour = Number(cfg.facePerHour) || 6;
              if (faceTimes.length >= perHour) {
                return { ok: false, reason: "小黄脸发得有点多了，缓缓" };
              }
              if (faceTimes.length && now - faceTimes[faceTimes.length - 1] < 60_000) {
                return { ok: false, reason: "刚发过一个，先别连着发" };
              }
              const seg = [{ type: "face", data: { id: String(id) } }];
              await client.call(
                target.message_type === "group" ? "send_group_msg" : "send_private_msg",
                target.message_type === "group"
                  ? { group_id: target.group_id, message: seg }
                  : { user_id: target.user_id, message: seg },
              );
              faceTimes.push(now);
              audit({ kind: "face", id });
              return { ok: true, id };
            },
          }),
        );
        logger.info?.("[onebot] 小黄脸工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 小黄脸工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "qq_send",
            description:
              "主动发一句话到某个群或私聊。想说话的时候用——不用等别人叫你。\n\n" +
              "**target 和 text 都必须填**，不然发不出去。\n" +
              "target 格式：group:群号 或 private:QQ号（从事件里抄）。\n" +
              "可以带 sticker 参数，发完文字顺便补一张表情（大笑/无语/生气/委屈/震惊/开心/睡觉/random）。\n" +
              "例：qq_send({ target: \"group:123456789\", text: \"这个我也在想\" })",
            parameters: {
              target: {
                type: "string",
                description: "group:群号 或 private:QQ号。**从事件的 target: 行里抄**，不要填昵称",
              },
              text: { type: "string", description: "要说的话" },
              sticker: { type: "string", description: "可选，发完文字补一张表情" },
              quote: { type: "string", description: "可选，引用某条消息的 id" },
              groupTemp: {
                type: "number",
                description: "可选。群临时会话（群友私聊、非好友）要填来源群号",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const target = String(args?.target ?? "").trim();
              const text = String(args?.text ?? "").trim();
              if (!target || !text) return { ok: false, reason: "target 和 text 都要" };
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };
              // 目标来源校验：和本回合来源不一致时记一笔（不拦，但能追出「回错群」）
              let crossFrom = "";
              try {
                const sid0 = String(exec?.agent?.session?.id ?? "");
                const ent0 = sid0 ? sessions.bySessionId(sid0) : null;
                const origin0 = ent0?.turnOriginKey || "";
                if (origin0 && origin0 !== target) {
                  crossFrom = origin0;
                  logger.info?.(`[onebot] 跨会话发送：${origin0} → ${target}`);
                  audit({ kind: "cross_group_send", from: origin0, to: target, text: text.slice(0, 80) });
                }
              } catch {
                // 拿不到就放行
              }

              let ev;
              if (target.startsWith("group:")) {
                ev = { message_type: "group", group_id: Number(target.slice(6)), user_id: 0 };
              } else if (target.startsWith("private:")) {
                ev = { message_type: "private", user_id: Number(target.slice(8)) };
                const gt = Number(args?.groupTemp) || 0;
                if (gt > 0) ev.__groupTemp = gt;
              } else {
                return { ok: false, reason: "target 要写成 group:xxx 或 private:xxx" };
              }
              if (args?.quote) ev.message_id = String(args.quote);

              // 文字和表情分开结算。
              // 以前表情失败会把整条甩进 catch、返回 ok:false —— 文字明明已经出去了，
              // 她以为整条没发，再发一遍，群里就出现重复。
              try {
                const hres = await client.sendHuman(ev, text, { force: true });
                if (hres?.duplicate) {
                  return { ok: true, duplicate: true, note: hres.note || "这条已经发过了。" };
                }
              } catch (err) {
                return { ok: false, sent: false, reason: "文字没发出去：" + String(err?.message ?? err) };
              }

              let stickerSent = null;
              let stickerErr = "";
              if (args?.sticker) {
                try {
                  const mood = String(args.sticker);
                  const picked = pickSticker(cfg.stickerDir, mood === "random" ? "" : mood);
                  if (!picked) {
                    stickerErr = "表情库里没挑到 " + mood;
                  } else {
                    await sleep(400 + Math.random() * 600);
                    await client.sendImage(ev, picked.path);
                    stickerSent = mood;
                  }
                } catch (err) {
                  // 明确写清「文字已经发了」，不然她看到失败就想重发
                  stickerErr = "表情没发出去（文字已经发了，别再发一遍）：" +
                    String(err?.message ?? err).slice(0, 80);
                }
              }
              audit({ kind: "send_message", target, text: text.slice(0, 120), sticker: stickerSent, stickerErr });
              return { ok: true, sent: true, target, stickerSent, stickerErr: stickerErr || undefined };
            },
          }),
        );

        reg(
          defineTool({
            name: "reply_to",
            description:
              "回复某一条具体的消息（带引用）。\n" +
              "**target 必填**，从事件的 `target:` 行原样抄（group:群号 / private:QQ号）。\n" +
              "如果是「群临时会话」（群友私聊、不是好友），还要带上事件里给的 groupTemp。\n" +
              "不要凭印象填 target——填错就发给别人了。",
            parameters: {
              target: {
                type: "string",
                description: "group:群号 或 private:QQ号。从事件的 target: 行抄",
              },
              messageId: { type: "string", description: "要回复的消息 id（从事件抄）" },
              text: { type: "string", description: "回复内容" },
              groupTemp: {
                type: "number",
                description: "可选。群临时会话要填来源群号（事件里会写）",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const target = String(args?.target ?? "").trim();
              const mid = String(args?.messageId ?? "").trim();
              const text = String(args?.text ?? "").trim();
              const groupTemp = Number(args?.groupTemp) || 0;
              if (!target) return { ok: false, reason: "target 必填（从事件的 target: 行抄）" };
              if (!text) return { ok: false, reason: "text 不能空" };
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };

              let ev;
              if (target.startsWith("group:")) {
                ev = { message_type: "group", group_id: Number(target.slice(6)), user_id: 0 };
              } else if (target.startsWith("private:")) {
                ev = { message_type: "private", user_id: Number(target.slice(8)) };
                if (groupTemp > 0) ev.__groupTemp = groupTemp;
              } else {
                return { ok: false, reason: "target 要写成 group:xxx 或 private:xxx" };
              }
              // 只有真 QQ 消息 id 才当引用（webui- 开头的是网页内部 id）
              if (mid && mid !== "0" && mid.length > 5 && !/^webui-/.test(mid)) {
                ev.message_id = mid;
              }
              try {
                const hres = await client.sendHuman(ev, text, { force: true, quote: !!ev.message_id });
                if (hres?.duplicate) {
                  return { ok: true, duplicate: true, note: hres.note || "这条已经回过了。" };
                }
                audit({
                  kind: "reply_to",
                  target,
                  groupTemp: groupTemp || undefined,
                  messageId: mid,
                  text: text.slice(0, 120),
                  len: text.length,
                });
                // 长度自我参照的数据源：现在她的发言几乎都走这个工具
                pushLen(text.length);
                return { ok: true, target, messageId: mid };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          }),
        );

        logger.info?.("[onebot] 出站工具已注册（qq_send / reply_to）");
      } catch (err) {
        logger.warn?.("[onebot] 出站工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "send_private",
            description:
              "主动给某个好友发私聊。想找谁说话的时候用——不用等他先开口。\n" +
              "qq 填好友的 QQ 号，不是昵称。只在好友列表里的人能发。\n" +
              "跟 qq_send 的 private:xxx 是同一件事，但这个更直接（不用拼 target）。",
            parameters: {
              qq: { type: "string", description: "对方的 QQ 号" },
              text: { type: "string", description: "要说的话" },
              groupTemp: {
                type: "number",
                description: "可选。群临时会话（群友私聊、非好友）要填来源群号，否则发不出去",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const qq = String(args?.qq ?? "").trim();
              const text = String(args?.text ?? "").trim();
              const groupTemp = Number(args?.groupTemp) || 0;
              if (!/^\d{5,12}$/.test(qq)) return { ok: false, reason: "qq 不合法" };
              if (!text) return { ok: false, reason: "text 不能空" };
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };

              // 群临时会话：群友私聊，走 send_group_temp_msg（send_private_msg 对非好友会失败）
              if (groupTemp > 0) {
                try {
                  await client.call(
                    "send_group_temp_msg",
                    {
                      group_id: Number(groupTemp),
                      user_id: Number(qq),
                      message: [{ type: "text", data: { text } }],
                    },
                    15000,
                  );
                  audit({ kind: "send_private_temp", qq, groupTemp, text: text.slice(0, 120) });
                  return { ok: true, qq, groupTemp, temp: true, sent: true };
                } catch (err) {
                  return { ok: false, reason: "群临时会话发送失败：" + String(err?.message ?? err) };
                }
              }

              // 确认是好友（不给陌生人发）
              try {
                const fl = await client.call("get_friend_list", {}, 10000);
                const list = Array.isArray(fl) ? fl : [];
                const isFriend = list.some((f) => String(f?.user_id ?? "") === qq);
                if (!isFriend) {
                  return {
                    ok: false,
                    reason:
                      "这个号不在好友列表里。如果是群友私聊（群临时会话），要带 groupTemp: 来源群号。",
                  };
                }
              } catch {
                // 查不到好友列表就放行（别因为接口抽风卡住）
              }

              try {
                const pres = await client.sendPrivate(qq, text);
                if (pres?.duplicate) {
                  return { ok: true, duplicate: true, note: pres.note || "这条已经发过了。" };
                }
                if (String(qq) === String(cfg?.ownerId ?? "")) {
                  try {
                    client.onWebReply?.(text, "qq");
                  } catch {
                    // 忽略
                  }
                }
                audit({ kind: "send_private", qq, text: text.slice(0, 120) });
                return { ok: true, qq, sent: true };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          }),
        );

        logger.info?.("[onebot] 主动社交工具已注册（send_private）");
      } catch (err) {
        logger.warn?.("[onebot] 主动社交工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);
        const TOOL_OUT = {
          schema: { type: "json" },
          render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
        };

        const currentGroup = (exec) => {
          try {
            const sid = String(exec?.agent?.session?.id ?? "");
            const entry = sid ? sessions.bySessionId(sid) : null;
            const t = entry?.lastTarget;
            if (!t) return "";
            if (String(t.message_type) === "group" && t.group_id) return "group:" + String(t.group_id);
            if (String(t.message_type) === "private" && t.user_id) return "private:" + String(t.user_id);
            return "";
          } catch {
            return "";
          }
        };
        const pickGid = (args, exec) => String(args?.group || currentGroup(exec) || "").trim();

        const cqText = (s) =>
          String(s || "")
            .replace(/\[CQ:[^\]]*\]/g, "")
            .replace(/&#91;/g, "[")
            .replace(/&#93;/g, "]")
            .replace(/&#44;/g, ",")
            .trim();

        reg(
          defineTool({
            name: "read_message",
            description:
              "看某一条群消息的完整内容：谁说的、正文、@ 了谁、引用了谁（带被引用的原文）、几张图、有没有合并转发。\n" +
              "只给 id 就行，默认在当前群找；跨群要带 group。本地没有会去 QQ 要原文。",
            parameters: {
              id: { type: "string", description: "消息 id" },
              group: { type: "string", description: "群号（可选，默认当前群）" },
            },
            output: TOOL_OUT,
            execute: async (args, exec) => {
              try {
                const gid = pickGid(args, exec);
                const id = String(args?.id || "").trim();
                if (!id) return { ok: false, reason: "要填消息 id" };
                if (!gid) return { ok: false, reason: "不知道是哪个群，带个 group" };
                const rec = findMsgInLog(gid, id);
                if (rec) {
                  const q = rec.qid ? findMsgInLog(gid, rec.qid) : null;
                  return {
                    ok: true,
                    group: gid,
                    source: "本地记录",
                    text: renderMsgRec(rec),
                    message: rec,
                    quoted: q ? { id: q.id, from: q.n, text: String(q.x || "").slice(0, 200) } : null,
                  };
                }
                const r = await client.call("get_msg", { message_id: Number(id) || id }, 8000);
                const segs = Array.isArray(r?.message) ? r.message : [];
                // 本地没有：把 QQ 原文按同一套解析（保图/转发/引用），再回填到本地记录
                const pseudo = parseMessage(
                  {
                    message: segs,
                    message_type: String(gid).startsWith("private:") ? "private" : "group",
                    group_id: String(gid).startsWith("private:") ? undefined : String(gid).replace(/^group:/, ""),
                    user_id: r?.sender?.user_id,
                    time: r?.time,
                    message_id: id,
                    sender: r?.sender,
                  },
                  cfg.selfId,
                );
                const rec2 = {
                  v: 1,
                  id: String(id),
                  k: String(gid),
                  n: String(r?.sender?.card || r?.sender?.nickname || "").slice(0, 40),
                  u: String(r?.sender?.user_id || ""),
                  t: Number(r?.time) || Math.floor(Date.now() / 1000),
                  x: String(pseudo.text || "").slice(0, 500),
                  atMe: pseudo.hasAt ? 1 : 0,
                  img: (pseudo.images || []).slice(0, 4),
                  unk: (pseudo.unk || []).slice(0, 5),
                };
                if (pseudo.forwards?.length) rec2.fw = { id: String(pseudo.forwards[0].id || ""), n: 1 };
                if (pseudo.replyIds?.[0]) rec2.qid = String(pseudo.replyIds[0]);
                if (pseudo.files?.length) rec2.files = pseudo.files.slice(0, 5);
                try {
                  rec2.d = "i";
                  rec2.k = "group:" + gid;
                  rec2.g = gid;
                  appendMsgRec("group:" + gid, rec2);
                } catch {
                  // 回填失败不影响返回
                }
                return {
                  ok: true,
                  group: gid,
                  source: "QQ 原文",
                  text: renderMsgRec(rec2),
                  message: rec2,
                  hint: rec2.fw
                    ? "这条里有合并转发，用 expand_forward({messageId:\"" + id + "\"}) 展开看里面几条"
                    : rec2.img?.length
                    ? "这条带图，用 look_image({messageId:\"" + id + "\"}) 看内容"
                    : "",
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "read_context",
            description:
              "看一段群聊上下文：以某条消息为中心，往前 before 条、往后 after 条。\n" +
              "不填 id 就是看这个群最近的一段。每条都带［图×N］［转发×N］↩︎引用 的标记。\n" +
              "想接话、想搞清「他们在聊什么」时先用它。",
            parameters: {
              id: { type: "string", description: "中心消息 id（可选）" },
              group: { type: "string", description: "群号（可选）" },
              before: { type: "number", description: "往前几条，默认 10" },
              after: { type: "number", description: "往后几条，默认 5" },
            },
            output: TOOL_OUT,
            execute: async (args, exec) => {
              try {
                const gid = pickGid(args, exec);
                if (!gid) return { ok: false, reason: "不知道是哪个群，带个 group" };
                const rows = readMsgLog(gid, 500);
                if (!rows.length) return { ok: false, reason: "这个群还没有落盘记录" };
                const before = Math.min(80, Math.max(0, Number(args?.before ?? 20)));
                const after = Math.min(40, Math.max(0, Number(args?.after ?? 10)));
                const id = String(args?.id || "").trim();
                let idx = rows.length - 1;
                if (id) {
                  const found = rows.findIndex((r) => String(r.id) === id);
                  if (found < 0) return { ok: false, reason: "本地没有这条消息，先 read_message 取" };
                  idx = found;
                }
                const from = Math.max(0, idx - before);
                const to = Math.min(rows.length, idx + after + 1);
                const window = rows.slice(from, to);
                return {
                  ok: true,
                  group: gid,
                  total: rows.length,
                  focus: idx - from,
                  lines: window.map((r, i) => (i === idx - from ? "→ " : "  ") + renderMsgRec(r) + ((r.img?.length || r.fw) ? `  #${r.id}` : "")),
                  raw: window.slice(Math.max(0, idx - from - 1), idx - from + 2),
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "read_thread",
            description:
              "顺着「回复/引用」往上追：A 引用了 B，B 又引用了 C，一层层取出来。\n" +
              "想搞清「他这句话是在回谁」「这事从头到尾怎么来的」时用。",
            parameters: {
              id: { type: "string", description: "起点消息 id" },
              group: { type: "string", description: "群号（可选）" },
              depth: { type: "number", description: "最多追几层，默认 3" },
            },
            output: TOOL_OUT,
            execute: async (args, exec) => {
              try {
                const gid = pickGid(args, exec);
                const id = String(args?.id || "").trim();
                if (!gid || !id) return { ok: false, reason: "要 group 和 id" };
                const depth = Math.min(6, Math.max(1, Number(args?.depth ?? 3)));
                const chain = [];
                const note = [];
                let cur = findMsgInLog(gid, id);
                for (let i = 0; i < depth && cur; i += 1) {
                  chain.push({ id: cur.id, from: cur.n || cur.u, text: String(cur.x || "").slice(0, 200), at: cur.t });
                  let nextId = cur.qid ? String(cur.qid) : "";
                  // 本地没记到引用 id：问 QQ 这条到底在回谁
                  if (!nextId) {
                    try {
                      const q = await client.call("get_msg", { message_id: Number(cur.id) || cur.id }, 8000);
                      const segs = Array.isArray(q?.message) ? q.message : [];
                      const rp = segs.find((x) => x?.type === "reply");
                      nextId = String(rp?.data?.id ?? rp?.data?.message_id ?? "");
                    } catch {
                      // 取不到就到此为止
                    }
                  }
                  if (!nextId) {
                    note.push(`第 ${i + 1} 层没有引用；如果是转发，用 expand_forward 展开`);
                    break;
                  }
                  let nxt = findMsgInLog(gid, nextId);
                  if (!nxt) {
                    // 被引用那条本地没存：按 id 取回来再解析
                    try {
                      const q2 = await client.call("get_msg", { message_id: Number(nextId) || nextId }, 8000);
                      const segs2 = Array.isArray(q2?.message) ? q2.message : [];
                      const p2 = parseMessage(
                        {
                          message: segs2,
                          message_type: String(gid).startsWith("private:") ? "private" : "group",
                          group_id: String(gid).startsWith("private:") ? undefined : String(gid).replace(/^group:/, ""),
                          user_id: q2?.sender?.user_id,
                          time: q2?.time,
                          message_id: nextId,
                          sender: q2?.sender,
                        },
                        cfg.selfId,
                      );
                      if (p2.text || p2.replyIds?.[0]) {
                        nxt = {
                          id: String(nextId),
                          n: String(q2?.sender?.card || q2?.sender?.nickname || ""),
                          u: String(q2?.sender?.user_id || ""),
                          t: Number(q2?.time) || 0,
                          x: p2.text,
                          qid: p2.replyIds?.[0] ? String(p2.replyIds[0]) : "",
                        };
                        note.push(`第 ${i + 1} 层的原文是现取的（本地没存）`);
                      }
                    } catch {
                      // 取不到就断在这里
                    }
                  }
                  cur = nxt;
                }
                if (!chain.length) return { ok: false, reason: "本地没找到这条（可能太久远了）" };
                return {
                  ok: true,
                  group: gid,
                  depth: chain.length,
                  chain,
                  lines: chain.map((c, i) => `${i + 1}. ${c.from}：${c.text}`),
                  note: note.join("；"),
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "expand_forward",
            description:
              "展开一条合并转发（聊天记录）：按条列出里面的发言。\n" +
              "messageId 填那条转发消息的 id；from 从第几条开始（默认 1），count 要几条（默认 5，最多 20）。",
            parameters: {
              messageId: { type: "string", description: "转发消息的 id" },
              from: { type: "number", description: "从第几条开始，默认 1" },
              count: { type: "number", description: "要几条，默认 5" },
            },
            output: TOOL_OUT,
            execute: async (args, exec) => {
              try {
                const id = String(args?.messageId || args?.id || "").trim();
                if (!id) return { ok: false, reason: "要填 messageId" };
                let fwId = "";
                try {
                  const r = await client.call("get_msg", { message_id: Number(id) || id }, 8000);
                  const segs = Array.isArray(r?.message) ? r.message : [];
                  const fw = segs.find((x) => x?.type === "forward");
                  fwId = String(fw?.data?.id ?? fw?.data?.message_id ?? "");
                } catch {
                  // 取不到就当成转发 id 直接试
                }
                if (!fwId && /^\d{6,25}$/.test(id)) fwId = id;
                if (!fwId) return { ok: false, reason: "这条不是合并转发" };
                const res = await client.call("get_forward_msg", { id: fwId }, 10000);
                const msgs = Array.isArray(res?.messages) ? res.messages : [];
                const from = Math.max(1, Number(args?.from) || 1);
                const count = Math.min(20, Math.max(1, Number(args?.count) || 5));
                const items = msgs.slice(from - 1, from - 1 + count).map((m) => {
                  const name = String(m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || "某人").slice(0, 20);
                  const ss = Array.isArray(m?.content) ? m.content : Array.isArray(m?.message) ? m.message : [];
                  let t = ss
                    .filter((x) => x?.type === "text")
                    .map((x) => String(x?.data?.text || ""))
                    .join("")
                    .trim();
                  if (!t && typeof m?.raw_message === "string") t = cqText(m.raw_message);
                  if (!t && ss.some((x) => x?.type === "image")) t = "［图片］";
                  return { from: name, text: t.slice(0, 200) };
                });
                return {
                  ok: true,
                  total: msgs.length,
                  from,
                  count: items.length,
                  lines: items.map((x) => `${x.from}：${x.text}`),
                  hasMore: from - 1 + items.length < msgs.length,
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "search_messages",
            description:
              "在所有群落盘的记录里搜原话：按词、按人、按时间。\n" +
              "recall 查的是会话记录（只覆盖回过的），这个查的是旁听的所有群消息。\n" +
              "想找「谁说过这句」「那天群里在聊什么」时用。",
            parameters: {
              q: { type: "string", description: "关键词（可选）" },
              person: { type: "string", description: "昵称或 QQ 号（可选）" },
              group: { type: "string", description: "只搜某个群（可选）" },
              days: { type: "number", description: "最近几天，默认不限" },
              limit: { type: "number", description: "这一页几条，默认 10（最多 50）" },
              before: { type: "string", description: "从哪条消息往前翻（上次的 nextCursor）" },
            },
            output: TOOL_OUT,
            execute: async (args, exec) => {
              try {
                const q = String(args?.q || "").trim().toLowerCase();
                const person = String(args?.person || "").trim();
                const days = Number(args?.days) || 0;
                const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
                const since = days > 0 ? Date.now() - days * 86400_000 : 0;
                const gids = args?.group ? [String(args.group)] : listMsgKeys();
                const hits = [];
                for (const gid of gids.slice(0, 60)) {
                  for (const r of readMsgLog(gid, 2000)) {
                    if (since && (Number(r.t) || 0) * 1000 < since) continue;
                    if (person && !(String(r.n || "").includes(person) || String(r.u) === person)) continue;
                    if (q && !String(r.x || "").toLowerCase().includes(q)) continue;
                    hits.push({ gid, t: Number(r.t) || 0, text: renderMsgRec(r), msg: { id: r.id, n: r.n, x: String(r.x || "").slice(0, 120) } });
                  }
                }
                hits.sort((a, b) => b.t - a.t);
                const before = String(args?.before || "").trim();
                let startIdx = 0;
                if (before) {
                  const at = hits.findIndex((h) => String(h.msg?.id) === before);
                  if (at >= 0) startIdx = at + 1;
                }
                const page = hits.slice(startIdx, startIdx + limit);
                const hasMore = startIdx + page.length < hits.length;
                return {
                  ok: true,
                  scannedGroups: gids.length,
                  total: hits.length,
                  shown: page.length,
                  hasMore,
                  nextCursor: hasMore ? String(page[page.length - 1]?.msg?.id || "") : "",
                  note: hasMore
                    ? `共命中 ${hits.length} 条，这里只给了 ${page.length} 条；用 before=${String(page[page.length - 1]?.msg?.id || "")} 看更早的`
                    : `共命中 ${hits.length} 条`,
                  lines: page.map((h) => `[${String(h.gid).startsWith("private:") ? "私聊" : "群"}${String(h.gid).replace(/^(group|private):/, "")}] ${h.text}`),
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );

        logger.info?.("[onebot] 群消息读取工具已注册（read_message/read_context/read_thread/expand_forward/search_messages）");
      } catch (err) {
        logger.warn?.("[onebot] 群消息读取工具注册失败：" + (err?.message ?? err));
      }
    })();
}

export {  };
