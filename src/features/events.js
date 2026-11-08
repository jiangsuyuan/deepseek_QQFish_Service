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

  /** 取消某个群还在排队的回看事件（来了新 @ 时用：旧的回看已经没意义了） */
  function cancelReviews(groupId) {
    const gid = String(groupId || "");
    if (!gid) return 0;
    let n = 0;
    for (let i = inbox.length - 1; i >= 0; i -= 1) {
      const x = inbox[i];
      if (x?.kind === "review" && String(x.source?.groupId || "") === gid) {
        inbox.splice(i, 1);
        n += 1;
      }
    }
    if (n) state.inboxDirty = true;
    return n;
  }

  return { pendingEvents, pushEvent, cancelReviews };
}

export {  };
