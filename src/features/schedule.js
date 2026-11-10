// 定时任务：提醒、主动分享、日报、日记、反思。

export function createSchedule(app) {
  const { activeHoursOk, audit, cfg, claimDueSelfPlan, client, enqueueEvent, entryLastTopic, fetchHotNews, findSessionFile, flushSeen, inQuietHours, loadReminders, logger, makeEvent, markSeen, maybeAdjustSelfModel, openWindow, patchSelfState, pickTarget, recentDialog, renderStats, saveReminders, selfViews, sessions, statSync, state, summarizeDay } = app;
  const ctx = app.pluginCtx;
  async function checkReminders() {
      if (!client.connected && state.reminders.some((r) => !r.done)) {
        // 掉线时不发提醒，等重连（提醒是“到点就发”，晚几分钟比丢了好）
        return;
      }
      loadReminders();
      if (!state.reminders.length) return;
      const now = Date.now();
      const due = state.reminders.filter((r) => r.at <= now);
      if (!due.length) return;

      for (const r of due) {
        try {
          if (r.target?.type === "group" && r.target.groupId) {
            await client.call(
              "send_group_msg",
              {
                group_id: Number(r.target.groupId),
                message: [{ type: "text", data: { text: `⏰ 提醒：${r.text}` } }],
              },
              10000,
            );
          } else {

            await client.sendPrivate(r.target?.userId ?? cfg.ownerId, `⏰ 提醒：${r.text}`);
          }
          logger.info?.(`[onebot] 提醒触发：${r.text}`);
          audit({ kind: "reminder", text: r.text });
        } catch (err) {
          logger.warn?.(`[onebot] 提醒发送失败：${err?.message ?? err}`);
        }

        if (r.repeat === "daily") {
          const next = new Date(r.at);
          next.setDate(next.getDate() + 1);
          r.at = next.getTime();
        } else {
          const idx = state.reminders.indexOf(r);
          if (idx >= 0) state.reminders.splice(idx, 1);
        }
      }
      saveReminders();
    }

  function scheduleProactive() {
      if (!cfg.proactiveEnabled || cfg.autoActionsEnabled === false) return;
      const min = Math.max(15, Number(cfg.proactiveMinMinutes) || 60);
      const max = Math.max(min, Number(cfg.proactiveMaxMinutes) || 120);
      const delay = (min + Math.random() * (max - min)) * 60 * 1000;
      setTimeout(() => {
        void (async () => {
          try {
            if (inQuietHours()) return;
            if (Math.random() > (Number(cfg.proactiveChance) || 0.45)) return;
            const picked = pickTarget();
            if (!picked) return;
            const [key] = picked;
            const news = await fetchHotNews(cfg, logger);
            if (!news.length) {
              logger.info?.("[onebot] 没抓到可用的热点，跳过本次主动分享");
              return;
            }
            const pick = news[Math.floor(Math.random() * news.length)];
            logger.info?.(`[onebot] 主动分享触发：${key} -> ${pick}`);
            audit({ kind: "proactive", key, topic: pick });
            entryLastTopic.set(key, pick);
            await sessions.runProactive(
              key,
              `（这是你自己的空闲时间，不是别人在问你。你刚刷到一条：「${pick}」。` +
                "如果你有想法，就用**你自己的话**讲出来——换个说法、加一句评论或吐槽都行，" +
                "**绝对不要照抄上面那句话的原文**，也不要提「热点」「新闻」「看到一条」这类词；" +
                "如果没什么可说的，就聊点别的轻松话题，当没看见这条。）",
            );
            if (cfg.followUpEnabled) {
              openWindow(key, "*");
              logger.info?.(`[onebot] 主动冒泡后开群级窗口 ${key}`);
            }
          } catch (err) {
            logger.warn?.(`[onebot] 主动分享失败：${err?.message ?? err}`);
          } finally {
            scheduleProactive();
          }
        })();
      }, delay).unref?.();
      logger.info?.(`[onebot] 下次主动分享约 ${Math.round(delay / 60000)} 分钟后`);
    }

  function scheduleDailyBrief() {
      if (!cfg.dailyBriefEnabled) return;
      const now = new Date();
      const next = new Date(now);
      next.setHours(Number(cfg.dailyBriefHour) || 9, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const delay = next - now;
      setTimeout(() => {
        void (async () => {
          try {
            // 简讯只发给创造者私聊（dailyBriefTarget 可覆盖成别的会话）
            const briefKey =
              String(cfg.dailyBriefTarget || "").trim() ||
              (cfg.ownerId ? `private:${cfg.ownerId}` : "");
            if (briefKey) {
              logger.info?.(`[onebot] 生成每日简讯（私聊）→ ${briefKey}`);
              audit({ kind: "daily_brief", key: briefKey });
              const y = new Date(Date.now() - 86400000);
              const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
              const statsLine = renderStats(summarizeDay(ymd));
              await sessions.runProactive(
                briefKey,
                "（内部任务：生成今天的简讯。用三四句话报一下今天的天气、1-2 条值得知道的 AI/科技动态，" +
                  (statsLine ? `最后顺带提一句昨天的聊天情况：${statsLine} ` : "") +
                  "语气像朋友随口转述，不要标题、不要列表、不要「简讯」两个字。）",
              );
            }
          } catch (err) {
            logger.warn?.(`[onebot] 简讯生成失败：${err?.message ?? err}`);
          } finally {
            scheduleDailyBrief();
          }
        })();
      }, Math.max(60000, delay)).unref?.();
      logger.info?.(`[onebot] 每日简讯将在 ${next.toLocaleString("zh-CN")} 触发`);
    }

  // 4.1.3：连发搭话已删除
  async function morningCatchup() {
      if (!cfg.morningCatchup) return;
      for (const [key, entry] of sessions.entries) {
        const pend = entry.nightPending ?? [];
        if (!pend.length) continue;
        if (!entry.lastTarget) continue;
        const list = pend
          .slice(-6)
          .map((p) => `${p.name}：${p.text}`)
          .join("\n");
        entry.nightPending = [];
        try {
          const text = await sessions.generate(
            key,
            "（内部：你昨晚睡了，这是你不在时群里的消息。现在是早上，你刚醒。" +
              "要不要说点什么、说什么，你自己看——想接就自然说一两句，不想接也完全可以不说；" +
              "不用逐条回，也不用为不在场道歉。\n" +
              list +
              "）",
          );
          const content = String(text || "").trim();
          if (content) {
            const ev = entry.lastTarget;
            await client.sendHuman(ev, content);
            logger.info?.(`[onebot] 早上补回 ${key}（${pend.length} 条）：${content.slice(0, 40)}`);
            audit({ kind: "morning_catchup", key, count: pend.length, text: content.slice(0, 200) });
            markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
            flushSeen();
          }
        } catch (err) {
          logger.warn?.(`[onebot] 早上补回失败 ${key}：${err?.message ?? err}`);
        }
      }
    }

  function scheduleMorningCatchup() {
      if (!cfg.morningCatchup) return;
      const now = new Date();
      const next = new Date(now);
      next.setHours(Number(cfg.morningCatchupHour) || 7, Number(cfg.morningCatchupMinute) || 30, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      setTimeout(() => {
        void (async () => {
          try {
            await morningCatchup();
          } finally {
            scheduleMorningCatchup();
          }
        })();
      }, Math.max(60000, next - now)).unref?.();
      logger.info?.(`[onebot] 早上补回将在 ${next.toLocaleString("zh-CN")} 触发`);
    }

  async function dailyDiary() {
      if (cfg.dailyDiary === false) return;
      try {
        const d = new Date();
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const st = summarizeDay(ymd) ?? {};
        const dialog = recentDialog(20);
        const picked = pickTarget();
        if (!picked) return;
        const text = await sessions.generate(
          picked[0],
          "（内部：现在是一天结束的时候，写一段你今天的日记，给创造者看。" +
            "回顾今天：和谁聊了什么、看到什么有意思的事、有没有说错话、心情怎么样。" +
            "150 字以内，第一人称，像真人写日记，不要分点、不要总结成报告。）\n" +
            `【今天的数字】收到 ${st.inbound ?? 0} 条消息，回了 ${st.replies ?? 0} 条。\n` +
            (dialog ? `【今天的片段】\n${dialog}\n` : ""),
        );
        const content = String(text || "").trim();
        if (!content) return;
        await client.sendPrivate(cfg.ownerId, `今天我的一天：\n${content}`);
        logger.info?.(`[onebot] 已发送今日日记（${content.length} 字）`);
        audit({ kind: "daily_diary", text: content.slice(0, 200) });
      } catch (err) {
        logger.warn?.(`[onebot] 写日记失败：${err?.message ?? err}`);
      }
    }

  function scheduleDiary() {
      if (cfg.dailyDiary === false) return;
      const now = new Date();
      const next = new Date(now);
      next.setHours(Number(cfg.dailyDiaryHour) || 23, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      setTimeout(() => {
        void (async () => {
          try {
            await dailyDiary();
          } finally {
            scheduleDiary();
          }
        })();
      }, Math.max(60000, next - now)).unref?.();
      logger.info?.(`[onebot] 今日日记将在 ${next.toLocaleString("zh-CN")} 生成`);
    }

  async function dailyReflect(force = false) {
      if (!cfg.selfReflect) return { ok: false, reason: "回看已被配置关闭" };
      try {
        const picked = pickTarget();
        if (!picked) return { ok: false, reason: "现在没有可复盘的对话" };
        const dialog = recentDialog(12);
        const views = selfViews.render(6);
        const text = await sessions.generate(
          picked[0],
          "（内部：现在是你每天的自我复盘时间。下面是今天的一些对话片段和你已有的看法。\n" +
            (dialog ? `【今天的对话】\n${dialog}\n` : "") +
            (views ? `【你之前的看法】${views}\n` : "") +
            "想一想：1) 有没有哪句话说得不合适、太冲或太敷衍？2) 对某个人的态度要不要调整？" +
            "3) 你对某件事的看法有没有变？用两三句话写下来，像日记。只输出回看本身，不要解释。\n" +
            "如果你形成了新的明确看法，可以调 remember_self 记下来。）",
        );
        const content = String(text || "").trim();
        if (!content) return { ok: false, reason: "这次没写出东西来" };
        selfViews.addReflection(content);
        logger.info?.(`[onebot] 今日回看：${content.slice(0, 60)}`);
        audit({ kind: "reflect", text: content.slice(0, 300) });
        // 反思完看要不要微调「我是什么样的」——工具调用时等它结束，好把结果带回去
        let adjusted = null;
        try {
          adjusted = await maybeAdjustSelfModel("dailyReflect", force === true);
        } catch {
          // 忽略
        }
        return { ok: true, reflect: content, adjusted };
      } catch (err) {
        logger.warn?.(`[onebot] 回看失败：${err?.message ?? err}`);
        return { ok: false, reason: String(err?.message ?? err) };
      }
    }

  function scheduleReflect() {
      if (!cfg.selfReflect) return;
      const now = new Date();
      const next = new Date(now);
      next.setHours(Number(cfg.reflectHour) || 22, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      setTimeout(() => {
        void (async () => {
          try {
            await dailyReflect();
          } finally {
            scheduleReflect();
          }
        })();
      }, Math.max(60000, next - now)).unref?.();
      logger.info?.(`[onebot] 自我反思将在 ${next.toLocaleString("zh-CN")} 触发`);
    }

  async function maybeCompactAll() {
      const limitMB = Number(cfg.compactThresholdMB) || 5;
      const compaction = ctx.get?.("compaction");
      if (!compaction?.compactNow) return;
      for (const [key, entry] of sessions.entries) {
        try {
          const f = findSessionFile(entry.sessionId);
          if (!f) continue;
          const mb = statSync(f).size / 1024 / 1024;
          if (mb < limitMB) continue;
          const agent = entry.handle?.agent;
          if (!agent) continue;
          logger.info?.(`[onebot] ${key} 的会话已 ${mb.toFixed(1)}MB，超过 ${limitMB}MB，开始压缩`);
          await compaction.compactNow(agent, new AbortController().signal);
          audit({ kind: "compact", key, mb: Number(mb.toFixed(1)) });
          logger.info?.(`[onebot] ${key} 压缩完成（原文仍保留在 jsonl 里，可用 recall 检索）`);
        } catch (err) {
          logger.warn?.(`[onebot] 压缩 ${key} 失败：${err?.message ?? err}`);
        }
      }
    }

  function fireDuePlan() {
      try {
        const due = claimDueSelfPlan();
        if (!due) return false;
        if (due.expired) {
          logger.info?.(`[onebot] 日程 ${due.id} 已过期，跳过（不半夜补跑）`);
          return false;
        }
        patchSelfState({
          selfActivityFiredAt: Number(due.at),
          selfActivityNextAt: 0,
          selfActivityPlanId: due.id,
          selfActivityKind: due.kind || "",
          selfActivityNote: due.note || "",
        });
        enqueueEvent(
          makeEvent("activity_due", { type: "timer" }, {
            kind: String(due.kind || ""),
            note: String(due.note || ""),
            planId: String(due.id),
          }),
        );
        logger.info?.(
          `[onebot] 日程到点：${due.id} ${due.kind || ""} ${String(due.note || "").slice(0, 30)}`,
        );
        return true;
      } catch (err) {
        logger.debug?.("[onebot] 日程检查失败：" + (err?.message ?? err));
        return false;
      }
    }

  return { checkReminders, scheduleProactive, scheduleDailyBrief, scheduleMorningCatchup, scheduleDiary, scheduleReflect, fireDuePlan, morningCatchup, dailyReflect, dailyDiary, maybeCompactAll };
}

export {  };
