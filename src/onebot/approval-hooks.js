// 审批请求。

export function createApprovalHandler(app) {
  const { cfg, logger, sessions, pluginCtx: ctx } = app;
  return (req, next) => {
    try {
      const sid = req?.agent?.session?.id;
      const entry = sid ? sessions.bySessionId(sid) : null;
      if (!entry) return next();
      const target = entry.lastTarget;
      const toolName = req?.toolName ?? "unknown";
      // 只在「控制者本人的私聊」里自动放行；群聊/其他人一律拒绝
      const isOwnerPrivate =
        !!target &&
        target.message_type !== "group" &&
        cfg.ownerId &&
        String(target.user_id) === String(cfg.ownerId);
      if (isOwnerPrivate) {
        logger.info?.(`[onebot] 自动允许工具：${toolName}（控制者私聊）`);
        return "allowed-once";
      }
      logger.warn?.(`[onebot] 自动拒绝工具：${toolName}（非控制者或群聊）`);
      return "rejected";
    } catch {
      return next();
    }
  };
}

export {  };
