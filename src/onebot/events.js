// QQ 事件入口（原 apply() 内的 client.onEvent 赋值）。
import { checkDeps } from "../util/deps.js";
import { REVIEW_PROMPT } from "../util/review-prompt.js";
import { cacheMessageImages } from "../store/img-cache.js";

export function createEventHandler(app) {
  // 这三个以前是可选链，没传就静默失效；现在启动即报错
  checkDeps("事件处理器", app, ["echo", "deferredReview", "cancelReviews"]);
  const { activeHoursOk, activeWindowTarget, allowed, attention, audit, cfg, client, closeWindowFor, conversationKey, deferredReview, echo, cancelReviews, dedupe, downloadImage, enqueue, facts, fetchLinkPreview, findMsgInLog, flushSeen, formatLenHint, groupMetaTouch, handleGroupRequest, handleOwnerInviteReply, handleOwnerLeaveGroup, handleOwnerNatural, handleOwnerRelay, handleOwnerRemember, handlePoke, health, hitWindow, imagePayloadFrom, isRefused, judgeSwitchTalk, l1Push, l1TakeText, loadCore, loadGroupMeta, logger, markRuntimeDirty, markSeen, mergeBuf, moodContext, msgLogKeyOf, netWalk, noteMirrorSource, openWindow, otherGroupDigest, parseMessage, pendingWhileBooting, people, recallSearch, recentDigestText, recentOutageNote, recordMessage, renderRecall, seenDirty, seenState, selfModelText, selfViews, sessions, state, stripLoneSurrogates, switchJudgeAt, textOverlaps, timeContext, todayKey, watchHit, webPush, pluginCtx: ctx } = app;
  return async (ev) => {
    if (ev?.__fromWebUI) logger.info?.(`[onebot] WebUI 事件进入 onEvent：${ev.message_id} type=${ev.post_type}/${ev.message_type}`);
    const trace = (m) => {
      if (ev.__fromPoll) logger.info?.(`[onebot] trace ${ev.message_id}: ${m}`);
    };
    if (ev.post_type === "message") {
      state.lastInbound = ev;
      health.lastEventAt = Date.now();
    }
    if (ev.post_type === "request") {
      await handleGroupRequest(ev);
      return;
    }
    // 戳一戳：先看前两条是不是在跟自己说话，是才回应
    if (ev.post_type === "notice") {
      const nt = String(ev.notice_type ?? "");
      const st = String(ev.sub_type ?? "");
      const isPoke = nt === "poke" || st === "poke" || /poke|戳/.test(nt + st);
      if (isPoke) {
        void handlePoke(ev).catch((err) => logger.debug?.(`[onebot] 处理戳一戳失败：${err?.message ?? err}`));
      }
      return;
    }
    if (ev.post_type !== "message") return trace("非 message 事件");
    // 临时消息 / 陌生人消息：多半是好友申请或陌生人搭话，转告创造者
    if (ev.message_type === "temp" || ev.message_type === "stranger" || ev.sub_type === "temp") {
      try {
        const segs = Array.isArray(ev.message) ? ev.message : [];
        const txt = segs
          .filter((x) => x?.type === "text")
          .map((x) => x?.data?.text ?? "")
          .join("")
          .trim();
        const who = String(ev.user_id ?? ev.sender?.user_id ?? "");
        const nick = ev.sender?.nickname ?? "";
        if (cfg.ownerId) {
          await client.sendPrivate(
            cfg.ownerId,
            `陌生人发来消息：${nick || "?"}(${who})\n内容：${txt.slice(0, 100) || "（无文字）"}` +
              `\n如果是好友申请，需要你在 QQ 或 WebUI 里处理（NapCat 没开放普通好友申请的接口）。`,
          );
          logger.info?.(`[onebot] 临时消息已转告创造者：${nick || who}`);
          audit({ kind: "temp_message", from: who, text: txt.slice(0, 120) });
        }
      } catch (err) {
        logger.debug?.(`[onebot] 临时消息处理失败：${err?.message ?? err}`);
      }
      return;
    }
    if (String(ev.user_id) === String(cfg.selfId)) return trace("自己发的");
    if (!dedupe(ev.message_id)) return trace("被去重拦下");
    // agent 还没就绪时先暂存，避免卡在 sessions.ensure
    if (!state.agentReady) {
      pendingWhileBooting.push(ev);
      if (pendingWhileBooting.length > 30) pendingWhileBooting.shift();
      // 超过 5 分钟还放不出去，说明不是"启动慢"，直接丢弃避免误导
      if (Date.now() - health.restartedAt > 300000) {
        pendingWhileBooting.length = 0;
        state.agentReady = true;
      }
      logger.info?.(`[onebot] agent 未就绪，暂存 ${ev.message_id}（队列 ${pendingWhileBooting.length}）`);
      return trace("agent 未就绪，暂存");
    }

    const parsed = parseMessage(ev, cfg.selfId);
    // 旁听与 @ 一视同仁：先落盘，再决定要不要回
    try {
      if (ev && (ev.message_type === "group" || ev.message_type === "private")) recordMessage(ev, parsed);
    } catch {
      // 落盘失败不影响聊天
    }
    // 真人在说话：正在跑的内省/主动回合立即作废，别把这条并进别的回合里
    try {
      const k0 = conversationKey(ev);
      const ent0 = k0 ? sessions.entries.get(k0) : null;
      if (ent0?.silentTurn) {
        ent0.silentTurn = false;
        ent0.silentTurnAt = 0;
        logger.info?.(`[onebot] 收到真人消息，静默回合提前结束：${k0}`);
      }
      // 主动回合的标志绝不能留给下一条真人消息：否则正常回复会被当成「自发消息」发到别处
      if (ent0?.proactiveTurn) {
        ent0.proactiveTurn = false;
        ent0.proactiveTarget = null;
        ent0.proactiveToken = null;
        logger.info?.(`[onebot] 收到真人消息，作废未完成的主动回合：${k0}`);
      }
      // 记录这一轮真正的来源会话，供发送校验
      if (ent0) ent0.turnOriginKey = k0;
    } catch {
      // 忽略
    }
    if (ev?.__fromWebUI) {
      logger.info?.(
        `[onebot] 解析结果：text=${JSON.stringify(String(parsed.text || "").slice(0, 40))} hasAt=${parsed.hasAt} len=${String(parsed.text || "").length}`,
      );
    }
    // 有人用纯文本打「@肥鱼」时 OneBot 不给 at 段，这里补上识别
    try {
      if (
        !parsed.hasAt &&
        (/@\s*(肥鱼|大鱼|鱼鱼)/.test(String(parsed.text || "")) ||
          String(parsed.text || "").includes(`@${cfg.selfId}`))
      ) {
        parsed.hasAt = true;
        parsed.textAtMe = true;
        logger.info?.("[onebot] 识别到文本形式的 @（无 at 段）");
      }
    } catch {
      // 忽略
    }
    trace(`parsed text=${JSON.stringify(parsed.text)} hasAt=${parsed.hasAt} imgs=${parsed.images.length} segs=${Array.isArray(ev.message) ? ev.message.length : "无message"}`);
    ev.__hasAt = parsed.hasAt;

    // 创造者自己在 QQ 里打的字，也要进网页聊天历史。
    // 以前只有「她说的话」会进来（/send 那条路也只管网页那边发出去的），
    // 于是 WinForms/WebUI 面板上全是她的话，看着像她一个人自言自语。
    // 只镜像「创造者私聊」：群里的创造者发言、以及她自己发的，都不在这儿处理。
    try {
      if (
        !ev.__fromWebUI &&
        ev.message_type === "private" &&
        String(ev.user_id) === String(cfg.ownerId) &&
        String(ev.user_id) !== String(cfg.selfId)
      ) {
        const otxt = String(parsed.text || "").slice(0, 500);
        const hasImg = Array.isArray(parsed.images) && parsed.images.length > 0;
        if (otxt || hasImg) {
          webPush({
            role: "me",
            text: otxt || "[图片]",
            channel: "private",
            peer: String(ev.user_id),
            ...(hasImg ? { viaImage: true } : {}),
          });
        }
      }
    } catch (err) {
      logger.debug?.(`[onebot] 创造者消息未记入网页历史：${err?.message ?? err}`);
    }
    // 空文本也可能是「只 @ 不说话」，交给后面按 hasAt 判断
    if (!parsed.text && !parsed.hasAt) return;

    const nickname = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    people.touch(
      ev.user_id,
      nickname,
      ev.message_type === "group" ? ev.group_id : 0,
      parsed.text,
    );

    const key = conversationKey(ev);

    // 创造者的自然语言控制：状态/静音/打断/档位/代发言
    let ownerHandled = false;
    try {
      ownerHandled = await handleOwnerNatural(ev, parsed.text);
    } catch (err) {
      logger.warn?.(`[onebot] handleOwnerNatural 抛错：${err?.message ?? err}`);
      logger.warn?.(`[onebot] 堆栈：${String(err?.stack ?? "").split("\n").slice(0, 4).join(" | ")}`);
    }
    if (ownerHandled) {
      logger.info?.(`[onebot] 被「创造者指令」拦截：${String(parsed.text || "").slice(0, 40)}`);
      // 指令类消息处理完必须标记「已处理」，
      // 否则私聊补回复（catchUpPrivate）会把同一条指令重新执行一遍，
      // 表现为「一个指令被反复执行」（定向搭话那次连发了 7 遍）。
      try {
        if (ev.message_id) {
          const ck = conversationKey(ev);
          markSeen(ck, Number(ev.time) * 1000 || Date.now(), ev.message_id);
          flushSeen();
        }
      } catch {
        // 忽略
      }
      return;
    }

    // 创造者的管理指令：定向搭话 / 记住 / 退群
    if (await handleOwnerRelay(ev, parsed.text)) return;
    if (await handleOwnerRemember(ev, parsed.text)) return;
    if (await handleOwnerLeaveGroup(ev, parsed.text)) return;

    // 创造者正在回答「要不要进群」：这条消息不送给模型
    if (await handleOwnerInviteReply(ev, parsed.text)) return;

    // 她说过「不再回复」的人：这段时间内直接跳过（创造者除外）
    if (
      cfg.ownerId &&
      String(ev.user_id) !== String(cfg.ownerId) &&
      isRefused(String(ev.user_id))
    ) {
      logger.info?.(`[onebot] 已声明不再回复 ${ev.user_id}，跳过（${key}）`);
      audit({ kind: "refuse_skip", key, from: String(ev.user_id) });
      return;
    }

    // 硬信号（@ 她）走即时路径，并且打断待触发的回看
    // 同时把这个群还在排队的旧回看全部作废——她已经看到新消息了，旧的回看没意义
    try {
      if (ev.message_type === "group" && parsed.hasAt) {
        deferredReview?.cancel?.(key);
        const dropped = cancelReviews?.(ev.group_id);
        if (dropped) logger.info?.(`[onebot] 新 @ 到达，作废本群 ${dropped} 条排队回看`);
      }
    } catch {
      // 忽略
    }

    // 群聊只认两种信号：@ 她、引用她。
    // 续聊窗口 / 换人接话 / 换目标判断 都已删除（4.1 简化）——群里其他人说什么都与她无关。
    const nowTs = Date.now();
    const continuing = false;
    const switchedFrom = null;
    const namedCall = !!parsed.hasAt || !!parsed.replyToMe;

    // 复读机：群里有好几个人连发同一句时，她可能跟着发一句（默认关，她自己开）
    try {
      if (ev.message_type === "group" && parsed.text) {
        void echo?.feed?.({ groupId: ev.group_id, userId: ev.user_id, text: parsed.text });
      }
    } catch {
      // 忽略
    }

    // 群里没 @ 她、也不是在续聊：只旁观、记录，不回复
    if (ev.message_type === "group" && !namedCall && cfg.groupObserve) {
      const segTypes = (Array.isArray(ev.message) ? ev.message : [])
        .map((x) =>
          x?.type === "at"
            ? "at:" + String(x?.data?.qq) + "/" + String(x?.data?.name ?? "")
            : String(x?.type),
        )
        .join(",");
      logger.info?.(
        `[onebot] 旁听 ${key} [${nickname}] ${parsed.text.slice(0, 40)}（at=${parsed.hasAt} 段=${segTypes}）`,
      );
      // 她刚说完话、60 秒内没人接：这一条就是"之后来的第一条"，回看它
      try {
        if (deferredReview?.shouldReview?.(key)) {
          deferredReview.fire(key, "single");
          deferredReview.close(key, "已回看这一条");
        }
      } catch {
        // 忽略
      }
      // 命中关注规则的，攒起来（不打断她，等她被叫到时一起看）
      try {
        const hits = watchHit(parsed.text, ev.user_id);
        if (hits.length) {
          l1Push({
            group: ev.group_id,
            who: nickname,
            text: parsed.text,
            hits,
            at: Date.now(),
          });
          logger.info?.(`[onebot] 关注命中（${hits.join("、")}）：${parsed.text.slice(0, 40)}`);
        }
      } catch {
        // 忽略
      }
      try {
        const entry = await sessions.ensure(key);
        // 旁听也要记下「当前会话目标」，否则 runProactive 生成的主动消息没有发送地址
        // 记下这条消息里的图，save_sticker 要用
        try {
          if (Array.isArray(parsed.images) && parsed.images.length) {
            const _imgs = parsed.images
              .map((x) => ({
                url: typeof x === "string" ? x : String(x?.url || ""),
                file: typeof x === "string" ? "" : String(x?.file || ""),
              }))
              .filter((x) => x.url || x.file)
              .slice(0, 4);
            entry.lastImages = _imgs;
            entry.lastImagesAt = Date.now();
            // 旁听时图只剩「[图片]」占位，原图地址留档：她想真看的时候用 look_image 取回来
            entry.imgLog = Array.isArray(entry.imgLog) ? entry.imgLog : [];
            for (const im of _imgs) {
              entry.imgLog.push({ ...im, at: Date.now(), from: String(nickname || "") });
            }
            if (entry.imgLog.length > 40) entry.imgLog = entry.imgLog.slice(-40);
          }
        } catch {
          // 忽略
        }
        entry.lastSpeaker = "them";
        entry.lastTarget = {
          ...ev,
          message_type: "group",
          group_id: Number(key.slice(6)),
          user_id: ev.user_id,
        };
        // 旁听也要统计活跃度——否则热群插话永远看不到「群很热闹」
        const nTs = Date.now();
        // 补推的旧消息不能算「刚刚发生」，否则冷群/热群判断都会失真
        const msgTs = Number(ev.time) * 1000 || Date.now();
        const isOld = nTs - msgTs > 5 * 60000;
        entry.lastMessageAt = Math.max(entry.lastMessageAt ?? 0, msgTs);
        groupMetaTouch(entry.key, { lastMessageAt: entry.lastMessageAt });
        if (!isOld) {
          entry.msgTimes = (entry.msgTimes ?? []).filter((t) => nTs - t < 60000);
          entry.msgTimes.push(nTs);
        }
        markRuntimeDirty();
        // 旁听也更新「这个群最后一次有动静」——否则 seen.lastTime 会一直停在
        // 上次回复的时刻，冷群判断就会误判（只更新时间，不记已回复的 id）
        try {
          const srec = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
          if (msgTs > (srec.lastTime ?? 0)) {
            srec.lastTime = msgTs;
            seenDirty = true;
            flushSeen();
          }
        } catch {
          // 忽略
        }

        // 热群插话已删除（4.1：主动只在活动里"看群"，不跟群热度挂钩）

        entry.observations = entry.observations ?? [];
        entry.observations.push(nickname + "：" + parsed.text.slice(0, 120));

        // 这个群正好有消息在合并缓冲里 → 把我也塞进去当语境，
        // 否则她只会看到"第一个叫她的人"，后面紧跟的补充/纠正全被漏掉
        try {
          const pendingBuf = typeof mergeBuf !== "undefined" ? mergeBuf.get(key) : null;
          if (pendingBuf && parsed.text) {
            pendingBuf.prompts.push(`[同一时段，${nickname} 也在说] ${parsed.text.slice(0, 150)}`);
            if (pendingBuf.prompts.length > 6) pendingBuf.prompts = pendingBuf.prompts.slice(-6);
            logger.info?.(`[onebot] 旁听消息并入合并缓冲：${key}`);
          }
        } catch {
          // 忽略
        }

        // 有人提到「肥鱼」但没 @ 她：
        // 先用模型判断这句是「直接叫她」还是「只是提到」，
        // 直接叫就立刻回，只是提到则按概率决定
        if (cfg.nameMentionEnabled !== false && !parsed.hasAt && !continuing) {
          try {
            const hit = /(肥鱼|大鱼|竹筒|鱼鱼)/.test(String(parsed.text || ""));
            if (hit) {
              const coolMs = (Number(cfg.nameMentionCooldownMinutes) || 15) * 60000;
              const coolOk = nowTs - (entry.lastNameJoinAt ?? 0) > coolMs;
              if (coolOk) {
                let isDirect = false;
                try {
                  const verdict = await sessions.generate(
                    key,
                    "（内部：判断下面这句话，说话人是在**直接叫肥鱼本人回应**（比如「肥鱼你说呢」「大肥鱼过来」），" +
                      "还是**只是在聊到肥鱼这个名字**（比如「大肥鱼今天怎么不吭声」「肥鱼那个机器人」）。" +
                      "只回两个字：直接 或 提到。不要解释。）\n句子：" +
                      String(parsed.text).slice(0, 200),
                  );
                  isDirect = /直接/.test(String(verdict || ""));
                  logger.info?.(`[onebot] 提到肥鱼的分析结果：${isDirect ? "直接叫" : "只是提到"}`);
                } catch {
                  // 模型判断失败就按「提到」处理
                }
                const chance = Number(cfg.nameMentionChance ?? 0.7);
                const willReply = isDirect || Math.random() < chance;
                if (willReply) {
                  entry.lastNameJoinAt = nowTs;
                  markRuntimeDirty();
                  logger.info?.(
                    `[onebot] ${isDirect ? "直接叫她" : "提到她"}（${nickname}：${parsed.text.slice(0, 30)}），接一句：${key}`,
                  );
                  audit({
                    kind: isDirect ? "name_direct" : "name_join",
                    key,
                    text: parsed.text.slice(0, 80),
                  });
                  void sessions
                    .runProactive(
                      key,
                      isDirect
                        ? "（群里有人直接叫你了。接不接、怎么接，你自己判断；想接就一句话自然地接上。）"
                        : "（群里有人在聊到你了，没有直接叫你。如果你觉得能接上，就用一句话自然地插进去——" +
                            "别像被点名报到那样正儿八经，可以顺着他们说的接或者自嘲一句；" +
                            "如果插不上，就什么都不说（只输出一个句号）。）",
                    )
                    .catch(() => {});
                }
              }
            }
          } catch {
            // 忽略
          }
        }

        // 话题窗口：最近 30 分钟的词
        try {
          entry.topicWindow = (entry.topicWindow ?? []).filter(
            (x) => Date.now() - x.t < 30 * 60000,
          );
          const words = String(parsed.text || "")
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ")
            .split(/\s+/)
            .flatMap((c) => {
              const out = [];
              for (let n = 2; n <= 4; n++) {
                for (let i = 0; i + n <= c.length; i++) out.push(c.slice(i, i + n));
              }
              return out;
            });
          if (words.length) entry.topicWindow.push({ t: Date.now(), w: words });
          if (entry.topicWindow.length > 60) entry.topicWindow.shift();
          // 群画像素材：最近 30 条（截断），供「各个群的印象」概括这个群什么样
          try {
            const gid = entry.key.slice(6);
            const prevRecent = loadGroupMeta()[gid]?.recent ?? [];
            const oneLine = `${nickname}：${String(parsed.text || "").replace(/\s+/g, " ").slice(0, 80)}`;
            groupMetaTouch(entry.key, {
              recent: [...prevRecent, { t: Date.now(), l: oneLine }].slice(-30),
            });
          } catch {
            // 忽略
          }
          const metaCnt = new Map();
          for (const it of entry.topicWindow) for (const w of it.w || []) if (w.length >= 2) metaCnt.set(w, (metaCnt.get(w) ?? 0) + 1);
          groupMetaTouch(entry.key, {
            lastMessageAt: Date.now(),
            top: [...metaCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w),
          });
        } catch {
          // 忽略
        }
        try {
          people.recordTopics(ev.user_id, parsed.text);
          people.markDirty?.();
        } catch {
          // 忽略
        }
        if (entry.observations.length > (cfg.observeLimit || 30)) entry.observations.shift();
        // 词频：2-4 字片段，用来识别群里的黑话/梗
        try {
          const freq = entry.wordFreq ?? (entry.wordFreq = new Map());
          const pure = parsed.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ");
          for (const chunk of pure.split(/\s+/)) {
            const c = String(chunk);
            for (let n = 2; n <= 4; n++) {
              for (let i = 0; i + n <= c.length; i++) {
                const w = c.slice(i, i + n);
                freq.set(w, (freq.get(w) ?? 0) + 1);
              }
            }
          }
          if (freq.size > 4000) entry.wordFreq = new Map([...freq].slice(-2000));
        } catch {
          // 忽略
        }
      } catch (err) {
        logger.warn?.(`[onebot] 记录群观察失败：${err?.message ?? err}`);
      }
      return;
    }

    if (!allowed(ev, continuing)) {
      logger.info?.(`[onebot] 未通过白名单/未 @：${conversationKey(ev)}（at=${parsed.hasAt} continuing=${continuing}）`);
      return;
    }

    // 注意：不在这里 markSeen —— 只有回复真正发出去之后才标记，
    // 这样「跑完但没发出」的消息（比如进程被重启打断）下次还能补回复。

    // 群活跃度统计
    if (ev.message_type === "group") {
      try {
        const ent = await sessions.ensure(key);
        const nowTs = Date.now();
        const realTs = Number(ev.time) * 1000 || nowTs;
        const stale = nowTs - realTs > 5 * 60000;
        ent.lastMessageAt = Math.max(ent.lastMessageAt ?? 0, realTs);
        if (!stale) {
          ent.msgTimes = (ent.msgTimes ?? []).filter((t) => nowTs - t < 60000);
          ent.msgTimes.push(nowTs);
        }
        ent.lastSpeaker = "them";
        // 有真人说话 → 冷群「等她开口」的闩解开
        ent.topicAwaitHuman = false;
        if (parsed.hasAt) {
          ent.lastMentionAt = nowTs;
          // 有人 @ 她 = 有人接话了，冷群话题标记可以解除
          ent.topicPending = false;
        }

        // 连发检测：同一个人连着说话、没人接
        const streak = ent.streak ?? (ent.streak = { userId: "", count: 0, lastAt: 0, joinedAt: 0 });
        // 只有「纯文字」才算连发：连发图片/转发/文件是在分享，不是在自言自语，
        // 而且非文字消息会打断连续性（必须连续三句文字才触发搭话）
        const pureText =
          !!String(parsed.text || "").trim() &&
          !(Array.isArray(parsed.images) && parsed.images.length) &&
          !(Array.isArray(parsed.forwards) && parsed.forwards.length) &&
          !(Array.isArray(parsed.files) && parsed.files.length);
        if (!pureText) {
          streak.count = 0;
          streak.userId = "";
          markRuntimeDirty();
        } else if (String(streak.userId) === String(ev.user_id)) {
          streak.count += 1;
          streak.lastAt = nowTs;
        } else {
          streak.userId = String(ev.user_id);
          streak.count = 1;
          streak.joinedAt = nowTs;
          streak.lastAt = nowTs;
        }
        markRuntimeDirty();

        // 4.1.3：连发搭话已删除（判据是"群安静了"，不是"有人在等人接"）

        // 记录完之后再判断要不要"热群插一句"
        if (cfg.activeJoinEnabled && cfg.autoActionsEnabled !== false) {
          // 她最近一次参与（被 @ 或说过话）距今多久
          const lastActive = Math.max(ent.lastMentionAt ?? 0, ent.lastReplyAt ?? 0);
          const idleFromActive = nowTs - lastActive;
          const cooldownOk =
            nowTs - (ent.lastActiveJoinAt ?? 0) >
            (Number(cfg.activeJoinCooldownMinutes) || 30) * 60000;
          if (
            ent.msgTimes.length >= (Number(cfg.activeJoinPerMinute) || 6) &&
            idleFromActive > (Number(cfg.activeJoinIdleMinutes) || 10) * 60000 &&
            cooldownOk
          ) {
            ent.lastActiveJoinAt = nowTs;
            markRuntimeDirty();
            logger.info?.(
              `[onebot] 群很热闹（${ent.msgTimes.length} 条/分钟）且她已 ${Math.round(idleFromActive / 60000)} 分钟没参与，插一句：${key}`,
            );
            audit({ kind: "active_join", key, perMinute: ent.msgTimes.length });
            void sessions
              .runProactive(
                key,
                "（这个群现在聊得很热闹。如果你想加入，就顺着最近的话题插一句自然的、短的、" +
                  "不抢戏的话；如果你觉得插不上或者话题不适合你，就什么都不说（只输出一个句号）。）",
              )
              .catch(() => {});
          }
        }
        // 冷群暖场的解除条件：只要「她开口之后有人说过话」就算有人回应。
        // 用消息发生时间比，补推的旧消息不会把刚设好的标记立刻清掉。
        const msgTs = Number(ev.time) * 1000 || Date.now();
        // 注意要用消息发生时间比，不能用「当前时间」——
        // 否则补推的旧消息会把刚设置好的标记立刻清掉。
        try {
          if (ent.topicPending && msgTs > (ent.lastTopicAt ?? 0)) {
            ent.topicPending = false;
            logger.info?.(`[onebot] 暖场后有人说话了，解除标记：${key}`);
            markRuntimeDirty();
          }
        } catch {
          // 忽略
        }
      } catch {
        // 统计失败不影响对话
      }
    }

    // 链接预览：私聊直接抓，群里只在 @ 时抓（省 token）
    let linkNote = "";
    if (cfg.linkPreview !== false && !!(ev.message_type !== "group" || parsed.hasAt)) {
      const lm = parsed.text.match(/https?:\/\/[^\s<>"']+/);
      if (lm) {
        const previewChars = Number(cfg.linkPreviewChars) || 600;
        const pv = await fetchLinkPreview(lm[0], previewChars, logger);
        if (pv) {
          const total = Number(pv.totalChars) || 0;
          const gotAll = total > 0 && total <= previewChars;
          linkNote = gotAll
            ? `[链接正文·全文 ${total} 字]\n` +
              (pv.title ? `标题：${pv.title}\n` : "") +
              `${pv.text}\n\n`
            : `[链接预览·全文共 ${total} 字，下面只给了前 ${previewChars} 字]\n` +
              (pv.title ? `标题：${pv.title}\n` : "") +
              `${pv.text}\n` +
              `（还有 ${Math.max(0, total - previewChars)} 字没看到。想看完整的就用 ` +
              `read_page({url: "${lm[0]}"})，要不要读你自己定。）\n\n`;
          logger.info?.(
            `[onebot] 链接预览：${(pv.title || lm[0]).slice(0, 40)}（全文 ${total} 字）`,
          );
          audit({ kind: "link_preview", url: lm[0], title: pv.title, total });
        }
      }
    }

    // 图片：只在真的要回复时才下载，最多 maxImagesPerMessage 张
    let imagePayloads = [];
    if (cfg.enableImages && parsed.images.length) {
      const picked = parsed.images.slice(0, cfg.maxImagesPerMessage || 2);
      for (const img of picked) {
        const got = await imagePayloadFrom(img.url);
        if (got) imagePayloads.push(got);
        else logger.warn?.(`[onebot] 图片取不到：${String(img.url).slice(0, 80)}`);
      }
      if (imagePayloads.length) {
        logger.info?.(`[onebot] 已取到 ${imagePayloads.length} 张图（${imagePayloads.map((x) => x.mediaType).join(",")}）`);
      }
    }
    if (!parsed.text && !imagePayloads.length && !parsed.forwards?.length && !parsed.files?.length && !parsed.hasAt) return;

    if (parsed.hasAt) {
      try {
        const ent0 = await sessions.ensure(key);
        ent0.lastMentionAt = Date.now();
      } catch {
        // 忽略
      }
    }
    logger.info?.(`[onebot] ← ${key} [${ev.sender?.nickname ?? ev.user_id}] ${parsed.text.slice(0, 60)}`);
    audit({
      kind: "inbound",
      key,
      userId: String(ev.user_id),
      name: nickname,
      text: parsed.text.slice(0, 200),
      images: imagePayloads.length,
    });

    // 记下这条消息里的图，save_sticker 要用（只有带图时才覆盖，文字消息不能把上一张图冲掉）
    try {
      if (Array.isArray(parsed.images) && parsed.images.length) {
        const entImg = await sessions.ensure(key);
        const _imgs = parsed.images
          .map((x) => ({
            url: typeof x === "string" ? x : String(x?.url || ""),
            file: typeof x === "string" ? "" : String(x?.file || ""),
          }))
          .filter((x) => x.url || x.file)
          .slice(0, 4);
        entImg.lastImages = _imgs;
        entImg.lastImagesAt = Date.now();
        // QQ 的图 URL 几分钟就过期：先落一份本地副本，之后看/存都有得用
        void cacheMessageImages({
          messageId: ev.message_id,
          images: _imgs,
          imagePayloadFrom,
          logger,
        });
        entImg.imgLog = Array.isArray(entImg.imgLog) ? entImg.imgLog : [];
        for (const im of _imgs) {
          entImg.imgLog.push({ ...im, at: Date.now(), from: String(nickname || "") });
        }
        if (entImg.imgLog.length > 40) entImg.imgLog = entImg.imgLog.slice(-40);
      }
    } catch {
      // 忽略
    }

    // 不再做「每人每小时 N 次」的硬限流。
    // 2.0 之后消息进 inbox 队列，wakeNow 串行处理、sendHuman 走单线程打字队列，
    // 节奏本来就由打字速度自然控制。再叠一层硬限流只会丢消息：
    //   · 群聊里静默丢弃（表现为「有人说话她没理」）
    //   · 私聊里甩一句硬编码的「你说得有点多，让我歇会儿」——那不是她说的话
    // 要限速，让队列和打字去限，别丢东西。

    // 有人评价她时，只记来源，不立刻改自我描述
    try {
      const t = String(parsed.text || "");
      if (/(你|肥鱼).{0,6}(像|是|挺|太|有点).{0,6}(机器|模板|人|冷|暖|较真|敷衍)/.test(t)) {
        noteMirrorSource(String(ev.user_id), t.slice(0, 60));
      }
    } catch {
      // 忽略
    }

    const who = people.describe(ev.user_id);
    // 只 @ 没说话：把前面几条聊天记录带上，别空着回
    let emptyAtNote = "";
    if (!String(parsed.text || "").trim() && parsed.hasAt) {
      emptyAtNote = "[对方只 @ 了你，没打字。]\n";
      if (ev.message_type === "group") {
        try {
          const hist = await client.call(
            "get_group_msg_history",
            { group_id: ev.group_id, count: 6 },
            6000,
          );
          const list = Array.isArray(hist?.messages) ? hist.messages : [];
          const lines = [];
          const imgUrls = [];
          let forwardId = "";
          for (const m of list) {
            const nm = m?.sender?.card || m?.sender?.nickname || "某人";
            const segs = Array.isArray(m?.message) ? m.message : [];
            const tx = segs
              .filter((x) => x?.type === "text")
              .map((x) => x?.data?.text ?? "")
              .join("")
              .trim();
            const imgSeg = segs.find((x) => x?.type === "image");
            const fwSeg = segs.find((x) => x?.type === "forward");
            const rpSeg = segs.find((x) => x?.type === "reply");
            let mark = "";
            if (rpSeg) mark += "↩︎";
            if (imgSeg) {
              const u = String(imgSeg?.data?.url || imgSeg?.data?.file || "");
              if (u) imgUrls.push(u);
              mark += "［图片］";
            }
            if (fwSeg) {
              if (!forwardId) {
                forwardId = String(fwSeg?.data?.id ?? fwSeg?.data?.message_id ?? fwSeg?.data?.resid ?? "");
              }
              mark += "［聊天记录］";
            }
            if (tx || mark) lines.push(`${nm}：${tx.slice(0, 80)}${mark}`);
          }
          lines.reverse();
          if (lines.length) {
            emptyAtNote += `[你被 @ 之前的聊天记录]\n${lines.join("\n")}\n`;
          }
          // 点名：不让她在十几条里猜
          if (lines.length) {
            const newest = lines[lines.length - 1] || "";
            const prev = lines[lines.length - 2] || "";
            if (newest) {
              emptyAtNote += "[他 @ 你之前最后一条：" + newest + "]\\n";
              if (prev) emptyAtNote += "[再上一条：" + prev + "]\\n";
              emptyAtNote += "（通常要接的就是这两条之一，先看清再答。）\\n";
            }
          }
          // 上面最后一张图也拿给她看
          if (imgUrls.length && cfg.enableImages) {
            const room = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
            const picks = imgUrls.slice(-Math.min(2, room));
            for (const u of picks) {
              const got = await imagePayloadFrom(u);
              if (got) imagePayloads.push(got);
            }
            if (picks.length) logger.info?.(`[onebot] 空 @ 时带上了上面 ${picks.length} 张图`);
          }
          // 上面如果有聊天合集，展开前 3 条
          if (forwardId) {
            try {
              const fres = await client.call("get_forward_msg", { id: forwardId }, 6000);
              const fmsgs = Array.isArray(fres?.messages) ? fres.messages : [];
              const flines = fmsgs.slice(0, 3).map((fm) => {
                const fn = fm?.sender?.card || fm?.sender?.nickname || "某人";
                const fsegs = Array.isArray(fm?.message) ? fm.message : [];
                const ft = fsegs
                  .filter((x) => x?.type === "text")
                  .map((x) => x?.data?.text ?? "")
                  .join("")
                  .trim();
                const hasImg = fsegs.some((x) => x?.type === "image");
                return ft || hasImg ? `${fn}：${ft.slice(0, 60)}${hasImg ? "［图片］" : ""}` : "";
              }).filter(Boolean);
              if (flines.length) {
                emptyAtNote += `[上面那个聊天记录（前 ${flines.length} 条，共 ${fmsgs.length} 条）]\n${flines.join("\n")}\n`;
                logger.info?.(`[onebot] 空 @ 时展开了上面的聊天合集（${fmsgs.length} 条）`);
              }
            } catch (fe) {
              logger.debug?.(`[onebot] 空 @ 展开合集失败：${fe?.message ?? fe}`);
            }
          }
        } catch (err) {
          logger.warn?.(`[onebot] 空 @ 拉历史失败：${err?.message ?? err}`);
        }
      }
      emptyAtNote +=
        "（对方只 @ 了你，没打字。上面是最近的聊天记录——你要自己判断他想让你看的是哪一条，" +
        "通常是最新的图片、链接、或那段聊天记录。针对那一条回应，具体说点内容，" +
        "别笼统地说「看过了」「怎么了」。实在判断不出来就接最近的话题讲一句。）\n\n";
    }

    // 他这轮没带图，但刚才发过图：把最近的图补给她看，让她自己判断值不值得存
    let noteRecentPics = false;
    if (cfg.enableImages && !imagePayloads.length && parsed.text && (parsed.hasAt || continuing)) {
      try {
        const entRecent = await sessions.ensure(key);
        const recentAt = Number(entRecent.lastImagesAt || 0);
        const recentImgs = Array.isArray(entRecent.lastImages) ? entRecent.lastImages : [];
        if (recentImgs.length && Date.now() - recentAt < 5 * 60_000) {
          const room = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
          for (const u of recentImgs.slice(-Math.min(2, room))) {
            const got = await imagePayloadFrom(u);
            if (got) imagePayloads.push(got);
          }
          if (imagePayloads.length) {
            noteRecentPics = true;
            logger.info?.(`[onebot] 补上他刚才发的 ${imagePayloads.length} 张图给她看`);
          }
        }
      } catch (e) {
        logger.debug?.(`[onebot] 补最近图片失败：${e?.message ?? e}`);
      }
    }
    let msgText = parsed.text || "（只有 @，没说话）";
    if (noteRecentPics) msgText += "（附图：他刚才发的图）";
    if (parsed.replyIds?.length && imagePayloads.length > 0 && !parsed.text) {
      msgText = "（@ 了你，并引用了上面那张图，没打字）";
    }
    // 分清是谁在说话：创造者本人 还是 助手代发
    const whoHint =
      ev.__fromWebUI && ev.__viaAssistant
        ? "\n（这条打着「助手代发」的标——是 AI 助手在替创造者操作，**不是创造者本人打的**。" +
          "正常回答就行，但如果涉及「你决定」「你同意吗」这类要创造者拍板的事，" +
          "要说清楚「等创造者本人确认」，别把助手的话当成创造者的意思。）\n"
        : "";

    // 她自己该知道的事：创造者能发什么指令（不然问起来只能瞎猜）
    const cmdHint =
      "\n（创造者能直接发这些指令，桥会拦下来处理，你不用「听懂」：" +
      "活动一下 / 去探险 / 读点书 / 玩会儿 / 想想事 / 回忆一下 / 憧憬一下 / 研究代码 / 连做 N 轮 / " +
      "重置活动额度 / 状态 / 需求清单 / 各个群印象 / 全部想法 / 全部自省 / 记忆查询 xxx / " +
      "记住 xxx / 提醒我 xxx / 查看提醒 / 取消提醒 / 改配置 xxx / 以后叫我 xxx / " +
      "申请加群 xxx / 发条说说 / 代发言 / 定向搭话 / 退群 / 同意 / 拒绝 / 帮助。" +
      "有人问「有哪些指令」就照着答，不懂细节就用 owner_commands 查。）\n";

    // 网页聊天用单独的标签，历史才能按渠道分开
    // 网页聊天还要再分一层：创造者本人 / 助手代发
    const channelTag = ev.__fromWebUI
      ? ev.__viaAssistant
        ? "[网页聊天·助手代发]" // ← 这条不是创造者打的，是 AI 助手在替他操作
        : "[网页聊天]"
      : "[QQ私聊]";
    const bodyBase =
      ev.message_type === "group"
        ? `[QQ群消息] 群号 ${ev.group_id}，发言人 ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`
        : `${channelTag} ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`;
    let observed = "";
    if (ev.message_type === "group" && cfg.groupObserve) {
      try {
        const entry = await sessions.ensure(conversationKey(ev));
        const list = entry.observations ?? [];
        if (list.length) observed = "\n[群里最近的聊天]\n" + list.slice(-12).join("\n");
        // 再补一段「按你的关注规则捞出来的」——这些才是她真正想看的
        try {
          const l1 = l1TakeText();
          if (l1) observed += l1;
        } catch {
          // 忽略
        }
      } catch {
        // 忽略
      }
    }
    let slangNote = "";
    if (ev.message_type === "group" && cfg.slangEnabled !== false) {
      // 优先：最近 30 分钟在聊什么
      try {
        const ent = sessions.entries.get(key);
        const win = ent?.topicWindow ?? [];
        if (win.length >= 3) {
          const cnt = new Map();
          const stop = new Set([
            "这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们",
            "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么",
            "知道", "觉得", "应该", "可能", "真的", "有点", "一直", "时候", "自己", "这样",
          ]);
          for (const item of win) {
            for (const w of item.w) {
              if (stop.has(w)) continue;
              cnt.set(w, (cnt.get(w) ?? 0) + 1);
            }
          }
          const top = [...cnt.entries()]
            .filter(([w, n]) => n >= 3 && w.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([w]) => w);
          if (top.length >= 2) slangNote = `[这个群最近在聊] ${top.join("、")}\n`;
        }
      } catch {
        // 忽略
      }
      try {
        const ent = sessions.entries.get(key);
        const freq = ent?.wordFreq;
        if (!slangNote && freq && freq.size) {
          const stop = new Set(["这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们", "现在", "然后", "因为", "所以", "还是", "已经", "一个"]);
          const top = [...freq.entries()]
            .filter(([w, n]) => n >= 3 && !stop.has(w) && w.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([w]) => w);
          if (top.length >= 2) slangNote = `[这个群最近常提] ${top.join("、")}\n`;
        }
      } catch {
        // 忽略
      }
    }

    const vibe = [timeContext(), moodContext()].filter(Boolean).join("\n");
    const vibeNote = vibe ? `${vibe}\n\n` : "";

    // ── 引用解析（三层兜底，与转发开关解耦） ──
    // 1) get_msg  2) 本地落盘  3) 引用段自带的摘要
    if (parsed.replyIds?.length) {
      const qid0 = String(parsed.replyIds[0]);
      let qsegs = [];
      try {
        const quoted = await client.call("get_msg", { message_id: qid0 }, 6000);
        qsegs = Array.isArray(quoted?.message)
          ? quoted.message
          : Array.isArray(quoted?.content)
          ? quoted.content
          : [];
        logger.info?.(
          `[onebot] 引用解析：get_msg 命中 id=${qid0} types=${JSON.stringify(qsegs.map((x) => x?.type))}`,
        );
        const qText1 = qsegs
          .filter((x) => x?.type === "text")
          .map((x) => String(x?.data?.text ?? ""))
          .join("")
          .trim();
        if (qText1 && qText1 !== String(parsed.text || "").trim()) {
          parsed.quotedText = qText1.slice(0, 300);
          parsed.quotedFrom = String(quoted?.sender?.card || quoted?.sender?.nickname || "");
        }
        // 被引用消息里的图
        if (cfg.enableImages && imagePayloads.length < (cfg.maxImagesPerMessage || 2)) {
          const qImg = qsegs.find((x) => x?.type === "image");
          const u = String(qImg?.data?.url || qImg?.data?.file || "");
          if (u) {
            const got = await imagePayloadFrom(u);
            if (got) imagePayloads.push(got);
            else logger.warn?.("[onebot] 引用消息里的图取不到");
          }
        }
        // 被引用的是转发
        const fwSeg = qsegs.find((x) => x?.type === "forward");
        if (fwSeg) {
          parsed.forwards.push({
            id: String(fwSeg.data?.id ?? fwSeg.data?.message_id ?? fwSeg.data?.resid ?? ""),
            rawKeys: Object.keys(fwSeg.data ?? {}),
            raw: fwSeg.data ?? {},
          });
        }
      } catch (err) {
        logger.info?.(
          `[onebot] 引用解析：get_msg 失败（${String(err?.message ?? err).slice(0, 50)}），改查本地`,
        );
      }
      // 2) 本地落盘兜底（旧消息 / 缓存被清）
      if (!parsed.quotedText) {
        try {
          const local = findMsgInLog(msgLogKeyOf(ev), qid0);
          if (local) {
            if (local.x) parsed.quotedText = String(local.x).slice(0, 300);
            if (local.n) parsed.quotedFrom = String(local.n);
            if (local.fw?.id && !parsed.forwards?.length) {
              parsed.forwards.push({ id: String(local.fw.id), rawKeys: [], raw: {} });
            }
            if (
              local.img?.length &&
              cfg.enableImages &&
              imagePayloads.length < (cfg.maxImagesPerMessage || 2)
            ) {
              const u = String(local.img[0]?.url || local.img[0]?.file || "");
              if (u) {
                const got = await imagePayloadFrom(u);
                if (got) imagePayloads.push(got);
              }
            }
            logger.info?.(`[onebot] 引用解析：本地命中 id=${qid0}`);
          }
        } catch {
          // 本地查不到就算了
        }
      }
      // 3) 引用段自带摘要
      if (!parsed.quotedText && parsed.replySummary) {
        parsed.quotedText = String(parsed.replySummary).slice(0, 300);
        logger.info?.("[onebot] 引用解析：只有摘要");
      }
      if (!parsed.quotedText) logger.info?.(`[onebot] 引用解析：什么都没取到 id=${qid0}`);
    }
    // 被 @ 但本条既没转发也没引用：回看最近几条，找上面刚发的转发
    if (
      cfg.forwardPreview !== false &&
      !parsed.forwards?.length &&
      !parsed.replyIds?.length &&
      parsed.hasAt &&
      ev.message_type === "group"
    ) {
      try {
        const hist = await client.call(
          "get_group_msg_history",
          { group_id: ev.group_id, count: Number(cfg.forwardLookback) || 25 },
          8000,
        );
        const list = Array.isArray(hist?.messages) ? hist.messages : [];
        for (const m of [...list].reverse()) {
          const segs2 = Array.isArray(m?.message) ? m.message : Array.isArray(m?.content) ? m.content : [];
          const fw = segs2.find((x) => x?.type === "forward");
          if (fw) {
            parsed.forwards.push({
              id: String(fw.data?.id ?? fw.data?.message_id ?? fw.data?.resid ?? ""),
              rawKeys: Object.keys(fw.data ?? {}),
              raw: fw.data ?? {},
            });
            logger.info?.(
              `[onebot] 从最近历史里找到了转发：id=${parsed.forwards[parsed.forwards.length - 1].id}`,
            );
            break;
          }
        }
      } catch (err) {
        logger.debug?.(`[onebot] 回看历史失败：${err?.message ?? err}`);
      }
    }

    let forwardNote = "";
    if (cfg.forwardPreview !== false && parsed.forwards?.length) {
      const only = parsed.forwards[0];
      if (only?.summaryOnly) {
        forwardNote = `[对方引用了这条消息] ${only.summaryOnly}\n（查不到原文，只能看到摘要）\n\n`;
      }
      try {
        const fw = parsed.forwards[0];
        if (fw?.summaryOnly) throw new Error("skip");
        logger.info?.(
          `[onebot] 收到转发段：id=${fw.id || "(空)"} keys=${JSON.stringify(fw.rawKeys)} raw=${JSON.stringify(fw.raw).slice(0, 200)}`,
        );
        let res;
        try {
          res = await client.call("get_forward_msg", { id: fw.id }, 8000);
        } catch (e1) {
          logger.warn?.(`[onebot] get_forward_msg(id) 失败：${e1?.message ?? e1}，改用 message_id`);
          res = await client.call("get_forward_msg", { message_id: fw.id }, 8000);
        }
        if (!res || (Array.isArray(res?.messages) && res.messages.length === 0)) {
          logger.warn?.(`[onebot] 转发展开为空，返回：${JSON.stringify(res).slice(0, 300)}`);
        }
        const msgs = Array.isArray(res?.messages) ? res.messages : Array.isArray(res) ? res : [];
        const forwardImages = [];
        const lines = [];
        let nestedDone = false;
        for (const m of msgs.slice(0, Number(cfg.forwardMaxItems) || 2)) {
          const name = m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || "某人";
          const segs2 = Array.isArray(m?.content)
            ? m.content
            : Array.isArray(m?.message)
              ? m.message
              : [];
          for (const x of segs2) {
            if (x?.type === "image") {
              const u = String(x?.data?.url || x?.data?.file || "");
              if (u) forwardImages.push(u);
            }
          }
          let t = segs2
            .filter((x) => x?.type === "text")
            .map((x) => x?.data?.text ?? "")
            .join("")
            .trim();

          // 兜底：有的实现把正文放在 raw_message（CQ 码字符串）或 content/message 本身是字符串，
          // 段里没有 text。以前这里直接拿到空串，整条转发就只剩「转发了」三个字。
          if (!t) {
            for (const cand of [m?.raw_message, m?.content, m?.message]) {
              if (typeof cand === "string" && cand.trim()) {
                t = cand
                  .replace(/\[CQ:[^\]]*\]/g, "")
                  .replace(/\s+/g, " ")
                  .trim();
                if (t) break;
              }
            }
          }
          if (!t && segs2.some((x) => x?.type === "image")) t = "［图片］";
          if (!t && Array.isArray(m?.content) && m.content.length) {
            logger.debug?.(`[onebot] 转发表项无文本，keys=${JSON.stringify(Object.keys(m))}`);
          }

          // 内层转发：递归展开一个，最多 3 条
          const subFw = segs2.find((x) => x?.type === "forward");
          if (subFw && !nestedDone) {
            nestedDone = true;
            try {
              const subId = String(subFw.data?.id ?? subFw.data?.message_id ?? subFw.data?.resid ?? "");
              if (subId) {
                const subRes = await client.call("get_forward_msg", { id: subId }, 6000);
                const subMsgs = Array.isArray(subRes?.messages)
                  ? subRes.messages
                  : Array.isArray(subRes)
                    ? subRes
                    : [];
                const subLines = subMsgs
                  .slice(0, 3)
                  .map((sm) => {
                    const sn =
                      sm?.sender?.card || sm?.sender?.nickname || sm?.sender?.user_id || "某人";
                    const ssegs = Array.isArray(sm?.content)
                      ? sm.content
                      : Array.isArray(sm?.message)
                        ? sm.message
                        : [];
                    const st = ssegs
                      .filter((x) => x?.type === "text")
                      .map((x) => x?.data?.text ?? "")
                      .join("")
                      .trim();
                    return st ? `${sn}：${st.slice(0, 50)}` : "";
                  })
                  .filter(Boolean);
                if (subLines.length) {
                  t += `\n  ↳[内层转发，共 ${subMsgs.length} 条，看前 ${subLines.length} 条] ${subLines.join("；")}`;
                }
              }
            } catch (e2) {
              logger.debug?.(`[onebot] 内层转发展开失败：${e2?.message ?? e2}`);
            }
          }

          if (t) lines.push(`${name}：${t.slice(0, 220)}`);
        }
        // 转发里的第一张图也拿给模型看
        if (forwardImages.length && cfg.enableImages !== false) {
          const limit = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
          let gotCount = 0;
          for (const u of forwardImages.slice(0, Math.min(2, limit))) {
            const got = await downloadImage(u, cfg.maxImageBytes || 6000000);
            if (got) {
              imagePayloads.push(got);
              gotCount += 1;
            }
          }
          if (gotCount) logger.info?.(`[onebot] 已取到转发展开里的 ${gotCount} 张图`);
        }
        // 记下转发 id，供 read_forward_more 工具继续展开
        try {
          const ent = await sessions.ensure(key);
          ent.lastForward = { id: fw.id, total: msgs.length, at: Date.now() };
        } catch {
          // 忽略
        }
        if (lines.length) {
          forwardNote =
            `[转发聊天记录（前 ${lines.length} 条，共 ${msgs.length} 条）]\n` +
            lines.join("\n") +
            (msgs.length > lines.length
              ? "\n（如果这个话题你感兴趣，可以调 read_forward_more 看后面几条）\n"
              : "") +
            "\n";
        }
      } catch (err) {
        logger.warn?.(`[onebot] 转发展开失败：${err?.message ?? err}`);
      }
    }

    // 文本文件：读前 1000 字
    let fileNote = "";
    if (cfg.filePreview !== false && parsed.files?.length) {
      const f = parsed.files[0];
      try {
        const okExt = /\.(txt|md|log|json|csv|yml|yaml|ini|conf)$/i.test(f.name);
        if (!okExt) {
          fileNote = `[收到文件：${f.name}（不是文本格式，未展开）]\n\n`;
        } else {
          let url = "";
          if (ev.message_type === "group") {
            const r = await client.call(
              "get_group_file_url",
              { group_id: ev.group_id, file_id: f.id, busid: f.busid ?? 0 },
              8000,
            );
            url = String(r?.url ?? r?.file ?? "");
          } else {
            const r = await client.call(
              "get_private_file_url",
              { user_id: ev.user_id, file_id: f.id },
              8000,
            );
            url = String(r?.url ?? r?.file ?? "");
          }
          if (!url) throw new Error("拿不到下载地址");
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(12000),
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const maxBytes = Number(cfg.fileMaxBytes) || 1048576;
          const body2 = buf.subarray(0, maxBytes).toString("utf8");
          const limit = Number(cfg.filePreviewChars) || 1000;
          const snippet = body2.slice(0, limit);
          fileNote =
            `[文件 ${f.name}${buf.length > maxBytes ? "（超大，只读头部）" : ""}，前 ${snippet.length} 字]\n` +
            snippet +
            "\n\n";
        }
      } catch (err) {
        logger.warn?.(`[onebot] 文件预览失败：${err?.message ?? err}`);
        fileNote = `[收到文件：${f.name}（读取失败）]\n\n`;
      }
    }

    let crossNote = "";
    if (cfg.crossGroupMemory && ev.message_type === "group") {
      const digest = otherGroupDigest(key, cfg.crossGroupMax);
      if (digest) {
        crossNote =
          `[你其他群最近在聊（仅供你了解，不要在这里回答那边的问题）] ${digest}\n`;
      }
    }

    let recallNote = "";
    if (cfg.recallEnabled && cfg.recallAutoTrigger && /(记得|上次|之前|以前|提过|说过|那次)/.test(parsed.text)) {
      try {
        const entryForRecall = await sessions.ensure(key);
        const res = await recallSearch(entryForRecall.sessionId, parsed.text, { cross: false });
        if (res.ok && res.hits?.length) {
          recallNote = renderRecall(res.hits);
          logger.info?.(`[onebot] 自动回忆命中 ${res.hits.length} 条`);
        }
      } catch (err) {
        logger.debug?.(`[onebot] 自动回忆失败：${err?.message ?? err}`);
      }
    }

    const catchupNote = ev.__catchup
      ? "（你刚才离线了一阵，这是恢复连接后补看到的消息，直接回一句就好，不要解释掉线。）\n"
      : "";
    let factLine = "";
    if (ev.message_type !== "group" || cfg.shareFactsToGroup) {
      const rendered = facts.render(6);
      if (rendered) factLine = `[你记得的事] ${rendered}\n`;
    }
    // ── 分层记忆注入（L0 自我 / L3 核心 / L2 摘要 / 相关记忆）──
    let memoryNote = "";
    try {
      const parts = [];
      // L0/L3/L2 已移到系统提示的人格投影（persona.js），这里只留与本条消息相关的记忆
      // 相关记忆：多入口并行游走（最深 10 跳，权重衰减）
      try {
        const entries = [];
        const zh = String(parsed.text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
        // 入口 1-2：消息里的 2-4 字词（最多取 3 个）
        const words = [];
        for (let i = 0; i + 2 <= Math.min(zh.length, 24) && words.length < 3; i++) {
          for (let len = 4; len >= 2; len--) {
            const w = zh.slice(i, i + len);
            if (w.length === len && !/^(什么|怎么|这个|那个|就是|没有|可以|不是|现在|还是)$/.test(w)) {
              words.push(w);
              break;
            }
          }
        }
        for (const w of words) entries.push(`topic:${w}`);
        // 入口 3：当前说话人
        if (ev.user_id) entries.push(`person:${String(ev.user_id)}`);
        // 入口 4：今天
        entries.push(`time:${new Date().toISOString().slice(0, 10)}`);
        // 三成时候不深想，只做浅层联想（人也不会每句话都想很远）
        const walkChance = Number(cfg.memoryWalkChance ?? 0.7);
        if (entries.length >= 2 && Math.random() < walkChance) {
          const walked = netWalk(entries, { top: 5 + Math.floor(Math.random() * 4) });
          if (walked.length) {
            const lines = walked.map((x) => {
              const n2 = x.node;
              const d = new Date(n2.at);
              const when = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const hop = x.depth ? `（${x.depth} 跳·${x.via}）` : "";
              return `· [${n2.kind} ${when}]${hop} ${String(n2.text || "").slice(0, 70)}`;
            });
            parts.push(`[你顺着想起的]\n${lines.join("\n")}\n`);
          }
        }
      } catch {
        // 游走失败不影响主流程
      }
      if (parts.length) memoryNote = parts.join("\n") + "\n";
    } catch {
      // 注入失败不影响主流程
    }

    // 引用了某条消息：把那段也给她看，否则容易答非所问
    let quoteNote = "";
    if (parsed.quotedText) {
      quoteNote = `\n[对方引用的那条消息]${parsed.quotedFrom ? parsed.quotedFrom + "：" : ""}${parsed.quotedText}\n`;
    } else if (parsed.replyIds?.length && parsed.replySummary) {
      // 原文查不到（旧客户端消息），用摘要兜底
      quoteNote = `\n[对方引用的那条消息]（只有摘要）${parsed.replySummary}\n`;
    }

    // 续聊机制已删除：进到这里的一定是 @ 或引用，不需要额外说明
    const followNote = "";
    const notesOnly =
      vibeNote +
      memoryNote +
      cmdHint +
      whoHint +
      slangNote +
      emptyAtNote +
      quoteNote +
      followNote +
      forwardNote +
      fileNote +
      catchupNote +
      recallNote +
      linkNote +
      crossNote +
      factLine;
    const body = notesOnly + bodyBase + observed;
    const ownerNote =
      cfg.ownerId && String(ev.user_id) === String(cfg.ownerId) && ev.message_type !== "group"
        ? "（这是你的创造者。）\n"
        : "";
    const lenHint = formatLenHint();
    // 她需要知道自己是不是刚断过线，否则会莫名其妙答不上对方的话
    const outageNote = recentOutageNote();
    const prompt = stripLoneSurrogates(
      (
        (cfg.styleHint
          ? `${cfg.styleHint}\n${lenHint}\n`
          : `${lenHint}\n`) +
          (cfg.freedomHint ? `${cfg.freedomHint}\n` : "") +
          (cfg.changeHint ? `${cfg.changeHint}\n` : "") +
          (cfg.searchHint ? `${cfg.searchHint}\n` : "") +
          `${outageNote ? outageNote + "\n" : ""}${ownerNote}${body}`
      ).trim(),
    );
    try {
      state.pendingPromptForDiag = prompt;
    } catch {
      // 忽略
    }

    // 记下这一轮她真正看到的图（含引用/转发补进来的），save_sticker 只认这些
    try {
      const entSeen = await sessions.ensure(key);
      entSeen.currentTurnImages = imagePayloads.length
        ? imagePayloads.map((p) => p?.srcUrl).filter(Boolean)
        : [];
      entSeen.currentTurnImageData = imagePayloads.length
        ? imagePayloads.slice(0, 4).map((p) => ({ url: p?.srcUrl, data: p?.data, mediaType: p?.mediaType }))
        : [];
    } catch {
      // 忽略
    }

    // 群里的 @/引用：先等 5~15 秒（看到提示→打开软件→读几条），再叫她
    if (ev.message_type === "group" && namedCall) {
      attention?.request?.(key, (extra) => {
        try {
          const note = extra ? `（这是你看到的 ${extra + 1} 条）\n` + REVIEW_PROMPT + "\n" : "";
          enqueue(key, ev, note + notesOnly, imagePayloads);
        } catch (err) {
          logger?.warn?.("[onebot] 注意力入队失败：" + (err?.message ?? err));
        }
      });
      return;
    }
    enqueue(key, ev, notesOnly, imagePayloads);
  };
}

export {  };
