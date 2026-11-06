// 主动轮询：漏 @、好友请求、离线补看。

export function createPolling(ctx) {
  const { allGroupIds, audit, cfg, client, health, logger, notifiedFriends, pendingFriends, processingIds, recentIds, saveHealth, seenState, sessions } = ctx;
  async function pollFriendRequests() {
      if (cfg.friendRequests === false) return;
      if (!client.connected) return;
      let arr = [];
      // 首选 NapCat 补丁暴露的 get_buddy_req（「联系人-好友通知」的数据源）
      try {
        const res = await client.call("get_buddy_req", {}, 8000);
        const list = res?.buddyReqs ?? res?.data?.buddyReqs ?? null;
        if (Array.isArray(list)) {
          arr = list
            .filter((r) => r && r.isDecide === false)
            .map((r) => ({
              uid: String(r.friendUid ?? ""),
              flag: String(r.friendUid ?? ""),
              reqTime: String(r.reqTime ?? ""),
              name: String(r.friendNick ?? "").trim(),
              message: String(r.extWords ?? "").trim(),
              groupCode: String(r.groupCode ?? ""),
              source: String(r.addSource ?? ""),
            }));
        }
      } catch {
        // 没有补丁就退回可疑申请接口
      }
      if (!arr.length) {
        try {
          const res = await client.call("get_doubt_friends_add_request", { count: 50 }, 8000);
          const raw = Array.isArray(res) ? res : (res?.data ?? []);
          if (Array.isArray(raw)) {
            arr = raw.map((r) => ({
              uid: String(r?.friendUid ?? r?.user_id ?? r?.uid ?? r?.uin ?? ""),
              flag: String(r?.friendUid ?? r?.flag ?? r?.user_id ?? ""),
              reqTime: String(r?.reqTime ?? ""),
              name: String(r?.friendNick ?? r?.nickname ?? r?.nick ?? "").trim(),
              message: String(r?.extWords ?? r?.reason ?? r?.message ?? "").trim(),
              groupCode: String(r?.groupCode ?? ""),
              source: "好友通知",
            }));
          }
        } catch (err) {
          logger.debug?.(`[onebot] 查好友申请失败：${err?.message ?? err}`);
        }
      }

      for (const r of arr) {
        const key = r.flag || r.uid || `${r.name}:${r.message}`;
        if (!key || notifiedFriends.has(key)) continue;
        notifiedFriends.add(key);
        pendingFriends.set(key, { ...r, at: Date.now() });
        logger.info?.(`[onebot] 发现好友申请：${r.name || r.uid}（${r.source || "未知来源"}）`);
        const where = r.groupCode ? `\n来自群：${r.groupCode}` : "";
        const text =
          `有人申请加我好友${r.name ? `：${r.name}` : ""}` +
          (r.uid ? `\n账号：${r.uid}` : "") +
          where +
          (r.message ? `\n验证消息：${r.message}` : "") +
          `\n\n回复「同意好友」或「拒绝好友」。`;
        if (cfg.ownerId) {
          await client.sendPrivate(cfg.ownerId, text);
          audit({ kind: "friend_request", uid: r.uid, name: r.name, msg: r.message });
        }
      }
    }

  async function catchUpPrivate() {
      const keys = new Set();
      for (const k of Object.keys(seenState)) {
        if (k.startsWith("private:")) keys.add(k);
      }
      for (const k of sessions.entries.keys()) {
        if (k.startsWith("private:")) keys.add(k);
      }
      for (const key of keys) {
        const uid = Number(key.slice(8));
        if (!uid || !client.connected) continue;
        const rec = seenState[key] ?? {};
        const since = Number(rec.lastTime) || 0;
        const done = new Set((rec.ids ?? []).map(String));
        try {
          const res = await client.call(
            "get_friend_msg_history",
            { user_id: uid, count: 20 },
            6000,
          );
          const list = Array.isArray(res) ? res : (res?.messages ?? []);
          if (!Array.isArray(list) || !list.length) continue;
          let caught = 0;
          for (const m of [...list].reverse()) {
            const mid = String(m?.message_id ?? "");
            if (!mid || recentIds.has(mid) || done.has(mid)) continue;
            const msgTs = Number(m?.time) * 1000 || 0;
            if (msgTs && since && msgTs <= since) continue;
            // 跳过自己发的
            const from = String(m?.sender?.user_id ?? m?.user_id ?? "");
            if (from && from === String(cfg.selfId)) continue;
            const ev = {
              ...m,
              post_type: "message",
              message_type: "private",
              sub_type: m?.sub_type ?? "friend",
              self_id: cfg.selfId,
              user_id: Number(from || uid),
              sender: m?.sender ?? { user_id: Number(from || uid) },
              // NapCat 在私聊消息里塞的 group_id 是「群临时会话的来源群」。
              // 留着它（eventTarget 会把它变成 __groupTemp，走 send_group_temp_msg），
              // 但绝不能被当成「发到哪个群」——makeEvent 那边只对 group 消息取 groupId。
            };
            logger.info?.(`[onebot] 补回复私聊：${from || uid} 消息 ${mid}`);
            audit({ kind: "catchup_private", key, messageId: mid });
            try {
              await client.onEvent(ev);
            } catch (err) {
              logger.warn?.(`[onebot] 补回复私聊失败：${err?.message ?? err}`);
            }
            caught += 1;
            if (caught >= 2) break;
          }
        } catch (err) {
          logger.debug?.(`[onebot] 拉私聊历史失败 ${uid}：${err?.message ?? err}`);
        }
      }
    }

  async function pollMissedMentions() {
      if (cfg.pollMentions === false) return;
      if (!client.connected) return; // 掉线时不刷「拉历史失败」
      const count = Math.max(1, Number(cfg.pollMentionsCount) || 3);
      const targets = await allGroupIds();
      for (const gid of targets) {
        const key = `group:${gid}`;
        try {
          const hist = await client.call(
            "get_group_msg_history",
            { group_id: gid, count },
            6000,
          );
          const list = Array.isArray(hist?.messages) ? hist.messages : [];
          health.lastPollAt = Date.now();
          // 事件心跳：历史里最新一条「非 @ 我」的消息，桥收到过吗？
          try {
            const latestPlain = [...list]
              .reverse()
              .find(
                (m) =>
                  !(Array.isArray(m?.message) ? m.message : []).some(
                    (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
                  ),
              );
            const lid = String(latestPlain?.message_id ?? "");
            if (lid && !recentIds.has(lid)) {
              const ts = Number(latestPlain?.time) * 1000 || 0;
              if (!ts || Date.now() - ts < 300000) {
                if (!health.eventMissSince) health.eventMissSince = Date.now();
              }
            } else if (lid) {
              health.eventMissSince = 0;
            }
          } catch {
            // 忽略
          }

          const rec = seenState[key] ?? {};
          const replied = new Set(Array.isArray(rec.ids) ? rec.ids.map(String) : []);
          for (const m of [...list].reverse()) {
            const segs = Array.isArray(m?.message) ? m.message : [];
            const mentionsMe = segs.some(
              (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
            );
            if (!mentionsMe) continue;
            // 只补「纯 @ 无文字」的消息——带字的消息腾讯会正常推送实时事件，
            // 轮询再插手只会重复回复。漏掉带字消息由「重连补回复」兜底。
            const bodyText = segs
              .filter((x) => x?.type === "text")
              .map((x) => x?.data?.text ?? "")
              .join("")
              .trim();
            if (bodyText) continue;
            const mid = String(m?.message_id ?? "");
            // 已回复 / 正在处理 / 实时链路已经处理过 —— 统统跳过
            // （处理失败的重试交给「重连补回复」，轮询只负责实时收不到的消息）
            if (!mid || replied.has(mid) || processingIds.has(mid) || recentIds.has(mid)) {
              continue;
            }
            // 只补最近 10 分钟内的
            const ts = Number(m?.time) * 1000 || 0;
            if (ts && Date.now() - ts > 10 * 60 * 1000) continue;
            const ev = {
              ...m,
              post_type: "message",
              message_type: "group",
              group_id: gid,
              user_id: m?.sender?.user_id,
              time: m?.time,
            };
            logger.info?.(`[onebot] 轮询发现未回复的 @：群 ${gid} 消息 ${mid}`);
            audit({ kind: "poll_mention", key, messageId: mid });
            recentIds.delete(mid); // 允许重试（上次可能失败了）
            ev.__fromPoll = true;
            try {
              await client.onEvent(ev);
            } catch (perr) {
              logger.warn?.(`[onebot] 轮询处理 ${mid} 失败：${perr?.message ?? perr}`);
            }
          }
        } catch (err) {
          health.apiFailStreak = (health.apiFailStreak ?? 0) + 1;
          logger.warn?.(`[onebot] 轮询拉历史失败 ${gid}：${err?.message ?? err}`);
        }
      }
      health.apiFailStreak = 0;
      saveHealth();
    }

  return { pollMissedMentions, pollFriendRequests, catchUpPrivate };
}

export {  };
