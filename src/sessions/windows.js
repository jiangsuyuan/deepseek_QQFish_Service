// 续聊窗口：谁刚跟她说过、还能接着聊几轮。

export function createWindows(ctx) {
  const { cfg, followUps, logger } = ctx;
  const followSecs = () => Number(cfg.followUpSeconds) || 60;

  const followMax = () => Number(cfg.followUpMaxTurns) || 5;

  function openWindow(key, userId, resetTurns = true) {
      const map = followUps.get(key) ?? new Map();
      const prev = map.get(String(userId));
      map.set(String(userId), {
        until: Date.now() + followSecs() * 1000,
        turns: resetTurns ? 0 : prev?.turns ?? 0,
        max: followMax(),
      });
      followUps.set(key, map);
    }

  function hitWindow(key, userId) {
      const map = followUps.get(key);
      if (!map) return null;
      for (const who of [String(userId), "*"]) {
        const rec = map.get(who);
        if (!rec) continue;
        if (Date.now() >= rec.until) {
          map.delete(who);
          continue;
        }
        return { rec, who };
      }
      return null;
    }

  function activeWindowTarget(key, excludeUserId) {
      const map = followUps.get(key);
      if (!map) return null;
      const now = Date.now();
      for (const [who, rec] of map.entries()) {
        if (who === "*") continue;
        if (now >= rec.until) continue;
        if (excludeUserId && who === String(excludeUserId)) continue;
        return who;
      }
      return null;
    }

  function bumpWindow(key, userId) {
      const map = followUps.get(key);
      if (!map) return;
      for (const who of [String(userId), "*"]) {
        const rec = map.get(who);
        if (!rec) continue;
        rec.turns += 1;
        rec.until = Date.now() + followSecs() * 1000;
        if (rec.turns >= rec.max) {
          map.delete(who);
          logger.info?.(`[onebot] 续聊满 ${rec.max} 轮，关闭窗口 ${key}（${who}）`);
        }
        return;
      }
    }

  function closeWindowFor(key, userId) {
      const map = followUps.get(key);
      if (!map) return;
      map.delete(String(userId));
    }

  return { followSecs, followMax, openWindow, hitWindow, activeWindowTarget, bumpWindow, closeWindowFor };
}

export {  };
