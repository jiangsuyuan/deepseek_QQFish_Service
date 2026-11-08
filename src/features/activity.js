// 活动调度：下次活动、整点内省、自我模型调整。

export function createActivityLoop(ctx) {
  const { SELF_ACTIVITY_KEY, SELF_HISTORY_PATH, segments, addSelfPlan, audit, cfg, client, l1Push, loadActivities, loadGroupMeta, loadSelfModel, loadSelfState, loadWants, logger, offlineDigest, patchSelfState, readSelfPlan, recentDigestText, saveSelfModel, sessions, state, updateSelfPlan, watchHit, writeFileSync } = ctx;
  function isOfflineMode() {
      if (client.connected && state.qqOnline) {
        if (state.offlineSince) {
          const mins = Math.round((Date.now() - state.offlineSince) / 60000);
          logger.info?.(`[onebot] 恢复在线（离线 ${mins} 分钟）`);
          audit({ kind: "back_online", minutes: mins });
          // 恢复后第一次内省要带上「离线期间我做了什么」
          state.offlineSummaryPending = true;
          // 断线期间群里说了什么，按关注规则补进待看——解封后第一眼就能看到错过了什么
          try {
            const meta = loadGroupMeta() || {};
            const sinceMs = Date.now() - mins * 60_000 - 3_600_000;
            let cnt = 0;
            for (const gid of Object.keys(meta)) {
              const recent = Array.isArray(meta[gid]?.recent) ? meta[gid].recent : [];
              for (const r of recent) {
                if ((Number(r?.t) || 0) <= sinceMs) continue;
                const line = String(r?.l ?? "");
                if (!line) continue;
                const hits = watchHit(line, "");
                if (!hits.length) continue;
                l1Push({ group: gid, who: "", text: line, hits, at: Number(r.t) });
                cnt += 1;
                if (cnt >= 40) break;
              }
            }
            if (cnt > 0) {
              logger.info?.(`[onebot] 断线期间有 ${cnt} 条命中关注规则，已补进待看`);
              audit({ kind: "backfill_watch", count: cnt, minutes: mins });
            }
          } catch (err) {
            logger.warn?.(`[onebot] 断线补偿失败：${err?.message ?? err}`);
          }
          // 顺手把「她这段时间想要的东西」报给创造者
          try {
            const pend = loadWants().filter((w) => w.status === "pending");
            if (pend.length && cfg.ownerId) {
              const list = pend
                .slice(-8)
                .map((w) => `· [${w.kind}] ${w.what}${w.why ? `（因为：${String(w.why).slice(0, 40)}）` : ""}`)
                .join("\n");
              void client
                .sendPrivate(
                  cfg.ownerId,
                  `她这段时间记下了 ${pend.length} 个想要的东西：\n${list}\n\n` +
                    `（回「给她 <序号>」批，回「算了 <序号>」拒；或者你自己看 wants.json）`,
                )
                .catch(() => {});
              logger.info?.(`[onebot] 已向创造者汇报 ${pend.length} 条待处理需求`);
            }
          } catch {
            // 忽略
          }
          state.offlineSince = 0;
        }
        return false;
      }
      if (!state.offlineSince) {
        // 启动时就未连接（比如封号期间重启）：视为已离线够久，
        // 否则每次重启都要空等 30 分钟才进离线模式
        state.offlineSince = Date.now() - 31 * 60_000;
      }
      return Date.now() - state.offlineSince > 30 * 60_000;
    }

  async function hourlyIntrospect() {
      if (cfg.hourlyIntrospect === false || cfg.autoActionsEnabled === false) return;
      const offline = isOfflineMode();
      // 离线时也能内省（只要 agent 可用），只是没群聊素材
      if (!offline && !client.connected) return;
      const nowTs = Date.now();
      // 离线：没新对话，改成「翻自己的记忆」
      if (offline) {
        const digest = offlineDigest() || "";
        const runKey = SELF_ACTIVITY_KEY;
        logger.info?.("[onebot] 离线内省：回顾自己的记忆");
        audit({ kind: "introspect_offline" });
        try {
          await sessions.runSilent(
            runKey,
            "（内部回顾，不用回复任何人，也不要发消息。）\n" +
              "你最近没法在群里说话，但还在想事情。\n" +
              (digest ? digest + "\n" : "") +
              "想一想：\n" +
              "1. 这些东西里，有没有互相矛盾、或者能串起来形成新看法的？有就用 remember_self 记下。\n" +
              "2. 有没有哪个话题让你觉得「还没想明白」？有就记下来（我们下次去查）。\n" +
              "3. 有没有对自己的新认识？有就写一条反思。\n" +
              "都没有就只回一个字：无。",
          );
        } catch (err) {
          logger.warn?.(`[onebot] 离线内省失败：${err?.message ?? err}`);
        }
        return;
      }

      // 挑最近 1 小时内有活动的群（只在有话题的会话里回顾才有意义）
      let bestKey = null;
      let bestAt = 0;
      for (const [k, e] of sessions.entries) {
        if (!k.startsWith("group:")) continue;
        const t = e.lastMessageAt ?? 0;
        if (t > bestAt) {
          bestAt = t;
          bestKey = k;
        }
      }
      if (!bestKey || nowTs - bestAt > 3600_000) {
        logger.debug?.("[onebot] 这一小时没什么可回顾的，跳过内省");
        return;
      }
      const gid = bestKey.slice(6);
      // 群回顾也用分段会话：这条以前挂永久键，一个群能涨到 20 万 token
      let reviewKey = bestKey;
      try {
        reviewKey = segments ? segments.keyFor("review:group:" + gid).key : bestKey;
      } catch {
        reviewKey = bestKey;
      }
      logger.info?.(`[onebot] 内省：回顾最近一小时（${bestKey} → ${reviewKey}）`);
      audit({ kind: "introspect", key: bestKey });
      // backNote 从 1.1.7 起就是个没定义的标识符：走到「有活跃群的每小时回顾」这个分支
      // 必抛 ReferenceError，被下面的 catch 吞成一行 warn —— 于是这条内省从来没跑成过
      // （今天 20 次、0 次成功）。先给它一个空串把它救活；真要给她「回看素材」，
      // 再拿 groupPatrolList(gid, 1) 去填，别再一次加一个没定义的变量。
      const backNote = "";
      try {
        await sessions.runSilent(
          reviewKey,
          "（内部回顾，不用回复任何人，也不要发任何消息到群里。）\n" +
            backNote +
            "刚才这一小时你在这个群聊了不少。想一想：\n" +
            "1) 有没有值得记住的事实（某人的习惯、某件事的来龙去脉）？有就用 remember_fact 存下来。\n" +
            "2) 有没有值得记下的人物特征（谁说话什么风格、在意什么）？有就用 remember_person。\n" +
            "3) 有没有形成新的看法？有就用 remember_self 存成一条观点（想法可以无限累积，不用为了腾地方删旧的）。\n" +
            "4) 有没有哪条旧想法现在不成立了、或者想说得更准？用 revise_self 改写，或用 forget_self 删掉。\n" +
            "5) 有没有让你觉得「刚才那样不太对」的地方？如果确实需要反思，就用 remember_self 写一条反思（带 reflect 标记）。\n" +
            "如果都没有，只回一个字：无。",
        );
      } catch (err) {
        logger.warn?.(`[onebot] 内省失败：${err?.message ?? err}`);
      }
    }

  async function maybeAdjustSelfModel(reason, force = false) {
      try {
        const m = loadSelfModel();
        const now = Date.now();
        const MIN_GAP_HOURS = Number(cfg.selfModelMinGapHours ?? 48);
        const lastAt = Math.max(m.fact?.updatedAt ?? 0, m.inner?.updatedAt ?? 0, m.mirror?.updatedAt ?? 0);
        // force=true 只由她主动调 explore_heart 时传进来：她自己判断该改了，就不拦。
        // 冷却仍然对「自动微调」生效，防止无人值守时反复改人格。
        if (!force && lastAt && now - lastAt < MIN_GAP_HOURS * 3600_000) {
          logger.info?.("[onebot] 自我认知还没到该变的时候");
          return;
        }
        const digest = recentDigestText(3);
        const sources = (m.mirror?.sources ?? [])
          .slice(-6)
          .map((x) => `· ${x.said}`)
          .join("\n");
        const runKey = SELF_ACTIVITY_KEY;
        const out = String(
          (await sessions.runSilent(
            runKey,
            "（内部整理，不要发消息，不要用工具。这是你对「自己是谁」的认识。）\n" +
              "[现在的三条]\n" +
              `事实：${m.fact?.text || "（还没写过）"}\n` +
              `我觉得：${m.inner?.text || "（还没写过）"}\n` +
              `别人眼里：${m.mirror?.text || "（还没写过）"}\n` +
              `（心里没摆平的事：${(m.inner?.tensions ?? []).join("；") || "无"}）\n\n` +
              (digest ? `[最近这几天的经历]\n${digest}\n` : "") +
              (sources ? `[最近别人对你的评价]\n${sources}\n` : "") +
              "\n今天想请你微调一下这三条。规则很重要：\n" +
              "1. **只改需要改的句子**，没变的原样返回——你不该每天换一个人；\n" +
              "2. 每条不超过 120 字；\n" +
              "3. 如果不打算改，就返回原来那句。\n" +
              '只输出 JSON：{"fact":"...","inner":"...","tensions":["..."],"mirror":"...","why":"这次为什么改"}',
          )) ?? "",
        ).trim();
        const mm = out.match(/\{[\s\S]*\}/);
        if (!mm) return;
        const obj = JSON.parse(mm[0]);
        let changed = [];
        const pick = (k) => String(obj[k] ?? "").trim().slice(0, 150);
        const upd = (layer, val) => {
          if (!val || val === m[layer]?.text) return;
          const before = m[layer]?.text || "";
          m[layer] = { ...(m[layer] || {}), text: val, updatedAt: now };
          try {
            writeFileSync(
              SELF_HISTORY_PATH,
              JSON.stringify({ at: now, layer, before, after: val, why: String(obj.why || reason || "").slice(0, 100) }) + "\n",
              { flag: "a" },
            );
          } catch {
            // 忽略
          }
          changed.push(layer);
        };
        upd("fact", pick("fact"));
        upd("inner", pick("inner"));
        upd("mirror", pick("mirror"));
        const tens = Array.isArray(obj.tensions) ? obj.tensions.map((x) => String(x).slice(0, 80)).slice(0, 3) : null;
        if (tens && JSON.stringify(tens) !== JSON.stringify(m.inner?.tensions ?? [])) {
          m.inner = { ...(m.inner || {}), tensions: tens, updatedAt: now };
          changed.push("tensions");
        }
        if (changed.length) {
          saveSelfModel(m);
          audit({ kind: "self_model", changed, why: String(obj.why || "").slice(0, 80) });
          logger.info?.(`[onebot] 自我认知微调：${changed.join("/")}`);
        } else {
          logger.info?.("[onebot] 自我认知这次不用改");
        }
      } catch (err) {
        logger.warn?.(`[onebot] 自我认知调整失败：${err?.message ?? err}`);
      }
    }

  function scheduleNextSelfActivity(delayMinutes) {
      try {
        // 不再用定时器了，nextActivityTimer 已废弃
        if (cfg.selfActivityEnabled === false || cfg.autoActionsEnabled === false) return;
        // 她主动说了多久 → 尊重她（1 分钟 ~ 12 小时，但受每天保底次数约束）
        // 没说 → 默认 10-30 分钟
        // 她可以定 1-720 分钟（最长 12 小时）
        // 但有个「每天最低次数」保底：如果今天还没跑够，就把上限压短，保证能跑够
        const minPerDay = Number(cfg.selfActivityMinPerDay ?? 10);
        const todayStr = new Date().toDateString();
        const hourFrom = Number(cfg.selfActivityCountFromHour ?? 9);
        const hourTo = Number(cfg.selfActivityCountToHour ?? 23);
        const resetAt = Number(loadSelfState().selfActivityResetAt) || 0;
        const doneToday = loadActivities(300).filter((a) => {
          if (a.byOwner) return false;
          if (resetAt && a.at < resetAt) return false;
          const d = new Date(a.at);
          if (d.toDateString() !== todayStr) return false;
          const h = d.getHours();
          return h >= hourFrom && h < hourTo;
        }).length;

        const leftCount = Math.max(0, minPerDay - doneToday);
        const nowH = new Date().getHours();
        // 注意：如果现在不在统计窗口内（比如凌晨 2 点，窗口是 9-23），
        // 不能按 (hourTo - nowH) 算，那会算出 21 小时这种离谱的值
        let leftMinToday;
        if (nowH < hourFrom) {
          leftMinToday = (hourTo - hourFrom) * 60; // 还没开始，按整天算
        } else if (nowH >= hourTo) {
          leftMinToday = 0; // 窗口过了，今天不再安排
        } else {
          leftMinToday = (hourTo - nowH) * 60;
        }
        let maxGap = 720; // 12 小时
        if (leftCount > 0 && leftMinToday > 0) {
          // 还差 N 次，今天还剩 M 分钟 → 每次最多间隔 M/N
          maxGap = Math.min(maxGap, Math.max(1, Math.floor(leftMinToday / leftCount)));
          logger.info?.(
            `[onebot] 今天还差 ${leftCount} 次，剩 ${Math.round(leftMinToday / 60)} 小时，间隔上限收到 ${maxGap} 分钟`,
          );
        }

        const clamped =
          delayMinutes > 0
            ? Math.max(1, Math.min(maxGap, delayMinutes))
            : Math.max(1, Math.min(maxGap, 10 + Math.random() * 20));
        // 存盘：重启后不用重算，别把她自己定的时间丢了
        const targetAt = Date.now() + Math.round(clamped * 60_000);
        logger.info?.(
          `[onebot] 调度：delayMinutes=${delayMinutes} clamped=${clamped} 目标=${new Date(targetAt).toLocaleTimeString("zh-CN", { hour12: false })}`,
        );
        // 写进她自己的日程表；旧的 pending 作废，只保留最新一条
        for (const old of readSelfPlan()) {
          if (old.status === "pending") updateSelfPlan(old.id, { status: "superseded" });
        }
        const st0 = loadSelfState();
        addSelfPlan({
          at: targetAt,
          kind: String(st0.selfActivityKind || ""),
          note: String(st0.selfActivityNote || ""),
          source: "activity",
        });
        patchSelfState({ selfActivityNextAt: targetAt });
        if (delayMinutes > 0 && delayMinutes !== clamped) {
          logger.info?.(`[onebot] 她说 ${Math.round(delayMinutes)} 分钟，按 ${Math.round(clamped)} 分钟执行`);
        }
        logger.info?.(`[onebot] 下次自主活动约 ${Math.round(clamped)} 分钟后`);
      } catch {
        // 忽略
      }
    }

  return { scheduleNextSelfActivity, hourlyIntrospect, maybeAdjustSelfModel, isOfflineMode };
}

export {  };
