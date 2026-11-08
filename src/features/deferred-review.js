// 延迟回看：她说完话之后，群里接着说的事，隔 60 秒回看一次。
//
// 规则（和创造者定的）：
//   · 60 秒内有新消息 → 到点回看"这一批"
//   · 60 秒内没有消息 → 窗口关掉，等之后来的第一条非 @ 消息，回看"那一条"
//   · 一个周期只回看一次
//   · 硬信号（@ / 提到名字 / 引用她）不走回看，并且打断回看
//   · 判断指令两次完全一样：「这条是不是在回复你？不是就什么都别做，是的话你自己判断是否做什么。」
//
// 目的：她说完话之后，别人接着说不带 @ 的话，她也能看见；但不会参与无关话题。

import { tailRows } from "../util/msg-tail.js";

const WAIT_MS = 120 * 1000; // 她说完话后的观察窗（120 秒：群里接话比私聊慢）
const EXPIRE_MS = 10 * 60 * 1000; // 等"第一条"最多等这么久，超了就关周期

export function createDeferredReview(app = {}) {
  const { logger, enqueueEvent, makeEvent } = app;
  const state = new Map(); // channel -> { stage, timer, cursor, at, expireTimer }

  function get(channel) {
    let s = state.get(channel);
    if (!s) {
      s = { stage: "idle", timer: null, cursor: 0, at: 0, expireTimer: null };
      state.set(channel, s);
    }
    return s;
  }

  function clearTimers(s) {
    if (s.timer) clearTimeout(s.timer);
    if (s.expireTimer) clearTimeout(s.expireTimer);
    s.timer = null;
    s.expireTimer = null;
  }

  /** 她在这个频道说完话 —— 开一个 60 秒的观察窗 */
  function arm(channel) {
    const s = get(channel);
    clearTimers(s);
    s.stage = "waiting60";
    s.at = Date.now();
    s.timer = setTimeout(() => {
      try {
        if (true) {
          // 60 秒内有新消息 → 回看这一批
          fire(channel, "batch");
          s.stage = "waitingFirst";
          s.expireTimer = setTimeout(() => close(channel, "过期"), EXPIRE_MS);
        } else {
          // 60 秒内没有 → 关窗，等之后来的第一条
          s.stage = "waitingFirst";
          s.expireTimer = setTimeout(() => close(channel, "过期"), EXPIRE_MS);
        }
      } catch (err) {
        logger?.warn?.("[onebot] 回看触发失败：" + (err?.message ?? err));
      }
    }, WAIT_MS);
    s.timer.unref?.();
  }

  /** 硬信号来了 —— 立即打断回看 */
  function cancel(channel) {
    const s = get(channel);
    if (s.stage === "idle") return;
    clearTimers(s);
    s.stage = "idle";
    logger?.info?.("[onebot] 硬信号打断回看：" + channel);
  }

  /** 周期结束 */
  function close(channel, why) {
    const s = get(channel);
    clearTimers(s);
    s.stage = "idle";
    logger?.debug?.(`[onebot] 回看周期结束 ${channel}（${why}）`);
  }

  /** 这条消息要不要触发回看？返回 true 表示拦下并走回看 */
  function shouldReview(channel) {
    const s = get(channel);
    return s.stage === "waitingFirst";
  }

  /** 回看触发：生成一个 review 事件 */
  function fire(channel, mode) {
    const s = get(channel);
    // 她说完之后群里没新消息 → 别打扰她
    try {
      const t = tailRows(channel, 8);
      if (t.afterMine && (!t.rows || t.rows.length === 0)) {
        logger?.info?.("[onebot] 回看跳过：她说完之后群里没有新消息");
        return false;
      }
    } catch {
      // 读不到就照常触发
    }
    logger?.info?.(`[onebot] 回看触发 ${channel}（${mode}）`);
    try {
      const [kind, id] = String(channel).split(":");
      enqueueEvent?.(
        makeEvent(
          "review",
          { type: kind, groupId: kind === "group" ? id : undefined, userId: kind === "private" ? id : undefined },
          { text: "", reviewMode: mode, messageId: "" },
        ),
      );
    } catch (err) {
      logger?.warn?.("[onebot] 回看入队失败：" + (err?.message ?? err));
    }
  }

  /** 一次回合结束后结算 */
  function settle(channel, replied) {
    const s = get(channel);
    if (replied) {
      // 她回了话 → 重新开窗
      arm(channel);
      return;
    }
    // 没回 → 结束这个周期
    close(channel, "她没回");
  }

  return { arm, cancel, close, shouldReview, settle, fire, get };
}
