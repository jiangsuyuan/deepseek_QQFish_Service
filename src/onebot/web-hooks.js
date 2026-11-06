export function createOnOfflineText(app) {
  const { cfg, logger, webPush, pluginCtx: ctx } = app;
  return (text, toUid) => {
    try {
      const body = String(text || "");
      const isOwner = !!toUid && String(toUid) === String(cfg.ownerId ?? "");
      if (isOwner || !toUid) {
        webPush({ role: "her", text: body.slice(0, 2000), channel: "qq", offline: true });
      } else {
        // tool 记录不进 history 文件（webPush 里就过滤了），只走 SSE 给当前打开的面板
        webPush({
          role: "tool",
          text: "QQ 离线：有一条发给 " + toUid + " 的私聊没发出去（正文不展示）",
        });
        logger.info?.("[onebot] QQ 离线：发给他人(" + toUid + ")的内容不进 WebUI 历史，只留占位");
      }
    } catch {
      // 忽略
    }
  };
}

// 网页端代发消息。
export function createOnWebReply(app) {
  const { ensureGroupNames, state, webPush, pluginCtx: ctx } = app;
  return (text, channel, peer) => {
    const ch = String(channel || "qq");
    let peerName = "";
    if (ch === "group" && peer) {
      try {
        peerName = state.groupNames.get(String(peer)) || "";
      } catch {
        // 忽略
      }
      // 群名缓存空了就去拉一次（自带 10 分钟节流），拉不到就只显示群号
      if (!peerName) {
        try {
          void ensureGroupNames().catch(() => {});
        } catch {
          // 忽略
        }
      }
    }
    webPush({ role: "her", text, channel: ch, peer: String(peer || ""), peerName });
  };
}

export {  };
