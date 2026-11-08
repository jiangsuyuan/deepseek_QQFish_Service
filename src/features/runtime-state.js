// 运行时快照与诊断文本。

export function createRuntimeState(ctx) {
  const { HOME, RUNTIME_PATH, SENSITIVE, cfg, client, join, loadActivities, loadCore, loadDigests, loadLearnings, loadMemLog, loadSelfModel, loadSelfState, logger, myMsgIds, myMsgOrder, readFileSync, saveOutages, saveSelfModel, sessions, state, writeFileSync } = ctx;
  function activityTimeline() {
      try {
        const acts = loadActivities(50);
        const last = acts.length ? acts[acts.length - 1] : null;
        const st = loadSelfState();
        const nextAt = Number(st.selfActivityNextAt) || 0;
        const fmt = (t) =>
          new Date(t).toLocaleString("zh-CN", {
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
          });
        const parts = [];
        if (last) parts.push("上次活动：" + fmt(last.at) + "（" + (last.kind || "?") + "）");
        else parts.push("上次活动：还没做过");
        if (nextAt > 0) {
          const mins = Math.round((nextAt - Date.now()) / 60000);
          parts.push("下次活动：" + fmt(nextAt) + (mins > 0 ? "（约 " + mins + " 分钟后）" : "（已过）"));
        } else {
          parts.push("下次活动：没排");
        }
        return parts.join("\n");
      } catch {
        return "";
      }
    }

  function otherGroupDigest(currentKey, maxItems) {
      const bits = [];
      for (const [k, e] of sessions.entries) {
        if (!k.startsWith("group:") || k === currentKey) continue;
        const obs = e.observations ?? [];
        if (!obs.length) continue;
        for (const line of obs.slice(-4)) {
          // 去掉「昵称：」前缀，只留内容
          const clean = String(line).replace(/^[^：:\n]{1,16}[：:]\s*/, "").slice(0, 36);
          if (!clean || SENSITIVE.test(clean)) continue;
          bits.push(clean);
        }
      }
      return bits.slice(-(maxItems || 4)).join("；");
    }

  function snapshotRuntime() {
      const data = {};
      for (const [key, ent] of sessions.entries) {
        data[key] = {
          msgTimes: ent.msgTimes ?? [],
          lastMentionAt: ent.lastMentionAt ?? 0,
          lastReplyAt: ent.lastReplyAt ?? 0,
          lastActiveJoinAt: ent.lastActiveJoinAt ?? 0,
          lastMessageAt: ent.lastMessageAt ?? 0,
          topicWindow: (ent.topicWindow ?? []).slice(-60),
          topicPending: !!ent.topicPending,
          lastTopicAt: ent.lastTopicAt ?? 0,
        };
      }
      try {
        writeFileSync(RUNTIME_PATH, JSON.stringify(data), "utf8");
      } catch {
        // 忽略
      }
    }

  function restoreRuntime(entry) {
      try {
        if (!restoreRuntime.cache) {
          try {
            restoreRuntime.cache = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
          } catch {
            restoreRuntime.cache = {};
          }
        }
        const saved = restoreRuntime.cache?.[entry.key];
        if (!saved) return;
        if (Array.isArray(saved.msgTimes)) {
          const now = Date.now();
          entry.msgTimes = saved.msgTimes.filter((t) => now - t < 60000);
        }
        for (const k of ["lastMentionAt", "lastReplyAt", "lastActiveJoinAt", "lastMessageAt", "lastTopicAt"]) {
          if (saved[k]) entry[k] = saved[k];
        }
        if (Array.isArray(saved.topicWindow)) {
          const now = Date.now();
          entry.topicWindow = saved.topicWindow.filter((x) => x && now - x.t < 3 * 3600000);
        }
        if (saved.topicPending) entry.topicPending = true;
      } catch {
        // 忽略
      }
    }

  function offlineDigest() {
      try {
        const learns = loadLearnings();
        const since = state.offlineSince || Date.now() - 7 * 86400_000;
        const recent = learns.filter((l) => l.at >= since);
        if (!recent.length) return "";
        const list = recent
          .slice(-8)
          .map((l) => {
            const why = (l.path || []).find((p) => p && p.why)?.why;
            return `· ${l.topic}：${String(l.summary).slice(0, 60)}${why ? `（路上被「${String(why).slice(0, 30)}」勾住的）` : ""}`;
          })
          .join("\n");
        return (
          `（说明：你最近没法在群里说话。可以把它当成一次出门远行——` +
          `你在外面走了走，看了 ${recent.length} 处东西，都记下来了：\n${list}\n` +
          `你现在知道的东西比出门前多了一些。）`
        );
      } catch {
        return "";
      }
    }

  function noteMyMessage(mid) {
      try {
        const id = String(mid || "");
        if (!id || myMsgIds.has(id)) return;
        myMsgIds.add(id);
        myMsgOrder.push(id);
        if (myMsgOrder.length > 300) {
          const old = myMsgOrder.shift();
          myMsgIds.delete(old);
        }
      } catch {
        // 忽略
      }
    }

  function noteOutageFromClient(kind, ts) {
      try {
        if (kind === "down") {
          if (!state.outageDownAt) state.outageDownAt = ts;
          logger.warn?.("[onebot] 掉线开始");
        } else if (kind === "up") {
          if (state.outageDownAt) {
            const minutes = Math.max(1, Math.round((ts - state.outageDownAt) / 60000));
            state.outages.push({ downAt: state.outageDownAt, upAt: ts, minutes });
            state.lastOutageInfo = { downAt: state.outageDownAt, upAt: ts, minutes };
            saveOutages();
            logger.info?.(`[onebot] 掉线恢复，断了 ${minutes} 分钟`);
            state.outageDownAt = 0;
          }
        }
      } catch {
        // 忽略
      }
    }

  function recentOutageNote() {
      try {
        const now = Date.now();
        const recent = state.outages.filter((o) => now - o.upAt < 2 * 3600_000).slice(-3);
        const ongoing = state.outageDownAt > 0;
        if (!recent.length && !ongoing) return "";
        const list = recent
          .map((o) => {
            const d = new Date(o.upAt);
            const hh = String(d.getHours()).padStart(2, "0");
            const mm = String(d.getMinutes()).padStart(2, "0");
            return `${hh}:${mm} 恢复（断了 ${o.minutes} 分钟）`;
          })
          .join("；");
        const ong = ongoing
          ? `你刚刚断线过，${Math.max(1, Math.round((now - state.outageDownAt) / 60000))} 分钟前才恢复。`
          : "";
        return `（说明：${ong}你最近断线过 — ${list}。断线期间的消息可能刚补回来或者丢了，如果对方说"你怎么不说话"就是这个原因。）`;
      } catch {
        return "";
      }
    }

  function persistConfig() {
      try {
        writeFileSync(
          join(HOME, ".dsh/onebot-bridge/config.json"),
          JSON.stringify(cfg, null, 2),
          "utf8",
        );
        return true;
      } catch {
        return false;
      }
    }

  async function allGroupIds() {
      if (Date.now() - state.groupListCache.at > 10 * 60000 && state.groupListCache.ids.length === 0) {
        try {
          const list = await client.call("get_group_list", {}, 8000);
          const arr = Array.isArray(list) ? list : (list?.data ?? []);
          state.groupListCache = {
            at: Date.now(),
            ids: arr.map((g) => Number(g.group_id)).filter((n) => Number.isFinite(n) && n > 0),
          };
        } catch {
          // 拿不到就用已加载的
        }
      }
      if (state.groupListCache.ids.length) {
        if (Date.now() - state.groupListCache.at > 10 * 60000) state.groupListCache.at = Date.now();
        return state.groupListCache.ids;
      }
      return [...sessions.entries.keys()]
        .filter((k) => k.startsWith("group:"))
        .map((k) => Number(k.slice(6)))
        .filter(Boolean);
    }

  function noteMirrorSource(who, said) {
      try {
        const m = loadSelfModel();
        m.mirror = m.mirror && typeof m.mirror === "object" ? m.mirror : {};
        m.mirror.sources = Array.isArray(m.mirror.sources) ? m.mirror.sources : [];
        const text = String(said || "").slice(0, 60);
        if (!text) return;
        if (m.mirror.sources.some((x) => x.said === text)) return;
        m.mirror.sources.push({ who: String(who || ""), said: text, at: Date.now() });
        if (m.mirror.sources.length > 30) m.mirror.sources = m.mirror.sources.slice(-30);
        saveSelfModel(m);
      } catch {
        // 忽略
      }
    }

  function memoryLayersIndex() {
      try {
        const core = loadCore();
        const digests = loadDigests();
        const mems = loadMemLog(500);
        const sm = loadSelfModel();
        const acts = loadActivities(300);
        const today = new Date().toDateString();
        const todayCount = mems.filter((m) => new Date(m.at).toDateString() === today).length;
        const learnCount = (() => {
          try {
            return loadLearnings().length;
          } catch {
            return 0;
          }
        })();
        return [
          `L0 自我认知：${sm.fact?.text ? "有（三层）" : "还没有"}`,
          `L1 工作记忆：当前对话（这个 session）`,
          `L2 近期印象：${digests.length} 段，最新 ${digests.length ? new Date(digests[digests.length - 1].to).toLocaleDateString("zh-CN") : "无"}`,
          `L3 核心自我：${core.length} 条（belief/care/want/change）`,
          `L4 长期记忆：${mems.length} 条记录，今天 ${todayCount} 条`,
          `L5 专项记录：探险 ${learnCount} 条 / 活动 ${acts.length} 次 / 游戏 / 书单 / 需求本`,
          "（这些都是**印象**，被压缩过。细节不会消失——想不起来就用 recall / search_messages / " +
            "read_context 把原话翻出来，别凭印象编。）",
        ].join("\n");
      } catch {
        return "";
      }
    }

  return { snapshotRuntime, restoreRuntime, persistConfig, noteOutageFromClient, offlineDigest, recentOutageNote, activityTimeline, memoryLayersIndex, allGroupIds, otherGroupDigest, noteMirrorSource, noteMyMessage };
}

export {  };
