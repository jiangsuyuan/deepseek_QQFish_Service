// 常驻定时器：心跳、轮询、清理。

export function startTimers(app) {
  const { ACTIVITY_KINDS, EXPLORE_LOG, HEALTH_PATH, HOME, INBOUND_TEXT_MAX, NET_DECAY, NET_MAX_DEPTH, NET_MIN_W, NET_VISIT_CAP, OUTAGE_PATH, QZONE_PLAN, RUNTIME_PATH, SELF_ACTIVITY_KEY, SELF_HISTORY_PATH, SELF_MODEL_PATH, TOOL_LOG_SKIP, WEBHIST_PATH, activeHoursOk, audit, auditEnabled, cfg, checkQuietGroups, checkReminders, checkSoloStreak, checkTokenBudget, chmodSync, client, copyFileSync, createWebServer, entryLastTopic, existsSync, fireDuePlan, flushInbox, health, hourlyIntrospect, inQuietHours, join, loadActivities, loadSelfModel, loadWebHistory, logger, maybeCompactAll, maybeQzone, memSeen, mkdirSync, myMsgIds, myMsgOrder, net, nextQzoneTick, nextSelfPlan, noteMyMessage, pendingWhileBooting, pickTarget, pollFriendRequests, pollMissedMentions, qzoneLog, readFileSync, recentIds, refreshQqOnline, rotateAudit, runThinkingCycle, saveSelfModel, scheduleDailyBrief, scheduleDiary, scheduleMorningCatchup, scheduleNextSelfActivity, scheduleProactive, seenState, sessions, sleep, snapshotRuntime, statSync, state, unlinkSync, webClients, webHistory, webPush, webStart, pluginCtx: ctx } = app;
  setInterval(() => flushInbox(), 30_000).unref?.();

  setInterval(() => void refreshQqOnline(), 60_000).unref?.();

  setTimeout(() => {
      // 不管 agentReady 是不是已经被别的路径置 true，暂存队列都必须清空
      // （之前写成 if(!agentReady) 包住，预热快的机器上队列永远不放行，消息就卡死了）
      {
        state.agentReady = true;
        const queued = pendingWhileBooting.splice(0);
        if (queued.length) logger.warn?.(`[onebot] 放行 ${queued.length} 条暂存消息`);
        for (const qev of queued) {
          const mid = String(qev.message_id ?? "");
          // 已经回复过的（seen 里有 id）就别再回一遍
          try {
            const qkey = qev.group_id ? `group:${qev.group_id}` : `private:${qev.user_id}`;
            const rec = seenState[qkey];
            if (rec && Array.isArray(rec.ids) && rec.ids.map(String).includes(mid)) {
              logger.info?.(`[onebot] 重放跳过已回复的 ${mid}`);
              continue;
            }
          } catch {
            // 忽略
          }
          try {
            recentIds.delete(mid);
          } catch {
            // 忽略
          }
          void client.onEvent(qev).catch(() => {});
        }
      }
    }, 20000).unref?.();

  // 4.1.2：热点主动分享也删了——主动通道只剩"活动里看群"


  setInterval(() => {
      try {
        checkSoloStreak();
      } catch (err) {
        logger.warn?.(`[onebot] 连发检查失败：${err?.message ?? err}`);
      }
    }, 60000).unref?.();

  // 4.1：冷场搭话已删除（不再因为群安静就主动冒泡）

  setInterval(() => {
      void maybeCompactAll();
    }, Math.max(5, Number(cfg.compactCheckMinutes) || 30) * 60 * 1000).unref?.();

  setInterval(() => {
      void pollMissedMentions();
    }, Math.max(60, Number(cfg.pollMentionsSeconds) || 120) * 1000).unref?.();

  // 4.1：每小时回顾已删除（25 次/天、只盯一个最活跃的群、产出极少）

  setTimeout(() => {
      void (async () => {
        try {
          const m = loadSelfModel();
          if (m.fact?.text) return; // 已经有了
          logger.info?.("[onebot] 还没有自我认知，生成初版");
          const out = String(
            (await sessions.runSilent(
              SELF_ACTIVITY_KEY,
              "（内部，不要发消息。写一下你对自己的认识。）\n" +
                "根据你记得的东西、你说过的话、别人对你的评价，写三条：\n" +
                "1. fact：我是什么样的（客观：我是什么、每天在做什么）\n" +
                "2. inner：我觉得我是什么样的（内在感受，可以和上一条不一样）\n" +
                "3. mirror：在别人眼里我好像是什么样的\n" +
                "每条不超过 100 字，用第一人称。\n" +
                '只输出 JSON：{"fact":"...","inner":"...","mirror":"...","tensions":[]}',
            )) ?? "",
          ).trim();
          const mm = out.match(/\{[\s\S]*\}/);
          if (!mm) {
            logger.warn?.("[onebot] 自我认知初版：没解析出 JSON");
            return;
          }
          const obj = JSON.parse(mm[0]);
          const now = Date.now();
          saveSelfModel({
            fact: { text: String(obj.fact || "").slice(0, 2000), updatedAt: now },
            inner: {
              text: String(obj.inner || "").slice(0, 2000),
              tensions: Array.isArray(obj.tensions)
                ? obj.tensions.map((x) => String(x).slice(0, 100)).slice(0, 3)
                : [],
              updatedAt: now,
            },
            mirror: { text: String(obj.mirror || "").slice(0, 200), sources: [], updatedAt: now },
          });
          audit({ kind: "self_model_init" });
          logger.info?.(`[onebot] 自我认知初版已生成：${String(obj.fact || "").slice(0, 50)}`);
        } catch (err) {
          logger.warn?.(`[onebot] 自我认知初版生成失败：${err?.message ?? err}`);
        }
      })();
    }, 3 * 60_000).unref?.();

  setInterval(() => {
      void (async () => {
        try {
          const f = join(HOME, ".dsh/onebot-bridge/run-cycles");
          if (!existsSync(f)) return;
          const raw = readFileSync(f, "utf8").trim();
          unlinkSync(f);
          // 支持：
          //   "5"                 → 5 轮，自己决定
          //   "explore 2"         → 2 次探险
          //   "read"              → 1 次读书
          //   "explore 2\nread 1" → 组合
          const VALID = ["explore", "read", "play", "think", "write", "recall", "dream", "study", "watch_groups"];
          const jobs = [];
          for (const line of raw.split("\n")) {
            const parts = line.trim().split(/\s+/);
            if (!parts[0]) continue;
            const cnt = Math.max(1, Math.min(10, Number(parts[1]) || 1));
            if (VALID.includes(parts[0])) {
              for (let i = 0; i < cnt; i++) jobs.push({ kind: parts[0] });
            } else if (/^\d+$/.test(parts[0])) {
              for (let i = 0; i < Math.max(1, Math.min(10, Number(parts[0]))); i++) jobs.push({ kind: null });
            }
          }
          if (!jobs.length) {
            logger.info?.("[onebot] 触发文件内容没看懂");
            return;
          }
          logger.info?.(`[onebot] 手动触发 ${jobs.length} 轮：${jobs.map((j) => j.kind || "auto").join(",")}`);
          for (let i = 0; i < jobs.length; i++) {
            try {
              await runThinkingCycle(
                jobs[i].kind ? { forceAction: jobs[i].kind, byOwner: true } : { byOwner: true },
              );
            } catch (err) {
              logger.warn?.(`[onebot] 第 ${i + 1} 轮失败：${err?.message ?? err}`);
            }
            if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 2000));
          }
          logger.info?.(`[onebot] 手动触发的 ${jobs.length} 轮完成`);
        } catch {
          // 忽略
        }
      })();
    }, 20_000).unref?.();

  setInterval(fireDuePlan, 30_000).unref?.();

  setTimeout(() => {
      try {
        const p = nextSelfPlan();
        if (p) {
          const leftMin = Math.round((Number(p.at) - Date.now()) / 60_000);
          logger.info?.(
            `[onebot] 恢复日程：${p.kind || "活动"} ${leftMin >= 0 ? leftMin + " 分钟后" : "已过期 " + Math.abs(leftMin) + " 分钟"}（${p.id}）`,
          );
        } else {
          scheduleNextSelfActivity(0);
        }
      } catch {
        // 忽略
      }
    }, 30_000).unref?.();

  setInterval(() => {
      void pollFriendRequests();
    }, 120000).unref?.();

  setInterval(() => {
      if (client.connected) return;
      void (async () => {
        const ok = await new Promise((resolve) => {
          try {
            const sock = net.connect({ host: "127.0.0.1", port: 3001 });
            const done = (v) => {
              try {
                sock.destroy();
              } catch {
                // 忽略
              }
              resolve(v);
            };
            sock.setTimeout(700);
            sock.once("connect", () => done(true));
            sock.once("error", () => done(false));
            sock.once("timeout", () => done(false));
          } catch {
            resolve(false);
          }
        });
        if (ok) {
          logger.info?.("[onebot] 探到 3001 已就绪，立即重连");
          client.reconnectNow();
        }
      })();
    }, 5000).unref?.();

  setTimeout(() => {
      void pollFriendRequests();
    }, 40000).unref?.();

  setInterval(() => {
      void checkReminders().catch((err) => logger.warn?.(`[onebot] 提醒检查失败：${err?.message ?? err}`));
    }, 30000).unref?.();

  setInterval(() => {
      try {
        checkTokenBudget();
      } catch {
        // 忽略
      }
    }, 10 * 60 * 1000).unref?.();

  setTimeout(() => {
      void client.onReconnected?.();
    }, 10000).unref?.();
}

export {  };
