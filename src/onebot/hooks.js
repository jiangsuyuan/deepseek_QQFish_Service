// 重连后的补偿动作。

export function createOnReconnected(app) {
  const { audit, catchUpPrivate, cfg, client, logger, recentIds, seenState, sessions, sleep, pluginCtx: ctx } = app;
  return async () => {
    try {
      // 先补私聊（NapCat 有 get_friend_msg_history）
      await catchUpPrivate();
    } catch (err) {
      logger.warn?.(`[onebot] 私聊补回复异常：${err?.message ?? err}`);
    }
    try {
      const groups = new Set();
      for (const gid of cfg.prewarmGroups ?? []) groups.add(String(gid));
      for (const [k] of sessions.entries) {
        if (k.startsWith("group:")) groups.add(k.slice(6));
      }
      // 关键：历史上处理过的群（包括临时拉的群）也要补
      for (const k of Object.keys(seenState)) {
        if (k.startsWith("group:")) groups.add(k.slice(6));
      }
      for (const gid of groups) {
        try {
          // 按「上次处理到现在隔了多久」决定拉多少条：
          // 掉线越久，需要的窗口越大；但每群最多补 2 条，不会刷屏
          const prevRec = seenState[`group:${gid}`] ?? {};
          const sinceTs = Number(prevRec.lastTime) || 0;
          const downMin = sinceTs ? (Date.now() - sinceTs) / 60000 : 999;
          const wantCount =
            downMin > 180 ? 120 : downMin > 30 ? 80 : downMin > 5 ? 40 : 20;
          const res = await client.call("get_group_msg_history", {
            group_id: Number(gid),
            count: wantCount,
          });
          if (downMin > 30) {
            logger.info?.(
              `[onebot] 群 ${gid} 已 ${Math.round(downMin)} 分钟没处理，拉最近 ${wantCount} 条找漏掉的 @`,
            );
          }
          const list = Array.isArray(res) ? res : res?.messages ?? [];
          const rec = seenState[`group:${gid}`] ?? {};
          const done = new Set(Array.isArray(rec.ids) ? rec.ids.map(String) : []);
          const since = rec.lastTime ?? 0;
          const hasIds = Array.isArray(rec.ids) && rec.ids.length > 0;
          let caught = 0;
          for (const m of [...list].reverse()) {
            const mid = String(m.message_id ?? m.id ?? "");
            if (!mid || recentIds.has(mid) || done.has(mid)) continue;
            const msgTs = Number(m.time) * 1000 || 0;
            // 时间过滤始终生效：比「最后一次处理」更早的消息一律不补。
            // 之前只在「没有 ids」时才过滤，id 记录不全时会把几天前的老消息重新回一遍。
            if (msgTs && since && msgTs <= since) continue;
            const segs = Array.isArray(m.message) ? m.message : [];
            const atMe = segs.some(
              (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
            );
            if (!atMe) continue;
            const ev = {
              post_type: "message",
              message_type: "group",
              group_id: Number(gid),
              user_id: m.sender?.user_id ?? m.user_id,
              message_id: mid,
              message: segs,
              sender: m.sender ?? {},
              __catchup: true,
            };
            logger.info?.(`[onebot] 补回复离线期间的 @：群 ${gid} 消息 ${mid}`);
            audit({ kind: "catchup", key: `group:${gid}`, messageId: mid });
            // 不在这里 markSeen —— 交给 onEvent 在回复成功后记录，
            // 否则会出现「标记了已处理但其实没回复」，轮询也不会再补。
            ev.__fromPoll = true;
            try {
              await Promise.race([
                client.onEvent(ev),
                sleep(45000).then(() => {
                  throw new Error("onEvent 超时（可能 agent 未就绪）");
                }),
              ]);
            } catch (terr) {
              logger.warn?.(`[onebot] 补回复 ${mid} 失败：${terr?.message ?? terr}`);
            }
            // 每个群最多补 2 条
            caught += 1;
            if (caught >= 2) break;
          }
        } catch (err) {
          logger.debug?.(`[onebot] 拉取群 ${gid} 历史失败：${err?.message ?? err}`);
        }
      }
    } catch (err) {
      logger.warn?.(`[onebot] 补回复流程失败：${err?.message ?? err}`);
    }
  };
}

export {  };
