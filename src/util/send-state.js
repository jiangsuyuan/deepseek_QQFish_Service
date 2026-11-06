// 发送节流与去重状态。

const OUT_SENT = new Map();

const OUT_REPLIED = new Map();

const DUP_TEXT_MS = 120000;

const DUP_MSG_MS = 300000;

const normOut = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

const SEND_STATE = { recent: [], lastAt: 0 };

function noteSent() {
  const now = Date.now();
  SEND_STATE.lastAt = now;
  SEND_STATE.recent.push(now);
  if (SEND_STATE.recent.length > 400) SEND_STATE.recent.splice(0, SEND_STATE.recent.length - 400);
}

function pickBaseDelay(cfg) {
  const now = Date.now();
  const recent = SEND_STATE.recent;
  let r60 = 0;
  let r600 = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const dt = now - recent[i];
    if (dt < 60_000) r60 += 1;
    if (dt < 600_000) r600 += 1;
    else break;
  }
  const idleMs = Number(cfg.replyBaseIdleMs ?? 350) || 350;
  if (r60 >= 15) return 4000;
  if (r60 >= 10) return 3000;
  if (r60 >= 6) return 2000;
  if (r60 >= 3) return r600 > 10 ? 1600 : 1400;
  if (r60 >= 1) return r600 > 10 ? 1100 : 900;
  if (r600 <= 2) return idleMs;
  if (r600 <= 10) return 600;
  return 900;
}

function backlogDelay(cfg) {
  const now = Date.now();
  SEND_STATE.recent = SEND_STATE.recent.filter((t) => now - t < 30000);
  const n = SEND_STATE.recent.length;
  let extra = 0;
  if (n > 6) extra += Math.min(6000, (n - 6) * 400);
  const gap = Number(cfg.minSendGapMs ?? 1200) || 0;
  const wait = Math.max(0, gap - (now - SEND_STATE.lastAt));
  return { extra, wait, perMin: n };
}

export { OUT_SENT, OUT_REPLIED, DUP_TEXT_MS, DUP_MSG_MS, normOut, SEND_STATE, noteSent, pickBaseDelay, backlogDelay };
