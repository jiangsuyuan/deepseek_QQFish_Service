// 注意力：被 @/引用 之后的"反应时间"。
//
// 人类不是被叫了就立刻回：看到提示 → 解锁 → 打开软件 → 读几条 → 才决定。
// 这里就模拟那几步：被叫之后随机等 5~15 秒，再把她叫起来。
//
// 规则（和创造者定的）：
//   · 同一个群同一时刻只有一个等待中的定时器
//   · 等待期间又有人 @/引用 → 不重排，只计数（到点时一并告诉她"还有 N 条"）
//   · 段跑起来之后再来 @/引用 → 新开一个定时器，排在前一段后面（事件队列本身是串行的）

const MIN_MS = 5 * 1000;
const MAX_MS = 15 * 1000;

export function createAttention({ logger } = {}) {
  const state = new Map(); // channel -> { timer, extra }
  let fired = 0;

  function delay() {
    return MIN_MS + Math.floor(Math.random() * (MAX_MS - MIN_MS + 1));
  }

  /**
   * 请求一次"回应机会"。
   * @param {string} channel 群/私聊会话键
   * @param {(extra: number) => void} run 到点后真正入队的动作
   */
  function request(channel, run) {
    if (!channel || typeof run !== "function") return false;
    const cur = state.get(channel);
    if (cur?.timer) {
      cur.extra += 1; // 等待期间又有人叫：不重排，只计数
      return false;
    }
    const wait = delay();
    const rec = { extra: 0, timer: null };
    rec.timer = setTimeout(() => {
      try {
        state.delete(channel);
        fired += 1;
        logger?.info?.(`[onebot] 注意力到点（等了 ${Math.round(wait / 1000)} 秒${rec.extra ? `，期间还有 ${rec.extra} 次` : ""}）`);
        run(rec.extra);
      } catch (err) {
        logger?.warn?.("[onebot] 注意力回调失败：" + (err?.message ?? err));
      }
    }, wait);
    rec.timer.unref?.();
    state.set(channel, rec);
    return true;
  }

  function status() {
    return { waiting: state.size, fired };
  }

  return { request, status };
}
