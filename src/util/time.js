// 时间与等待。

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      timer.unref?.();
    }),
  ]);
}

function parseReminderTime(text) {
    const now = new Date();
    const hhmm = text.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/);
    const daily = /每天|每日/.test(text);

    // N 小时后 / N 分钟后
    const rel = text.match(/(\d+)\s*(小时|分钟|分)后/);
    if (rel) {
      const n = Number(rel[1]);
      const ms = rel[2].startsWith("小时") ? n * 3600000 : n * 60000;
      return { at: Date.now() + ms, repeat: "once" };
    }

    if (!hhmm) return null;
    let hour = Number(hhmm[1]);
    const minute = Number(hhmm[2] || 0);
    if (hour > 23) hour = hour % 24;
    if (/下午|晚上|傍晚/.test(text) && hour < 12) hour += 12;
    if (/中午/.test(text) && hour < 11) hour += 12;

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    const tomorrow = /明天/.test(text);
    if (tomorrow) {
      target.setDate(target.getDate() + 1);
    } else if (!daily && target <= now) {
      target.setDate(target.getDate() + 1);
    } else if (daily && target <= now) {
      // 今天已过，首次从明天开始
      target.setDate(target.getDate() + 1);
    }

    return { at: target.getTime(), repeat: daily ? "daily" : "once", hour, minute };
  }

export { sleep, withTimeout, parseReminderTime };
