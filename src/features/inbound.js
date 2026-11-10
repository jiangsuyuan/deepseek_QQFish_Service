// 入站消息：合并缓冲、入队、渲染成给她的 prompt。
import { tailRows } from "../util/msg-tail.js";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

export function createInbound(ctx) {
  const { INBOUND_TEXT_MAX, INBOX_PATH, cfg, extractRealInbound, inbox, logger, makeEvent, mergeBuf, pendingEvents, pushEvent, state, wakeNow, writeFileSync } = ctx;
  function flushBuf(key) {
      const buf = mergeBuf.get(key);
      if (!buf) return;
      mergeBuf.delete(key);
      if (buf.timer) clearTimeout(buf.timer);
      const merged =
        buf.prompts.length > 1
          ? (buf.ev?.message_type === "group"
              ? `（群里刚连着来了 ${buf.prompts.length} 条，可能不止一个人；你可以自己判断：一并回一次、挑重点回应，不必逐条回。）\n`
              : `（对方连着发了 ${buf.prompts.length} 条，合起来一起回）\n`) +
            buf.prompts.join("\n")
          : buf.prompts[0];
      // 这一批里不止一个人在说话 → 引用谁都不对，干脆不引用
      const target = buf.firstEv ?? buf.ev;
      logger.info?.("[onebot] flushBuf 触发：" + key + " prompts=" + (buf.prompts?.length ?? 0));
      try {
        const multi = (buf.users?.size ?? 0) > 1;
        if (multi) target.__noQuote = true;
        if (buf.prompts.length > 1) {
          logger.info?.(
            `[onebot] 合并 ${buf.prompts.length} 条${multi ? `（${buf.users.size} 人，不引用）` : ""}：${key}`,
          );
        }
      } catch {
        // 忽略
      }
      enqueueEvent(
        makeEvent(
          target?.message_type === "group" ? "mentioned" : "private_message",
          {
            type: target?.message_type,
            // group_id 只在真·群消息时算"发到哪"。
            // 私聊里 NapCat 也会带 group_id，但那是「群临时会话的来源群」，
            // 不是发送目标——放进 groupId 她会把私聊的话发进群里。
            groupId: target?.message_type === "group" ? target?.group_id : undefined,
            // 临时会话的来源群单独存，回复时要用 send_group_temp_msg
            originGroup:
              target?.message_type === "private" && target?.sub_type === "group"
                ? target?.group_id
                : undefined,
            subType: target?.sub_type,
            userId: target?.user_id,
            nickname: target?.sender?.nickname,
          },
          {
            // 正文用事件自己的文本；notes 是这批消息的补充说明（引用/转发/图片/续聊…）
            text: target?.__parsedText || target?.raw_message || extractRealInbound(merged) || clipInbound(merged),
            messageId: target?.message_id,
            notes: merged,
          },
        ),
      );
    }

  function enqueue(key, ev, prompt, images) {
      const isGroup = ev.message_type === "group";
      // 风控模式下群聊也合并：几个人的话攒几秒，一次想完再回（降低回复条数）
      if (cfg.mergeMessages === false || (isGroup && cfg.mergeGroups !== true)) {
        enqueueEvent(
          makeEvent(
            ev?.message_type === "group"
              ? (ev?.__hasAt ? "mentioned" : "replied")
              : "private_message",
            {
              type: ev?.message_type,
              groupId: ev?.message_type === "group" ? ev?.group_id : undefined,
              originGroup:
                ev?.message_type === "private" && ev?.sub_type === "group"
                  ? ev?.group_id
                  : undefined,
              subType: ev?.sub_type,
              userId: ev?.user_id,
              nickname: ev?.sender?.nickname,
            },
            { text: ev?.__parsedText || (ev?.raw_message ?? ""), messageId: ev?.message_id, notes: prompt },
          ),
        );
        return;
      }
      let buf = mergeBuf.get(key);
      // 默认只合并同一个人的连发：窗口里换了人说话，先把上一批冲掉，各回各的
      if (buf && cfg.mergeMultiUser !== true && String(buf.ev?.user_id ?? "") !== String(ev.user_id ?? "")) {
        flushBuf(key);
        buf = null;
      }
      buf =
        buf ??
        { prompts: [], images: [], ev, firstEv: ev, users: new Set(), timer: null };
      buf.firstEv = buf.firstEv ?? ev;
      try {
        buf.users = buf.users ?? new Set();
        if (ev.user_id) buf.users.add(String(ev.user_id));
      } catch {
        // 忽略
      }
      buf.prompts.push(prompt);
      // 缓冲上限：最多攒 6 条，防止爆群时无限堆积
      if (buf.prompts.length > 6) buf.prompts = buf.prompts.slice(-6);
      buf.ev = ev;
      if (Array.isArray(images) && images.length) {
        buf.images = [...buf.images, ...images].slice(0, 3);
      }
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        flushBuf(key);
      }, Number(isGroup ? (cfg.groupMergeWindowMs || 1500) : (cfg.mergeWindowMs || 2500)));
      buf.timer.unref?.();
      mergeBuf.set(key, buf);
    }

  function flushInbox() {
      if (!state.inboxDirty) return;
      try {
        const lines = inbox.map((x) => JSON.stringify(x)).join("\n") + "\n";
        writeFileSync(INBOX_PATH, lines, "utf8");
        state.inboxDirty = false;
      } catch (err) {
        logger.debug?.("[onebot] inbox 落盘失败：" + (err?.message ?? err));
      }
    }

  function clipInbound(text, max) {
      const s = String(text || "");
      const lim = max || INBOUND_TEXT_MAX;
      if (s.length <= lim) return s;
      logger.info?.("[onebot] 入站正文被截断: " + s.length + " -> " + lim + " 字");
      return s.slice(0, lim) + "……（后面还有 " + (s.length - lim) + " 字，超过单条上限被截断）";
    }

  function channelOfSource(e) {
    const src = e?.source || {};
    if (src.type === "group" && src.groupId) return "group:" + src.groupId;
    if (src.type === "private" && src.userId) return "private:" + src.userId;
    return "";
  }

  function renderEventForAgent(e, idx) {
      const t = new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const lines = [];
      lines.push("【" + (idx + 1) + "】" + t);
      const mid = e.payload && e.payload.messageId ? String(e.payload.messageId) : "";
      if (e.kind === "private_message") {
        const isTemp = e.source.subType === "group" || !!e.source.originGroup;
        lines.push(
          (isTemp ? "群临时会话（群友私聊，不是好友）" : "私聊") +
            " · " +
            (e.source.nickname || e.source.userId || "某人") +
            "（" + (e.source.userId || "") + "）",
        );
        if (isTemp) {
          const og = Number(e.source.originGroup) || 0;
          if (og > 0) {
            lines.push("来源群: " + og + "（只是他从哪个群来，别把话发进群）");
            lines.push("target: private:" + (e.source.userId || ""));
            lines.push(
              "⚠️ 回复用 reply_to({ target: \"private:" + (e.source.userId || "") +
                "\", messageId, text, groupTemp: " + og + " })",
            );
          } else {
            // 来源群没拿到，就别编一个 0 出来——这会让层里以为是"发到群 0"
            lines.push("来源群: 没拿到（NapCat 没给）");
            lines.push("target: private:" + (e.source.userId || ""));
            lines.push("⚠️ 这是群临时会话，但来源群未知。先直接 reply_to({ target: \"private:" + (e.source.userId || "") + "\", ... }) 试，发不出去就把失败原因如实说出来。");
          }
        } else {
          lines.push("target: private:" + (e.source.userId || ""));
        }
        if (mid) lines.push("messageId: " + mid);
        lines.push("「" + clipInbound(e.payload.text) + "」");
      } else if (e.kind === "mentioned") {
        lines.push("群 " + e.source.groupId + " · " + (e.source.nickname || e.source.userId) + " @ 你");
        lines.push("target: group:" + e.source.groupId);
        if (mid) lines.push("messageId: " + mid);
        lines.push("「" + clipInbound(e.payload.text) + "」");
      } else if (e.kind === "replied") {
        lines.push("群 " + e.source.groupId + " · " + (e.source.nickname || "") + " 回了你");
        lines.push("target: group:" + e.source.groupId);
        if (mid) lines.push("messageId: " + mid);
        lines.push("「" + clipInbound(e.payload.text) + "」");
      } else if (e.kind === "quiet_group") {
        lines.push("群 " + e.source.groupId + " 安静了 " + Math.round((e.payload.silentMinutes || 0)) + " 分钟");
        lines.push("target: group:" + e.source.groupId);
        if (e.payload.lastSpeaker) lines.push("最后说话的是「" + e.payload.lastSpeaker + "」");
      } else if (e.kind === "reminder_due") {
        lines.push("你之前给自己留了句话：「" + String(e.payload.what || "").slice(0, 200) + "」");
      } else if (e.kind === "review") {
        // 延迟回看：她说完话之后群里接着说的几条
        // 注意：必须给 target（和 messageId），否则她只能凭记忆填 —— 会发错群
        const isGroup = e.source?.type === "group";
        if (isGroup) {
          lines.push("群 " + e.source.groupId);
          lines.push("target: group:" + e.source.groupId);
        } else {
          lines.push("私聊 · " + (e.source?.nickname || e.source?.userId || ""));
          lines.push("target: private:" + (e.source?.userId || ""));
        }
        let last = [];
        try {
          // 只取"她最后一句之后"的消息；她自己说过的话不再混进来
          last = tailRows(channelOfSource(e), 8);
        } catch {
          last = { rows: [], afterMine: true };
        }
        const rows = last.rows || [];
        if (rows.length) {
          const newest = rows[rows.length - 1];
          if (newest?.id) lines.push("messageId: " + newest.id);
          lines.push("");
          lines.push(
            e.reviewMode === "single" ? "你刚才说完话之后，群里来了一条：" : "你刚才说完话之后，群里接着说了这几条：",
          );
          for (const row of rows) lines.push(`· ${row.who}：${row.text}${row.id ? "（id " + row.id + "）" : ""}`);
          lines.push("");
        } else {
          lines.push("");
          lines.push("你刚才说完话之后，群里没有新消息。");
          lines.push("");
        }
        lines.push("判断这条是不是在回复你。不是就什么都不做，是的话你自己判断是否做什么，感觉不好判断就按照没有回复算。");
        if (isGroup) lines.push("要回哪条，就用那条的 id 做 messageId；不想引用就 qq_send 直接说。");
      } else if (e.kind === "activity_due") {
        lines.push("你之前排的活动时间到了。");
        // kind 以前只存不用：她 schedule_activity({kind:"read"}) 记下来的东西
        // 到点根本不出现，等于白填。
        if (e.payload.kind) lines.push("当时想做的：" + String(e.payload.kind).slice(0, 40));
        if (e.payload.note) lines.push("当时留的：" + String(e.payload.note).slice(0, 200));
      } else if (e.kind === "system") {
        lines.push("系统：" + String(e.payload.text || "").slice(0, 300));
      }
      return lines.join("\n");
    }

  function enqueueEvent(e) {
      pushEvent(e);
      logger.info?.("[onebot] 事件入队：" + e.kind + " status=" + e.status + " pending=" + pendingEvents().length);
      if (state.state === "busy") {
        logger.info?.("[onebot] 在忙，事件排队：" + e.kind);
        return;
      }
      void wakeNow();
    }

  return { enqueue, flushBuf, renderEventForAgent, clipInbound, enqueueEvent, flushInbox };
}

export {  };
