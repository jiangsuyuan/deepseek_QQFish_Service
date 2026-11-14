import { noteError } from "../core/error-watch.js";
// 一轮对话的投递与唤醒。

import { isSelf } from "../util/self-ids.js";

export function createChatFeature(ctx) {
  const { LEN_TIER_NAMES, WAKE_KEY, segments, deferredReview, echo, activeHoursOk, activityTimeline, appendMem, audit, bumpWindow, cfg, client, enqueueEvent, eventTarget, flushInbox, flushSeen, followMax, hitWindow, lenTierOf, logger, makeEvent, markRuntimeDirty, markSeen, openWindow, pendingEvents, pendingWhileBooting, processingIds, pushLen, recentIds, renderEventForAgent, promptCore, seenDirty, seenState, sessions, sleep, state, todayKey } = ctx;
  async function wakeNow() {
      if (state.state === "busy") return;
      state.state = "busy";
      try {
        while (true) {
          const e = pendingEvents()[0];
          if (!e) break;
          logger.info?.("[onebot] wakeNow 处理：" + e.kind + "（还有 " + pendingEvents().length + " 条）");

          const timeline = activityTimeline();
          const header =
            "（现在 " +
            new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }) +
            "。\n" + timeline + "\n\n";
          const body = renderEventForAgent(e, 0);
          // 每轮都一样的风格/长度前缀（events.js 里算好、但以前被丢掉的那部分）
          let core = "";
          try {
            core = promptCore ? promptCore() : "";
          } catch {
            core = "";
          }
          const notes = e.payload?.notes ? String(e.payload.notes).trimEnd() + "\n\n" : "";
          // 复读机跟完要让她知道
          let echoNote = "";
          try {
            echoNote = echo?.takeNotes?.() || "";
            if (echoNote) echoNote += "\n\n";
          } catch {
            echoNote = "";
          }
          const tools =
            "\n\n**重要：你说的话不会自动发出去。** 要说，必须调工具，target 从上面的事件里抄。" +
            "（比如 group:123456789 或 private:123456789）\n\n" +
            "工具：**全部工具都在上面系统提示的表里**，用 call_tool 调。\n" +
            "· 发消息：call_tool({ name: \"qq_send\", args: { target, text } }) 或 reply_to\n" +
            "· 不确定参数：describe_tool({ name: \"工具名\" })\n" +
            "\n例：call_tool({ name: \"qq_send\", args: { target: \"private:123456789\", text: \"在，咋了\" } })\n" +
            "\n**只回下面这一条事件。** target 一律从这条事件的 target: 行抄，" +
            "不要凭记忆或上一条消息的号码填——填错就发给别人了。\n" +
            "\n这些是现在发生的事。怎么回应、要不要回应，你看着办。\n" +
            "不想回就不用调工具——这条会被标成「看过」。但想回就必须调工具，光说没用。）";

          // 频道级会话：一个频道一段连续对话，隔太久就换新段
          const channel = segments ? segments.channelOf(e) : "";
          let runKey = WAKE_KEY();
          let freshSeg = false;
          let prevAt = 0;
          if (channel) {
            const seg = segments.keyFor(channel);
            runKey = seg.key;
            freshSeg = seg.fresh;
            prevAt = seg.prevAt;
          }

          // 先 ensure + 拿 agent，记下 seq，才能判断「她调了工具没有」
          let agent = null;
          let beforeSeq = 0;
          try {
            const entry = await sessions.ensure(runKey);
            if (!entry.handle) entry.handle = await sessions.openAgent(entry.sessionId);
            agent = entry.handle?.agent ?? null;
            beforeSeq = agent?.session?.seq ?? 0;

            // 把「当前这条事件的发送目标」绑到 entry 上。
            // send_sticker / send_face / draw_* / refuse_person 都用 entry.lastTarget，
            // 不绑的话它们会退到 lastInbound（全局最后一条），把表情包发到别人那儿去。
            const t = eventTarget(e);
            if (t) {
              entry.lastTarget = t;
              logger.info?.(
                "[onebot] 本次事件目标：" +
                  (t.message_type === "group" ? "group:" + t.group_id : "private:" + t.user_id) +
                  (t.__groupTemp ? "（临时会话，来源群 " + t.__groupTemp + "）" : ""),
              );
            } else {
              logger.info?.("[onebot] 本次事件没有发送目标（" + e.kind + "）");
            }
          } catch (err) {
            logger.warn?.("[onebot] wakeNow 准备 agent 失败：" + (err?.message ?? err));
          }

          let segNote = "";
          if (freshSeg && prevAt) {
            let last = [];
            try {
              last = segments.lastLines ? segments.lastLines(channel, 2) : [];
            } catch {
              last = [];
            }
            segNote =
              `（新的一段对话。上次这里 ${Math.round((Date.now() - prevAt) / 60000)} 分钟前` +
              (last.length ? `，最后几句：\n${last.join("\n")}` : "") +
              `\n 细节可以用 search_messages 查。）\n\n`;
          }
          await sessions.runSilent(runKey, echoNote + segNote + header + core + notes + body + tools);

          // 用 session 事件判断：有 tool/call 才算「处理了」
          let calledTool = false;
          try {
            const entry2 = sessions.entries.get(runKey);
            const agent2 = entry2?.handle?.agent ?? agent;
            const evs = agent2?.session?.snapshotEvents?.(beforeSeq) ?? [];
            calledTool = evs.some((x) => x?.type === "tool/call");
          } catch {
            // 判断失败按「没调工具」处理
          }
          if (channel) segments.noteTurn(channel);
          try {
            if (channel) deferredReview?.settle?.(channel, calledTool);
          } catch {
            // 忽略
          }
          e.status = calledTool ? "handled" : "ignored";
          state.inboxDirty = true;
          flushInbox();

          // 记进 seenState。不记的话 catchUpPrivate 每轮轮询都会把这条当成
          // "还没回"重新捞回来——今天同一个人被补回复了 56 遍就是这么来的。
          try {
            const mid = String(e.payload?.messageId ?? "");
            if (mid) {
              const src = e.source || {};
              const key =
                src.type === "group" || e.kind === "mentioned" || e.kind === "replied" || e.kind === "quiet_group"
                  ? "group:" + src.groupId
                  : "private:" + src.userId;
              markSeen(key, Number(e.at) || Date.now(), mid);
              flushSeen();
            }
          } catch (err) {
            logger.debug?.("[onebot] wakeNow markSeen 失败：" + (err?.message ?? err));
          }
        }
      } catch (err) {
        const sn = noteError(err, "chat.wakeNow");
        logger.warn?.("[onebot] wakeNow 失败：" + (err?.message ?? err) + (sn ? ` ｜ 程序错误 ${sn.key}×${sn.count}` : ""));
      } finally {
        state.state = "idle";
      }
    }


  async function checkQuietGroups() {
      if (!cfg.quietTopicEnabled || cfg.autoActionsEnabled === false) return;
      if (!client.connected) return; // 掉线时跳过
      if (!activeHoursOk()) return; // 23-9 点不主动开话题
      const nowTs = Date.now();
      const limit = (Number(cfg.quietTopicHours) || 2) * 3600 * 1000;
      // 覆盖「所有见过的群」——只遍历内存里的 entries 会漏掉没建过会话的群
      const allKeys = new Set(
        Object.keys(seenState).filter((k) => k.startsWith("group:")),
      );
      for (const k of sessions.entries.keys()) {
        if (k.startsWith("group:")) allKeys.add(k);
      }
      for (const key of allKeys) {
        if (!key.startsWith("group:")) continue;
        let ent = sessions.entries.get(key);
        if (ent?.topicPending) continue;
        let last = ent?.lastMessageAt ?? seenState[key]?.lastTime ?? 0;

        // seen.lastTime 只在「回复成功」时更新，旁听不更新，容易误判。
        // 判定前先用历史确认一次真实的最后消息时间。
        const gidNum0 = Number(key.slice(6));
        try {
          const h = await client.call(
            "get_group_msg_history",
            { group_id: gidNum0, count: 2 },
            6000,
          );
          const msgs = Array.isArray(h?.messages) ? h.messages : [];
          for (const m of msgs) {
            const t = Number(m?.time) * 1000 || 0;
            if (t > last) last = t;
          }
          // 最后一条是她自己发的 → 不再自说自话，等有人说话再恢复
          const newest = msgs.length
            ? msgs.reduce((a, b) => (Number(b?.time) > Number(a?.time) ? b : a))
            : null;
          const newestUid = String(newest?.sender?.user_id ?? newest?.user_id ?? "");
          if (newestUid && isSelf(cfg, newestUid)) {
            if (ent) ent.topicAwaitHuman = true;
            logger.debug?.(`[onebot] 群 ${key} 最后一条是她自己发的，跳过冷群搭话`);
            continue;
          }
        } catch {
          // 拉不到就用旧值
        }
        // 顺便把准确时间写回去，下次不用再拉
        try {
          const rec0 = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
          if (last > (rec0.lastTime ?? 0)) {
            rec0.lastTime = last;
            seenDirty = true;
          }
        } catch {
          // 忽略
        }

        if (!last || nowTs - last < limit) continue;
        if (nowTs - (ent?.lastTopicAt ?? 0) < limit) continue;
        if (ent?.topicAwaitHuman) continue;
        const dayK = todayKey();
        if (ent && ent.topicDay !== dayK) {
          ent.topicDay = dayK;
          ent.topicDayCount = 0;
        }
        if (ent && Number(ent.topicDayCount ?? 0) >= (Number(cfg.quietTopicPerDay) || 1)) continue;
        // 没会话就建一个，并给一个发送目标，否则主动消息发不出去
        if (!ent) {
          try {
            ent = await sessions.ensure(key);
          } catch {
            continue;
          }
        }
        if (!ent) continue;
        const gidNum = Number(key.slice(6));
        if (!ent.lastTarget) {
          ent.lastTarget = { message_type: "group", group_id: gidNum, user_id: 0 };
        }
        ent.lastTopicAt = nowTs;
        ent.topicPending = true;
        ent.topicAwaitHuman = true;
        ent.topicDayCount = Number(ent.topicDayCount ?? 0) + 1;
        logger.info?.(`[onebot] 群 ${key} 静了 ${cfg.quietTopicHours} 小时，产生 quiet_group 事件`);
        audit({ kind: "quiet_topic", key });
        // 不直接发——产生事件，她自己决定要不要开口
        enqueueEvent(
          makeEvent(
            "quiet_group",
            {
              type: "group",
              groupId: key.slice(6),
              lastSpeaker: String(ent?.topicLastSpeaker || ""),
            },
            { silentMinutes: Math.round((nowTs - last) / 60000) },
          ),
        );
      }
    }

  return { wakeNow, checkQuietGroups };
}

export {  };
