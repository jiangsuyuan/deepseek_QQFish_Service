// QQ 空间动态。

export function createQzone(ctx) {
  const { audit, cfg, cleanQzone, client, loadQzonePlan, logger, qzoneLog, saveQzonePlan, selfViews, sessions, stripLoneSurrogates, todayKey } = ctx;
  async function maybeQzone() {
      if (cfg.qzoneEnabled === false || cfg.autoActionsEnabled === false) return;
      if (!client.connected) return;
      const now = new Date();
      const hour = now.getHours();
      const startH = Number(cfg.qzoneStartHour) || 9;
      const endH = Number(cfg.qzoneEndHour) || 23;
      if (hour < startH || hour >= endH) return;
      let plan = loadQzonePlan();
      if (!plan || plan.date !== todayKey()) {
        plan = { date: todayKey(), posted: 0, lastAt: 0 };
        saveQzonePlan(plan);
      }
      const maxPerDay = Number(cfg.qzonePerDayMax) || 3;
      if (Number(plan.posted ?? 0) >= maxPerDay) {
        logger.debug?.(`[onebot] 今天说说已发 ${plan.posted}/${maxPerDay}，不再问`);
        return;
      }

      // 挑最近 3 小时内有活动的群作为素材来源
      let bestKey = null;
      let bestAt = 0;
      const nowTs = Date.now();
      for (const [k, e] of sessions.entries) {
        if (!k.startsWith("group:")) continue;
        const t = e.lastMessageAt ?? 0;
        if (t > bestAt) {
          bestAt = t;
          bestKey = k;
        }
      }
      if (!bestKey || nowTs - bestAt > 3 * 3600_000) {
        logger.debug?.("[onebot] 最近没什么经历，不说说");
        return;
      }

      logger.info?.("[onebot] 问问她想不想发条说说…");
      let text = "";
      try {
        text = String(
          (await sessions.runSilent(
            bestKey,
            "（内部，不要把这个发给任何人。）\n" +
              "如果你现在想发一条 QQ 空间说说，就把它写出来；不想发就只回一个字：无。\n" +
              "写的时候用你自己最近的经历做素材：这几天在群里聊过什么、遇到的人、你自己的观点和反思。" +
              "不要写泛泛的鸡汤，也不要为了发而发——真的有一点想说的才写。\n" +
              "不要照搬群里聊天的原句，用你自己的说法讲；长度两三句，像随手写的，不要带话题标签。",
          )) ?? "",
        ).trim();
      } catch (err) {
        logger.warn?.(`[onebot] 生成说说失败：${err?.message ?? err}`);
        return;
      }
      if (!text || text === "无" || text.length < 4) {
        logger.info?.("[onebot] 她这次不想发说说");
        audit({ kind: "qzone_skip" });
        return;
      }
      text = cleanQzone(stripLoneSurrogates(text).slice(0, 1000));
      try {
        const res = await client.call(
          "send_qzone_msg",
          { content: text, ugc_right: Number(cfg.qzoneVisibility) || 1 },
          20000,
        );
        const tid = String(res?.tid ?? res?.data?.tid ?? "");
        plan.posted = Number(plan.posted ?? 0) + 1;
        plan.lastAt = Date.now();
        saveQzonePlan(plan);
        qzoneLog.push({ at: new Date().toISOString(), text, tid });
        if (qzoneLog.length > 100) qzoneLog.shift();
        logger.info?.(`[onebot] 说说已发（tid=${tid.slice(0, 12)}）：${text.slice(0, 40)}`);
        audit({ kind: "qzone_post", tid, text: text.slice(0, 200) });
        // 记进她的自我记忆，方便以后问起时记得
        try {
          selfViews.data.push({
            text: `我在空间发过一条：${text}`,
            at: Date.now(),
            kind: "qzone",
          });
          if (selfViews.data.length > 300) selfViews.data.shift();
          selfViews.save?.();
        } catch {
          // 忽略
        }
      } catch (err) {
        logger.warn?.(`[onebot] 发说说失败：${err?.message ?? err}`);
        audit({ kind: "qzone_fail", error: String(err?.message ?? err).slice(0, 200) });
      }
    }

  return { maybeQzone };
}

export {  };
