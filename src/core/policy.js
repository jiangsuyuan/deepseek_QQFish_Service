// 准入与限频策略。

export function createPolicy(ctx) {
  const { ACTIVITY_KINDS, HOME, audit, cfg, client, join, rateKey, rateUser, readFileSync, searchTimes, sessions, state, summarizeDay } = ctx;
  function allowRate(key, userId) {
      const now = Date.now();
      // 创造者不受限流：他在一小时内发 10 条是正常交流，不是刷屏
      if (cfg.ownerId && String(userId) === String(cfg.ownerId)) {
        return { ok: true };
      }
      const perMin = Math.max(1, Number(cfg.ratePerMinute) || 6);
      const perHour = Math.max(1, Number(cfg.ratePerUserHour) || 30);
      const k = (rateKey.get(key) ?? []).filter((t) => now - t < 60000);
      if (k.length >= perMin) return { ok: false, why: "minute" };
      const u = (rateUser.get(String(userId)) ?? []).filter((t) => now - t < 3600000);
      if (u.length >= perHour) return { ok: false, why: "hour" };
      k.push(now);
      u.push(now);
      rateKey.set(key, k);
      rateUser.set(String(userId), u);
      return { ok: true };
    }

  function searchRateOk() {
      // searchPerHour <= 0 表示不限
      const limit = Number(cfg.searchPerHour ?? 0);
      if (!(limit > 0)) return true;
      const now = Date.now();
      while (searchTimes.length && now - searchTimes[0] > 3600_000) searchTimes.shift();
      if (searchTimes.length >= limit) return false;
      searchTimes.push(now);
      return true;
    }

  function isOwner(exec) {
      try {
        const sid = String(exec?.agent?.session?.id ?? "");
        const entry = sid ? sessions.bySessionId(sid) : null;
        const ev = entry?.lastTarget;
        if (!ev) return false;
        return String(ev.user_id) === String(cfg.ownerId);
      } catch {
        return false;
      }
    }

  function moodContext() {
      if (cfg.moodContext === false) return "";
      try {
        const st = JSON.parse(readFileSync(join(HOME, ".dsh/feiyu-mood/state.json"), "utf8"));
        const m = Number(st.mood ?? 70);
        const label = m >= 85 ? "很开心" : m >= 65 ? "不错" : m >= 45 ? "一般" : m >= 25 ? "有点低落" : "很低落";
        return `你现在心情${label}（${m}/100）。要不要把这点情绪带出来，你自己决定。`;
      } catch {
        return "";
      }
    }

  function activeHoursOk() {
      try {
        const h = new Date().getHours();
        const start = Number(cfg.activeStartHour ?? 9);
        const end = Number(cfg.activeEndHour ?? 23);
        if (start < end) return h >= start && h < end;
        return h >= start || h < end; // 跨夜写法
      } catch {
        return true;
      }
    }

  function selfActivityHoursOk() {
      try {
        const h = new Date().getHours();
        const start = Number(cfg.selfActivityStartHour ?? 5);
        const end = Number(cfg.selfActivityEndHour ?? 24);
        if (start < end) return h >= start && h < end;
        return h >= start || h < end;
      } catch {
        return true;
      }
    }

  function checkTokenBudget() {
      const limit = Number(cfg.tokenDailyAlert) || 5000000;
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (state.tokenAlertDay === ymd) return;
      const st = summarizeDay(ymd);
      if (!st || st.totalTokens < limit) return;
      state.tokenAlertDay = ymd;
      void client
        .sendPrivate(
          cfg.ownerId,
          `今天的 token 用量到 ${(st.totalTokens / 10000).toFixed(1)} 万了，超过你设的 ${(limit / 10000).toFixed(0)} 万。\n` +
            `收到 ${st.inbound} 条、回了 ${st.replies} 条、主动开口 ${st.proactive} 次。\n` +
            `觉得吵可以直接说，我会少开口。`,
        )
        .catch(() => {});
      audit({ kind: "token_alert", tokens: st.totalTokens });
    }

  function pickActivityKind() {
      const total = ACTIVITY_KINDS.reduce((a, b) => a + b.w, 0);
      let r = Math.random() * total;
      for (const k of ACTIVITY_KINDS) {
        r -= k.w;
        if (r <= 0) return k.id;
      }
      return "think";
    }

  return { isOwner, allowRate, checkTokenBudget, activeHoursOk, selfActivityHoursOk, searchRateOk, pickActivityKind, moodContext };
}

export {  };
