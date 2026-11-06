// 一轮对话的投递与唤醒。

export function createChatFeature(ctx) {
  const { LEN_TIER_NAMES, WAKE_KEY, activeHoursOk, activityTimeline, appendMem, audit, bumpWindow, cfg, client, enqueueEvent, eventTarget, flushInbox, flushSeen, followMax, hitWindow, lenTierOf, logger, makeEvent, markRuntimeDirty, markSeen, openWindow, pendingEvents, pendingWhileBooting, processingIds, pushLen, recentIds, renderEventForAgent, seenDirty, seenState, sessions, sleep, state, todayKey } = ctx;
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
          const tools =
            "\n\n**重要：你说的话不会自动发出去。** 要说，必须调工具，target 从上面的事件里抄。" +
            "（比如 group:123456789 或 private:100000001）\n\n" +
            "工具：\n" +
            "· send_message({ target, text, sticker? }) —— 发消息；sticker 可选（大笑/无语/生气/委屈/震惊/开心/睡觉/random）\n" +
            "· reply_to({ target, messageId, text, groupTemp? }) —— 回复某条（带引用）\n" +
            "· send_private({ qq, text, groupTemp? }) —— 主动找人私聊；群临时会话要带 groupTemp\n" +
            "· at_person({ target, qq, text }) —— 在群里 @ 第三方\n" +
            "· send_sticker({ target, mood }) —— 只发个表情\n" +
            "· run_activity({ kind?, note? }) —— 做点事（read/play/explore/think/write/watch_groups/dream…）\n" +
            "· schedule_activity({ afterMinutes, kind?, note? }) —— 排下次活动；0 = 取消\n" +
            "· my_context() —— 看自己的上下文用掉多少\n" +
            "\n例：send_message({ target: \"private:100000001\", text: \"在，咋了\" })\n" +
            "\n**只回下面这一条事件。** target 一律从这条事件的 target: 行抄，" +
            "不要凭记忆或上一条消息的号码填——填错就发给别人了。\n" +
            "\n这些是现在发生的事。怎么回应、要不要回应，你看着办。\n" +
            "不想回就不用调工具——这条会被标成「看过」。但想回就必须调工具，光说没用。）";

          // 先 ensure + 拿 agent，记下 seq，才能判断「她调了工具没有」
          let agent = null;
          let beforeSeq = 0;
          try {
            const entry = await sessions.ensure(WAKE_KEY());
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

          await sessions.runSilent(WAKE_KEY(), header + body + tools);

          // 用 session 事件判断：有 tool/call 才算「处理了」
          let calledTool = false;
          try {
            const entry2 = sessions.entries.get(WAKE_KEY());
            const agent2 = entry2?.handle?.agent ?? agent;
            const evs = agent2?.session?.snapshotEvents?.(beforeSeq) ?? [];
            calledTool = evs.some((x) => x?.type === "tool/call");
          } catch {
            // 判断失败按「没调工具」处理
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
        logger.warn?.("[onebot] wakeNow 失败：" + (err?.message ?? err));
      } finally {
        state.state = "idle";
      }
    }

  async function deliver(key, ev, prompt, images) {
      const pid = String(ev?.message_id ?? "");
      if (pid) processingIds.add(pid);
      try {
        // 加超时保护：agent 未就绪时 sessions.run 可能无限挂起
        const reply = await Promise.race([
          sessions.run(key, prompt, ev, images),
          sleep(90000).then(() => {
            throw new Error("回合超时 90s（agent 可能未就绪或模型卡住）");
          }),
        ]);
        const cur = sessions.entries.get(key);
        if (cur?.usedStickerOnly && !String(reply || "").trim()) {
          logger.info?.("[onebot] 本轮只发了表情包，不再补文字");
          markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
          flushSeen();
          if (cfg.followUpEnabled) {
            if (hitWindow(key, ev.user_id)) bumpWindow(key, ev.user_id);
            else openWindow(key, ev.user_id);
          }
          return;
        }
        const out = (reply || "").trim();
        if (!out) {
          // 模型什么都没说，就什么都不发（别发占位文案）
          logger.info?.("[onebot] 本轮无文本输出，不发消息");
          return;
        }
        const clipped =
          out.length > cfg.maxReplyChars ? out.slice(0, cfg.maxReplyChars) + "\n…（已截断）" : out;
        const hasQuoteSeg =
          Array.isArray(ev.message) && ev.message.some((x) => x?.type === "reply");
        await client.sendHuman(ev, clipped, { quote: !!(ev.__hasAt || hasQuoteSeg) });
        try {
          const ent0 = sessions.bySessionId(sid);
          if (ent0) ent0.lastSent = { text: String(clipped), at: Date.now() };
        } catch {
          // 忽略
        }
        try {
          const ent2 = sessions.entries.get(key);
          if (ent2) {
            ent2.lastReplyAt = Date.now();
            ent2.lastReplyTo = String(ev.user_id);
            ent2.lastReplyText = String(clipped).replace(/\n/g, " ").slice(0, 80);
            markRuntimeDirty();
          }
        } catch {
          // 忽略
        }
        // 区分通道：走网页的推到 WebUI，走 QQ 的发到 QQ——日志里一眼能看出来
        const channel = ev.__fromWebUI ? "[网页]" : "[QQ]";
        logger.info?.(`[onebot] → ${channel} ${key} ${clipped.slice(0, 60).replace(/\n/g, " ")}`);
        audit({
          kind: "reply",
          key,
          text: clipped.slice(0, 200),
          tier: LEN_TIER_NAMES[lenTierOf(String(clipped).length)],
          len: String(clipped).length,
        });
        pushLen(String(clipped).length);
        markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
        flushSeen();
        // 表情包不再自动补了——她自己决定要不要发（send_message 的 sticker 参数 / send_sticker）

        if (!state.agentReady) {
          state.agentReady = true;
          logger.info?.(`[onebot] agent 已就绪，重放暂存 ${pendingWhileBooting.length} 条`);
          const queued = pendingWhileBooting.splice(0);
          for (const qev of queued) {
            // 暂存时已经进过 recentIds，重放要清掉，否则会被去重拦下
            try {
              recentIds.delete(String(qev.message_id ?? ""));
            } catch {
              // 忽略
            }
            void client.onEvent(qev).catch(() => {});
          }
        }
        if (cfg.followUpEnabled) {
          if (hitWindow(key, ev.user_id)) {
            bumpWindow(key, ev.user_id);
          } else {
            openWindow(key, ev.user_id);
            logger.info?.(`[onebot] 续聊窗口打开 ${key} 用户 ${ev.user_id}（上限 ${followMax()} 轮）`);
          }
          // 记一条「聊了什么」，摘要和检索都用得上
          try {
            const topicTxt = String(parsed.text || "")
              .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
              .slice(0, 12);
            appendMem({
              kind: "chat",
              who: String(ev.user_id || ""),
              topic: topicTxt,
              text: `跟${nickname}聊「${String(parsed.text || "").slice(0, 40)}」，我回了「${String(reply || "").slice(0, 40)}」`,
              ref: key,
            });
          } catch {
            // 忽略
          }
        }
      } catch (err) {
        const emsg = String(err?.message ?? err);
        logger.warn?.(`[onebot] 处理失败 ${key}：${emsg}`);
        // 400 类错误：把 prompt 的体征打出来，便于定位非法字符/超长
        if (/failed \(400\)|request failed \(400\)/i.test(emsg)) {
          try {
            const pr = String(state.pendingPromptForDiag ?? "");
            const tail = pr.slice(-60);
            const hasLone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(pr);
            logger.warn?.(
              `[onebot] 400 诊断：prompt 长度=${pr.length} 孤立代理=${hasLone} 尾部=${JSON.stringify(tail)}`,
            );
            audit({
              kind: "api_400",
              key,
              len: pr.length,
              hasLoneSurrogate: hasLone,
              tail,
            });
          } catch {
            // 忽略
          }
        }
        audit({ kind: "error", key, error: emsg.slice(0, 300) });
        // 会话写锁冲突：说明上一轮还没结束，直接跳过，等下一轮或 catchUp 补
        if (/already owned by an active write handle/i.test(emsg)) {
          logger.info?.(`[onebot] 会话正忙，本轮跳过（不再重试）：${key}`);
          return;
        }
        // 网络/掉线类错误不重试——重试也发不出去，等重连后由 catchUp 补
        if (/网络连接异常|1006514|未连接|disconnected|ECONN|ETIMEDOUT|socket/i.test(emsg)) {
          logger.info?.(`[onebot] 网络异常，跳过重试（等重连补回）：${key}`);
          return;
        }
        try {
          const ent = sessions.entries.get(key);
          if (ent) {
            logger.info?.(`[onebot] 自动重试 ${key}`);
            await sleep(1500);
            try {
              await ent.handle?.dispose?.();
            } catch {
              // 忽略
            }
            ent.handle = null;
            const reply2 = await sessions.run(key, prompt, ev, images);
            const out2 = String(reply2 || "").trim();
            if (out2) {
              await client.sendHuman(ev, out2);
              audit({ kind: "retry_ok", key, text: out2.slice(0, 120) });
              markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
              flushSeen();
            }
          }
        } catch (err2) {
          logger.warn?.(`[onebot] 重试仍失败 ${key}：${err2?.message ?? err2}`);
        }
        if (cfg.replyOnError) {
          try {
            await client.sendText(ev, `处理出错：${String(err?.message ?? err).slice(0, 300)}`);
          } catch {
            // 回复失败忽略
          }
        }
      } finally {
        if (pid) processingIds.delete(pid);
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
          if (newestUid && newestUid === String(cfg.selfId)) {
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

  return { deliver, wakeNow, checkQuietGroups };
}

export {  };
