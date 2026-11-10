// 依赖自检：跨模块依赖没传进来时，**启动就报错**，不要静默。
//
// 背景：这些地方以前都写成 `dep?.fn?.()`，好处是不会崩，
// 坏处是「没接上」和「正常工作」长得一模一样 —— 2026-11-08 一天里因此坏了三处：
//   · client.windows 没注入 → 续聊窗口从来没开过
//   · 回看事件缺 target → 把回复发到了别的群
//   · echo 没注入事件处理器 → 复读机开关是开的，一次都没触发
export function checkDeps(label, app, keys) {
  const missing = [];
  for (const k of keys) {
    if (!app || app[k] === undefined || app[k] === null) missing.push(k);
  }
  if (missing.length) {
    throw new Error(`[onebot] ${label} 缺少依赖：${missing.join(" / ")}`);
  }
}

/** 启动时报一行"哪些钩子接上了"，方便对照日志 */
export function wireSummary(logger, items) {
  const bad = Object.entries(items).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) {
    logger?.warn?.("[onebot] 依赖自检未通过：" + bad.join(" / "));
    return false;
  }
  logger?.info?.("[onebot] 依赖自检通过：" + Object.keys(items).join(" / "));
  return true;
}
