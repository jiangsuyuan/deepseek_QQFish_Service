// 会话事件钩子。

export function createSessionEventHandler(app) {
  const { audit, cfg, client, conversationKey, entryLastTopic, logger, sessions, pluginCtx: ctx } = app;
  return (a, b) => {
    try {
      const session = a && a.id ? a : b && b.session;
      const event = a && a.id ? b : a;
      if (!session || !event) return;
      const entry = sessions.bySessionId(session.id);
      if (!entry) return;
      if (event.type === "assistant/message") {
        const blocks = event.data?.message?.content ?? [];
        const text = blocks
          .filter((x) => x?.type === "text")
          .map((x) => x.text ?? "")
          .join("")
          .trim();
        if (text) entry.spontaneousText = text;
        return;
      }
      if (event.type === "turn/end") {
        const text = entry.spontaneousText ?? "";
        entry.spontaneousText = "";
        // 主动回合没说话（只输出句号）时，也要清掉标志
        if (entry.proactiveTurn && !text) entry.proactiveTurn = false;
        // 静默回合（内省）：只记东西，不发任何消息
        if (entry.silentTurn) {
          entry.proactiveTurn = false;
          logger.info?.(
            `[onebot] 内省完成（${text ? text.slice(0, 30).replace(/\n/g, " ") : "无输出"}）`,
          );
          entry.silentTurn = false;
          return;
        }
        // 只有「主动回合」才由这里转发；被动回复由 sendHuman 发，避免重复
        if (!entry.proactiveTurn) return;
        entry.proactiveTurn = false;
        // 只发到「本回合明确绑定的目标」：绝不拿 lastTarget 兜底（会把话发到别的群）
        const targetEv = entry.proactiveTarget || null;
        const targetFrom = entry.proactiveTargetFrom || "unknown";
        const src = entry.proactiveSource || "proactive";
        entry.proactiveTarget = null;
        entry.proactiveTargetFrom = "";
        entry.proactiveSource = "";
        if (!text) {
          return;
        }
        if (!targetEv) {
          logger.warn?.("[onebot] 主动回合没有明确目标，丢弃（不再用 lastTarget 猜）");
          audit({ kind: "proactive_no_target" });
          return;
        }
        if (src === "activity" || String(conversationKey(targetEv)).startsWith("self")) {
          logger.info?.("[onebot] 内部回合的文本不外发，已丢弃");
          audit({ kind: "internal_text_dropped" });
          return;
        }
        // 双保险：和刚 sendHuman 发出去的内容一样就不再重复发
        try {
          const last = entry.lastSent;
          if (
            last &&
            Date.now() - last.at < 15000 &&
            String(last.text).trim() === String(text).trim()
          ) {
            logger.info?.("[onebot] 自发转发与刚发的内容相同，跳过");
            return;
          }
        } catch {
          // 忽略
        }
        const ev = targetEv;
        // 检查是否照抄了新闻标题
        const topic = entryLastTopic.get(conversationKey(ev));
        if (topic) {
          const src = new Set(topic.split(""));
          let hit = 0;
          for (const ch of new Set(text.split(""))) if (src.has(ch)) hit += 1;
          const ratio = hit / Math.max(1, src.size);
          if (ratio > 0.75) {
            logger.warn?.(`[onebot] 自发消息与标题重合度 ${(ratio * 100).toFixed(0)}%，可能在复读：${text.slice(0, 40)}`);
            audit({ kind: "proactive_repeat", key: conversationKey(ev), ratio: Number(ratio.toFixed(2)), text: text.slice(0, 120) });
          }
          entryLastTopic.delete(conversationKey(ev));
        }
        // 只输出句号/省略号 = 模型选择「不说」，别把标点发到群里
        {
          const bare = String(text).replace(/[\s]/g, "");
          if (!bare || /^[。．.…，,、！!？?~～]+$/.test(bare)) {
            logger.info?.("[onebot] 主动回合选择不说话（只输出了标点），跳过发送");
            audit({ kind: "proactive_silent", key: conversationKey(ev) });
            return;
          }
        }
        logger.info?.(
          `[onebot] 自发消息 → ${conversationKey(ev)} [src=${src} targetFrom=${targetFrom}] ${text.slice(0, 40).replace(/\n/g, " ")}`,
        );
        void client
          .sendHuman(ev, text.slice(0, cfg.maxReplyChars), {
            quote: entry.proactiveQuote === true,
          })
          .catch(() => {});
      }
    } catch (err) {
      logger.warn?.(`[onebot] 自发转发异常：${err?.message ?? err}`);
    }
  };
}

export {  };
