// 事件收件箱。

export function createEvents(ctx) {
  const { inbox, state } = ctx;
  function pushEvent(e) {
      // 同一个 messageId 不重复入队
      if (e.payload && e.payload.messageId) {
        const dup = inbox.find(
          (x) => x.payload && x.payload.messageId === e.payload.messageId,
        );
        if (dup) return dup;
      }
      inbox.push(e);
      state.inboxDirty = true;
      // 限制内存里最多 200 条（更早的丢弃，避免无限增长）
      if (inbox.length > 200) inbox.splice(0, inbox.length - 200);
      return e;
    }

  function pendingEvents() {
      return inbox.filter((x) => x.status === "unread");
    }

  return { pendingEvents, pushEvent };
}

export {  };
