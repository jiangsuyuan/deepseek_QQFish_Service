// 每轮都一样的提示前缀：风格、长度、自由说明、断线提醒。
//
// 以前这套东西在 events.js 里拼好，但最后被 flushBuf 丢掉了 ——
// 真正送进模型的只有「时间 + 事件 + 工具说明」。这里把它抽出来，
// 由 wakeNow 统一拼一次。
export function createPromptCore(app) {
  const { cfg, formatLenHint, recentOutageNote, toolTableText } = app;

  function core() {
    const parts = [];
    const lenHint = (() => {
      try {
        return formatLenHint() || "";
      } catch {
        return "";
      }
    })();
    parts.push(
      "（你脑子里的是印象，不是录像：记得住大概，细节要靠 recall / search_messages / " +
        "read_context 去翻。想不起就用工具查，别照着印象把话说死。）",
    );
    if (lenHint) parts.push(lenHint);
    try {
      const o = recentOutageNote();
      if (o) parts.push(o);
    } catch {
      // 拿不到就不提
    }

    return parts.length ? parts.join("\n") + "\n" : "";
  }

  return { core };
}
