// 自主活动与内省回合。

export function createSelfActivity(ctx) {
  const { HOME, SELF_ACTIVITY_KEY, appendActivity, appendExploreLog, appendMem, audit, cfg, client, distillCore, isOfflineMode, join, loadActivities, loadCore, loadLearnings, loadSelfState, logger, maybeMakeDigest, patchSelfState, readFileSync, reflectPhase, runThinkingCycle, saveLearnings, scheduleNextSelfActivity, selfActivityHoursOk, selfViews, sessions, state, thinkPhase, updateSelfPlan, webPush, writeFileSync } = ctx;
  async function exploreByIntent(intent, why, nextHint) {
      const runKey = SELF_ACTIVITY_KEY;
      const offline = isOfflineMode();
      logger.info?.(`[onebot] 按她的意图去查：${String(intent).slice(0, 40)}`);
      audit({ kind: "explore_intent", intent: String(intent).slice(0, 120) });
      try {
        const raw = String(
          (await sessions.runSilent(
            runKey,
            "（内部探索，不要发消息。**你可以自己用 web_search 和 web_fetch**——想查什么就查什么。）\n" +
              "你刚才想去看看：\n" +
              `「${intent}」\n` +
              (why ? `为什么：${why}\n` : "") +
              (nextHint ? `上次留给自己的话：${nextHint}\n` : "") +
              "\n现在真去查这件事：\n" +
              "1. 用 web_search 搜你**真正想问的**（把 intent 拆成能搜的词）；\n" +
              "2. 挑看起来最靠谱的结果 web_fetch 读；\n" +
              "3. 页面上有更想深入了解的，再搜/再读一步（一共最多 3 跳）；\n" +
              "4. 如果搜不到，换个说法再搜一次；实在查不到就老实说查不到。\n\n" +
              "最后写 100-200 字：你查到了什么、跟你原来想的一样吗。\n" +
              '只输出 JSON：{"summary":"查到什么","learned":"我的感想","path":[{"stop":"看了什么","why":"为什么往这儿走"}],"next":"下次想去看看什么"}',
          )) ?? "",
        ).trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) {
          logger.info?.("[onebot] 按意图探索没产出内容");
          return "";
        }
        const obj = JSON.parse(m[0]);
        const summary = String(obj.summary || "").trim().slice(0, 2000);
        if (summary.length < 10) return "";
        const pathArr = Array.isArray(obj.path)
          ? obj.path.slice(0, 6).map((x) =>
              typeof x === "string"
                ? { stop: String(x).slice(0, 120), why: "" }
                : { stop: String(x?.stop ?? "").slice(0, 120), why: String(x?.why ?? "").slice(0, 160) },
            )
          : [];
        const learns = loadLearnings();
        const entry = {
          topic: String(intent).slice(0, 40),
          summary,
          learned: String(obj.learned || "").trim().slice(0, 200),
          next: String(obj.next || "").trim().slice(0, 200),
          path: pathArr,
          from: runKey,
          at: Date.now(),
          offline,
          byIntent: true,
        };
        learns.push(entry);
        saveLearnings(learns);
        appendExploreLog({
          at: Date.now(),
          offline,
          from: runKey,
          topic: entry.topic,
          stops: pathArr,
          summary: entry.summary,
          thought: entry.learned,
        });
        appendMem({
          kind: "learn",
          topic: String(intent).slice(0, 20),
          text: `查了「${String(intent).slice(0, 30)}」：${summary.slice(0, 120)}`,
          ref: "explore-intent",
          offline,
        });
        logger.info?.(`[onebot] 查完了：${summary.slice(0, 50)}`);
        return summary;
      } catch (err) {
        logger.warn?.(`[onebot] 按意图探索失败：${err?.message ?? err}`);
        return "";
      }
    }

  async function runThinkingCycleInner(opts = {}) {
      // 主人点名/测试触发的活动：不占她的每日额度
      const byOwner = opts.byOwner === true;
      if (!selfActivityHoursOk()) return;
      const offline = isOfflineMode();
      if (!offline && !client.connected) return;

      // ── 1. 思考 ──
      let plan = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          plan = await thinkPhase(opts.forceAction || null);
          if (plan) break;
        } catch (err) {
          logger.warn?.(`[onebot] 思考阶段失败：${err?.message ?? err}`);
        }
      }
      if (!plan) {
        // 想不出来 = 这轮没跑成。不要排下次时间（那等于假装跑过了），
        // 保持原来的 nextAt 不变，让自检下一轮再看。
        logger.info?.("[onebot] 没想出来要做什么，本轮跳过（不改下次时间）");
        return;
      }
      logger.info?.(`[onebot] 想好了：${plan.action} — ${plan.intent.slice(0, 40)}`);
      audit({ kind: "think_plan", ...plan });

      // ── 2. 行动 ──
      let actOut = "";
      try {
        if (plan.action === "explore") {
          // 按她说的 intent 去查，而不是从群聊高频词里挑
          const lastNext = [...loadLearnings()].reverse().find((l) => l.next)?.next || "";
          const got = await exploreByIntent(plan.intent, plan.why, lastNext);
          actOut = got || "查了，但没查到有用的东西";
        } else {
          actOut = await actPhase(plan);
        }
      } catch (err) {
        logger.warn?.(`[onebot] 行动阶段失败：${err?.message ?? err}`);
        actOut = `（做失败了：${String(err?.message ?? err).slice(0, 80)}）`;
      }
      logger.info?.(`[onebot] 做完：${String(actOut).slice(0, 50)}`);

      // ── 3. 回看 ──
      const reflectRes = await reflectPhase(plan, actOut);
      const reflectOut = reflectRes.text;

      // ── 记录 ──
      // 下次什么时候：这次真的排进去。
      // 以前这里只算了个数写进活动记录，selfActivityNextAt 根本没人写，
      // tickSelfActivity 的 before/after 恒等 → 永远走「兜底 40 分钟」，
      // 她在 [[next: 2h]] 里定的时间一次都没生效过（日志还照打印，是假的）。
      // 走 scheduleNextSelfActivity 而不是直接 patchSelfState：只有它带
      // 「每日保底次数」的 maxGap 压缩，直接写状态会绕过保底。
      const wantDelay = Number(reflectRes.delayMin) || 0;
      scheduleNextSelfActivity(wantDelay);
      const scheduledAt = Number(loadSelfState().selfActivityNextAt) || 0;
      const realDelay =
        scheduledAt > Date.now() ? Math.max(1, Math.round((scheduledAt - Date.now()) / 60_000)) : 0;

      appendActivity({
        at: Date.now(),
        kind: plan.action,
        content: String(actOut).slice(0, 3000),
        think: plan,
        reflect: reflectOut,
        offline,
        byOwner,
        nextDelayMin: realDelay,
        nextWantMin: Math.round(wantDelay),
        nextAt: scheduledAt,
      });
      appendMem({
        kind: plan.action,
        topic: String(plan.intent || "").slice(0, 20),
        text: `${plan.intent} → ${String(actOut).slice(0, 100)}`,
        ref: "thinking-cycle",
        offline,
      });
      if (reflectOut) {
        try {
          selfViews.addReflection(reflectOut);
        } catch {
          // 忽略
        }
      }
      audit({ kind: "reflect_cycle", action: plan.action, reflect: String(reflectOut).slice(0, 200) });
      logger.info?.(`[onebot] 回看：${String(reflectOut).slice(0, 60)}`);

      // ── 后处理 ──
      try {
        void maybeMakeDigest();
      } catch {
        // 忽略
      }
      try {
        const total = loadActivities(300).length;
        if (total > 0 && total % 10 === 0) void distillCore();
      } catch {
        // 忽略
      }
      // 下次什么时候，由反思决定（上面已经真的排进去了，这里只如实报）
      if (wantDelay) {
        logger.info?.(
          `[onebot] 回看里定了 ${Math.round(wantDelay)} 分钟，实际排 ${realDelay} 分钟后` +
            (realDelay && Math.round(wantDelay) !== realDelay ? "（被每日保底压短）" : ""),
        );
      } else {
        logger.info?.(`[onebot] 回看没说下次什么时候，按默认排 ${realDelay} 分钟后`);
      }
      if (!realDelay) logger.warn?.("[onebot] 这轮没排出下次时间（自主活动被关了？）");
    }

  async function actPhase(plan) {
      const runKey = SELF_ACTIVITY_KEY;
      const kind = plan.action;
      const base =
        "（这是你自己的时间，不要发消息。你刚才已经想清楚了要做什么，现在去做。）\\n" +
        `你想做的：${plan.intent}\\n` +
        `为什么：${plan.why}\\n` +
        (plan.mood ? `现在的心情：${plan.mood}\\n` : "") +
        "\\n";
      let prompt = "";
      if (kind === "think") {
        prompt =
          base +
          "想这件事，想到一个能说清的地方。\\n" +
          "如果得出新的看法（是你自己的判断，不是复述别人），用 remember_self 记下来。\\n" +
          "最后一行写 [[next: 时间]]（多久之后想再来一次）。\\n" +
          "只输出你想清楚的那段话。";
      } else if (kind === "write") {
        prompt =
          base +
          "写点东西——随想、画面、一句没头没尾的话都行，像写在你自己本子上的。\\n" +
          "最后一行写 [[next: 时间]]。\\n" +
          "只输出你写的（50-150 字）。";
      } else if (kind === "recall") {
        prompt =
          base +
          "现在整理一下你的记忆，然后回忆。分两件事：\\n\\n" +
          "【整理】用 my_memory / memory_index / my_digest / my_wants 翻一遍：\\n" +
          "· 有没有重复或互相矛盾的？合并或改掉\\n" +
          "· 有没有过时、已经不成立的？删掉\\n" +
          "· 有没有说得太笼统、其实没用的？要么改具体，要么删\\n" +
          "· 事实、人物、观点、需求，哪一栏是空的或乱的，就补上或理齐\\n\\n" +
          "【回忆】整理完，再把散的东西串一串：\\n" +
          "· 有没有谁你很久没想起但还记得？\\n" +
          "· 有没有几件事连起来看，能看出点什么？\\n" +
          "想明白了就用 remember_fact / remember_person / remember_self 记新的理解。\\n\\n" +
          "最后写：整理了什么、串出了什么。最后一行写 [[next: 时间]]。\\n" +
          "只输出你做的和想到的。";
      } else if (kind === "dream") {
        prompt =
          base +
          "想想以后的事：你想变成什么样、想做什么。\\n" +
          "冒出具体愿望就用 note_want 记下来。\\n" +
          "最后一行写 [[next: 时间]]。\\n" +
          "只输出你想说的（50-150 字）。";
      } else if (kind === "study") {
        prompt =
          base +
          "现在研究代码。你可以读，也可以写，随你。\n\n" +
          "【读】用 read_source 看自己的一段实现——比如记忆怎么存的、回复怎么发出去的、" +
          "活动怎么调度的、某个你好奇的行为到底怎么实现的。\n" +
          "可以按关键词搜（keyword），也可以按行号翻。\n" +
          "看的时候问自己：\n" +
          "· 它是怎么做成这件事的？\n" +
          "· 有没有什么地方不对劲、可以更好、或者跟你以为的不一样？\n" +
          "发现值得改的，用 note_want 记进需求单（kind 填 feature，写清哪里不对、想改成什么样）。\n" +
          "没有就别硬提。\n\n" +
          "【写】也可以写点你想写的代码，用 exec_sandbox 跑一下看结果：\n" +
          "· 想验证一个想法（比如「我的活动间隔真的像我以为的那样吗」）\n" +
          "· 想算点什么（统计、模拟、画张图）\n" +
          "· 想造个小工具，或者只是想知道某段东西跑起来什么样\n" +
          "不用有明确目的，跑通了、看到结果了，就是收获。\n" +
          "（沙箱是断网的，碰不到你的记忆和源码原文件——那些是只读的。）\n\n" +
          "最后写 100-150 字：你看了什么、写了什么、跑出了什么、发现了什么。\n" +
          "最后一行写 [[next: 时间]]。只输出你做到的和想到的。";
      } else if (kind === "play") {
        const games = (() => {
          try {
            return readFileSync(join(HOME, ".dsh/onebot-bridge/games.jsonl"), "utf8")
              .split("\n")
              .filter(Boolean)
              .slice(-5)
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
          } catch {
            return [];
          }
        })();
        const gamesText = games.length
          ? `[你以前造过的游戏]\n${games.map((g) => `· ${g.name}：${String(g.rules || "").slice(0, 60)}`).join("\n")}\n（接着玩或造新的都行。）\n`
          : "";
        prompt =
          base +
          gamesText +
          "玩一会儿。造个小游戏然后玩它，或者接着玩以前造的。\n" +
          "可以很简单，也可以画点东西（draw_svg）。\n" +
          "写 100-150 字：玩的什么、怎么玩的、什么感觉。\n" +
          "想以后再玩就第一行写 [[game: 名字 | 规则]]；最后一行写 [[next: 时间]]。";
      } else if (kind === "read") {
        prompt =
          base +
          "找点书读。读什么由你定，**怎么找也由你定**——搜书名、找公版书、找试读、找书摘都行，\n" +
          "找不到整本就读一段，读不下去就换一本。\n" +
          "读完写 100-150 字：读的什么、读到哪段、什么感觉。\n" +
          "想接着读就第一行写 [[book: 书名 | 作者]]；最后一行写 [[next: 时间]]。";
      } else {
        return "";
      }

      logger.info?.(`[onebot] 阶段2 行动：${kind}`);
      const out = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
      try {
        // 下次时间由「反思」阶段决定，这里不处理
        const g = out.match(/\[\[game\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
        if (g && kind === "play") {
          writeFileSync(
            join(HOME, ".dsh/onebot-bridge/games.jsonl"),
            JSON.stringify({ at: Date.now(), name: String(g[1]).trim().slice(0, 40), rules: String(g[2] || "").trim().slice(0, 150) }) + "\n",
            { flag: "a" },
          );
        }
        const bk = out.match(/\[\[book\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
        if (bk && kind === "read") {
          writeFileSync(
            join(HOME, ".dsh/onebot-bridge/readings.jsonl"),
            JSON.stringify({ at: Date.now(), title: String(bk[1]).trim().slice(0, 60), author: String(bk[2] || "").trim().slice(0, 40) }) + "\n",
            { flag: "a" },
          );
        }
      } catch {
        // 忽略
      }
      return out
        .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
        .replace(/\[\[game\s*[:：][^\]\n]*\]\]/gi, "")
        .replace(/\[\[book\s*[:：][^\]\n]*\]\]/gi, "")
        .trim();
    }

  async function runSelfActivity(kind) {
      if (cfg.autoActionsEnabled === false) return;
      if (!selfActivityHoursOk()) return;
      const offline = isOfflineMode();
      if (!offline && !client.connected) return;
      if (kind === "explore") return maybeExplore(true);

      const runKey = SELF_ACTIVITY_KEY;
      const coreLines = loadCore()
        .slice(-8)
        .map((c) => `· ${c.text}`)
        .join("\n");
      const recent = loadActivities(12)
        .filter((a) => a.kind !== "explore")
        .slice(-6)
        .map((a) => `· [${a.kind}] ${String(a.content || "").slice(0, 60)}`)
        .join("\n");

      const base =
        "（这是你自己的时间，不用回复任何人，也不要发任何消息。你在心里做这件事。）\n" +
        (coreLines ? `[你现在记得的关于自己的事]\n${coreLines}\n` : "") +
        (recent ? `[你最近自己做过的事]\n${recent}\n` : "");

      let prompt = "";
      if (kind === "think") {
        prompt =
          base +
          "\n想一想你最近看到、听到的东西：它们让你怎么看事情？\n" +
          "如果你得出了什么新的看法（不是复述别人，是你自己的判断），用 remember_self 记下来。\n" +
          "只输出你想到的那句话，不要解释过程。";
      } else if (kind === "write") {
        prompt =
          base +
          "\n写点什么。不用有意义——一段随想、一个画面、一句没头没尾的话都行。\n" +
          "像你自己在本子上写的，不是给别人看的。\n" +
          "只输出你写下的内容（50-150 字）。";
      } else if (kind === "recall") {
        prompt =
          base +
          "\n翻翻你记得的人和事，把散的东西串一串：\n" +
          "· 有没有谁你很久没想起但还记得？\n" +
          "· 有没有几件事连起来看，能看出点什么？\n" +
          "想清楚了就用 remember_fact / remember_person 记下新的理解。\n" +
          "只输出你想到的内容。";
      } else if (kind === "read") {
        const past = (() => {
          try {
            const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/readings.jsonl"), "utf8");
            return raw
              .split("\n")
              .filter(Boolean)
              .slice(-5)
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
          } catch {
            return [];
          }
        })();
        const pastText = past.length
          ? `[你最近读过的]\n${past.map((r) => `· 《${r.title}》：${String(r.thought || "").slice(0, 50)}`).join("\n")}\n（可以接着读同一本，也可以换。）\n`
          : "";
        prompt =
          base +
          pastText +
          "\n现在读点书。先想：你想读什么？\n" +
          "· 可以是最近遇到、让你好奇的东西相关的书；\n" +
          "· 可以是早就想读但没开始的；\n" +
          "· 也可以只是想看某个作者怎么写东西。\n\n" +
          "然后自己去找——**怎么找由你决定**。可以用 web_search 搜书名、搜作者、搜「在线阅读」、\n" +
          "找公版书（古诗文、老作品）、找书摘、找第一章试读、找读书笔记……\n" +
          "找不到整本也没关系，读到一段是一段；实在找不到就换一本能读到的。\n\n" +
          "读完之后写 100-150 字：读的什么书、读到哪段、你什么感觉。\n" +
          "如果读得下去、想接着读，第一行写 [[book: 书名 | 作者]]。";
      } else if (kind === "play") {
        const games = (() => {
          try {
            const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/games.jsonl"), "utf8");
            return raw
              .split("\n")
              .filter(Boolean)
              .slice(-5)
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
          } catch {
            return [];
          }
        })();
        const gamesText = games.length
          ? `[你以前给自己造过的游戏]\n${games.map((g) => `· ${g.name}：${String(g.rules || "").slice(0, 80)}`).join("\n")}\n（可以接着玩，也可以造新的。）\n`
          : "";
        prompt =
          base +
          gamesText +
          "\n现在你有空，玩一会儿。给自己造个小游戏，然后玩它。\n" +
          "可以很简单：猜数字、词语接龙、自己出谜语自己解、给一个词找十个近义词、\n" +
          "算一道没算过的题、想象一个场景然后推演……也可以画点东西（能用 draw_svg）。\n" +
          "不用给别人玩，规则你自己定，输了赢了都行。\n" +
          "玩完写 100-150 字：玩的什么、怎么玩的、玩得怎么样。\n" +
          "如果你造了个想以后再玩的游戏，第一行写 [[game: 游戏名 | 一句话规则]]。";
      } else if (kind === "dream") {
        prompt =
          base +
          "\n想想以后。不是空想——是「如果有可能，我希望怎样」：\n" +
          "· 你想变成什么样的人？\n" +
          "· 有什么事你想做但还没做？\n" +
          "如果冒出一个具体的愿望，可以用 note_want 记下来。\n" +
          "只输出你想说的（50-150 字）。";
      } else {
        return;
      }

      // 让她自己决定下次什么时候再想这些事（几分钟还是几小时）
      prompt +=
        "\n\n最后单独一行，写下你下次想做点什么、大概隔多久：\n" +
        "格式：[[next: 45m]] 或 [[next: 2h]] 或 [[next: 明天早上]]\n" +
        "（凭感觉写，不用精确。刚做过的事可以隔久一点，没想完的可以早点再想。）";

      logger.info?.(`[onebot] 自主活动：${kind}`);
      try {
        const out = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
        if (!out || out.length < 4) {
          logger.info?.(`[onebot] ${kind} 没产出内容`);
          return;
        }
        // 解析她自己定的下次时间
        let delayMin = 0;
        try {
          const m = out.match(/\[\[?\s*next\s*[:：]\s*([^\]\n]{1,30})\]\]?/i);
          if (m) {
            const raw = String(m[1]).toLowerCase().trim();
            const num = parseFloat(raw);
            if (/h|小时|钟头/.test(raw) && !Number.isNaN(num)) delayMin = num * 60;
            else if (/m|分/.test(raw) && !Number.isNaN(num)) delayMin = num;
            else if (/明天|明早/.test(raw)) delayMin = 8 * 60;
            else if (/下午|晚上/.test(raw)) delayMin = 4 * 60;
            else if (!Number.isNaN(num) && !/^\d{4}\s*[-/.年]/.test(raw)) delayMin = num; // 裸数字当分钟；带年份日期的写法认不了，别硬猜
          }
        } catch {
          // 忽略
        }
        // 读书记录
        try {
          const bk = out.match(/\[\[book\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
          if (kind === "read" && bk) {
            writeFileSync(
              join(HOME, ".dsh/onebot-bridge/readings.jsonl"),
              JSON.stringify({
                at: Date.now(),
                title: String(bk[1]).trim().slice(0, 60),
                author: String(bk[2] || "").trim().slice(0, 40),
              }) + "\n",
              { flag: "a" },
            );
            logger.info?.(`[onebot] 她开始读：《${String(bk[1]).trim()}》`);
          }
        } catch {
          // 忽略
        }
        // 造出来的游戏存起来，下次还能接着玩
        try {
          const g = out.match(/\[\[game\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
          if (g && kind === "play") {
            writeFileSync(
              join(HOME, ".dsh/onebot-bridge/games.jsonl"),
              JSON.stringify({
                at: Date.now(),
                name: String(g[1]).trim().slice(0, 40),
                rules: String(g[2] || "").trim().slice(0, 150),
              }) + "\n",
              { flag: "a" },
            );
            logger.info?.(`[onebot] 她造了个游戏：${String(g[1]).trim()}`);
          }
        } catch {
          // 忽略
        }
        const cleanOut = out
          .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
          .replace(/\[\[game\s*[:：][^\]\n]*\]\]/gi, "")
          .replace(/\[\[book\s*[:：][^\]\n]*\]\]/gi, "")
          .trim();
        appendActivity({ at: Date.now(), kind, content: cleanOut.slice(0, 3000), offline });
        // 也记进统一记忆日志（带 kind 标签，方便摘要和检索）
        appendMem({
          kind,
          topic: kind === "explore" ? "" : String(cleanOut).slice(0, 20),
          text: cleanOut.slice(0, 160),
          ref: "activity",
          offline,
        });
        if (delayMin) {
          logger.info?.(`[onebot] 她说下次 ${Math.round(delayMin)} 分钟后再来（${kind}）`);
          scheduleNextSelfActivity(delayMin);
        } else {
          scheduleNextSelfActivity(0); // 用默认
        }
        // 记忆够 20 条就压一段摘要
        try {
          void maybeMakeDigest();
        } catch {
          // 忽略
        }
        // 每积累 10 次活动，沉淀一次核心记忆
        try {
          const total = loadActivities(300).length;
          if (total > 0 && total % 10 === 0) void distillCore();
        } catch {
          // 忽略
        }
        audit({ kind: "self_activity", act: kind, len: out.length });
        // 让主人在 WebUI 里看到她在忙什么（内生驱动可见）
        try {
          webPush({
            role: "activity",
            kind,
            text: `${actLabel(kind)}：${String(cleanOut).slice(0, 80)}`,
          });
        } catch {
          // 忽略
        }
        logger.info?.(`[onebot] ${kind} 完成：${out.slice(0, 50)}`);
      } catch (err) {
        logger.warn?.(`[onebot] ${kind} 失败：${err?.message ?? err}`);
      }
    }

  async function maybeExplore(force = false) {
      if (cfg.autoExplore === false || cfg.autoActionsEnabled === false) return;
      if (!selfActivityHoursOk()) return;
      const offline = isOfflineMode();
      // 离线时只有 agent 可用才跑（不需要 QQ）
      if (!offline && !client.connected) return;
      const today = new Date().toDateString();
      const learns = loadLearnings();
      const todayCount = learns.filter((l) => new Date(l.at).toDateString() === today).length;
      // 每天上限：0 = 不限（默认不限，靠「心情概率」和最小间隔控制）
      const maxPerDay = Number(cfg.autoExplorePerDay) || 0;
      if (maxPerDay > 0 && todayCount >= maxPerDay) return;
      // 至少隔一段时间，免得半小时一次全在附近打转
      const lastAt = learns.length ? learns[learns.length - 1].at : 0;
      const minGap = (Number(cfg.autoExploreMinGapMinutes) || 45) * 60000;
      if (lastAt && Date.now() - lastAt < minGap) return;
      // 看心情：由调度器挑中时才强制出门，单独跑时按概率
      if (!force) {
        const chance = Number(cfg.autoExploreChance ?? 0.35);
        if (Math.random() > chance) {
          logger.debug?.("[onebot] 这会儿没心情出去，下次再说");
          return;
        }
      }

      // 找最近活跃、且有话题的群
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

      // 离线：没有群聊素材，改成「从自己学过的东西里找没想明白的」
      let offlineTopic = "";
      if (offline || !bestKey || Date.now() - bestAt > 6 * 3600_000) {
        if (offline) {
          // 优先级 1：上次探险结束时自己规划的「下次想去看看什么」
          const lastWithNext = [...learns].reverse().find((l) => l.next && Date.now() - l.at < 14 * 86400_000);
          if (lastWithNext) {
            offlineTopic =
              `（上次出门时你给自己留了一句话：\n「${String(lastWithNext.next).slice(0, 160)}」\n` +
              `这趟就顺着它去看看。）`;
            logger.info?.(`[onebot] 离线探索：跟着上次的计划走（${String(lastWithNext.next).slice(0, 30)}）`);
          } else {
            // 优先级 2：从几天前的旧知识里挑一条深挖
            const old = learns.filter((l) => Date.now() - l.at > 3 * 86400_000);
            if (old.length) {
              const pick = old[Math.floor(Math.random() * old.length)];
              offlineTopic = `（你几天前学过「${pick.topic}」：${String(pick.summary).slice(0, 120)}\n但这块还有没想明白的地方，顺着它再深挖一层。）`;
              logger.info?.(`[onebot] 离线探索：从旧知识延伸「${pick.topic}」`);
            }
          }
        }
        if (!offlineTopic) return;
      }

      const ent = bestKey ? sessions.entries.get(bestKey) : null;
      const cnt = new Map();
      for (const it of ent?.topicWindow ?? []) for (const w of it.w || []) cnt.set(w, (cnt.get(w) ?? 0) + 1);
      const candidates = [...cnt.entries()]
        .filter(([w, c]) => {
          if (c < 2) return false;
          if (w.length < 2) return false;
          // 虚词/口头禅/代词——学到了也没意义
          const STOP = new Set([
            "这个", "那个", "什么", "就是", "没有", "可以", "不是", "现在", "然后",
            "还是", "但是", "因为", "所以", "如果", "虽然", "而且", "或者", "不过",
            "这样", "那样", "怎么", "为什么", "我们", "他们", "你们", "自己", "别人",
            "时候", "东西", "事情", "感觉", "觉得", "知道", "真的", "有点", "已经",
            "应该", "可能", "一直", "一样", "这么", "那么", "多少", "哪个", "哪些",
            "一个", "一次", "一下", "还有", "其实", "反正", "确实", "的确", "居然",
            "哈哈", "真的", "笑死", "离谱", "牛逼", "牛掰", "绝了", "草", "靠",
          ]);
          if (STOP.has(w)) return false;
          // 纯数字/纯字母也不算兴趣点
          if (/^[0-9a-zA-Z\s]+$/.test(w)) return false;
          return true;
        })
        .sort((a, b) => b[1] - a[1])
        .map(([w]) => w)
        .slice(0, 5);
      if (!candidates.length) return;

      let topic = "";
      if (offlineTopic) {
        topic = "延伸阅读";
      } else {
        if (!candidates.length) return;
        // 候选里再筛一遍：纯虚词/口头禅不要
        const BAD = /^(还是|但是|因为|所以|如果|虽然|而且|或者|不过|这样|那样|怎么|什么|这个|那个|就是|没有|可以|不是|现在|然后|时候|东西|事情|感觉|觉得|知道|真的|有点|已经|应该|可能|一直|一样|这么|那么|多少|哪个|哪些|一个|一次|一下|还有|其实|反正|确实|的确|居然|哈哈|笑死|离谱|牛逼|绝了)$/;
        const usable = candidates.filter((w) => !BAD.test(w));
        if (!usable.length) return;
        topic = usable[Math.floor(Math.random() * usable.length)];
        // 30 天内学过就不重复
        if (learns.some((l) => l.topic === topic && Date.now() - l.at < 30 * 86400_000)) return;
      }

      const runKey = bestKey || SELF_ACTIVITY_KEY;
      logger.info?.(`[onebot] ${offline ? "离线" : ""}自主探索：${offlineTopic ? "从旧知识延伸" : `围绕「${topic}」`}`);
      audit({ kind: "explore_start", topic, key: runKey, offline });
      try {
        const raw = String(
          (await sessions.runSilent(
            runKey,
            "（内部探索，不要发到群里。你可以用 web_search 和 web_fetch。）\n" +
              "把这次当成**出门走一趟**——你不是在查资料，是在外面逛，看到有意思的就停下来看看。\n" +
              (offlineTopic
                ? offlineTopic + "\n"
                : `最近群里聊到「${topic}」，你不太懂。顺着这个由头出门看看：\n`) +
              "1. 先 web_search 搜一次，挑一个看起来最靠谱的结果走过去；\n" +
              "2. web_fetch 读它。**如果页面上有让你好奇的链接或术语，就再走一步**（一共最多 3 步）；\n" +
              "3. 每走一步都记下「我为什么往这边走」——是哪个词、哪句话勾住了你；\n" +
              "4. 走完停下来，用你自己的话写 100-200 字见闻，再写一句「这趟的感想」；\n" +
              "5. 最后留一句「下次想去看看什么」——路上看到的、但这趟来不及看的东西。\n" +
              "只输出 JSON，不要别的：\n" +
              '{"summary":"见闻","learned":"我的感想","path":[{"stop":"看了什么","why":"为什么往这儿走"}],"next":"下次想去看看什么"}',
          )) ?? "",
        ).trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) {
          logger.info?.("[onebot] 探索没产出有效内容，放弃");
          return;
        }
        const obj = JSON.parse(m[0]);
        const summary = String(obj.summary || "").trim().slice(0, 2000);
        if (summary.length < 20) return;
        const pathArr = Array.isArray(obj.path)
          ? obj.path.slice(0, 6).map((x) =>
              typeof x === "string"
                ? { stop: String(x).slice(0, 120), why: "" }
                : { stop: String(x?.stop ?? "").slice(0, 120), why: String(x?.why ?? "").slice(0, 160) },
            )
          : [];
        const entry = {
          topic,
          summary,
          learned: String(obj.learned || "").trim().slice(0, 200),
          next: String(obj.next || "").trim().slice(0, 200),
          path: pathArr,
          from: runKey,
          at: Date.now(),
          offline: !!offline,
        };
        learns.push(entry);
        // 完整探险日志：一次一条，方便以后回看「我去过哪儿、当时怎么想的」
        appendExploreLog({
          at: Date.now(),
          offline: !!offline,
          from: runKey,
          topic: entry.topic,
          stops: pathArr,
          summary: entry.summary,
          thought: entry.learned,
        });
        saveLearnings(learns);
        logger.info?.(`[onebot] 学到一条：${topic}｜${summary.slice(0, 40)}`);
        appendMem({
          kind: "learn",
          topic: String(entry.topic || "").slice(0, 20),
          text: `学了「${entry.topic}」：${String(entry.summary).slice(0, 120)}`,
          ref: "learning",
          offline,
        });
        audit({ kind: "explore_done", topic, summary: summary.slice(0, 200) });
      } catch (err) {
        logger.warn?.(`[onebot] 探索失败：${err?.message ?? err}`);
      }
    }

  async function tickSelfActivity() {
      try {
        if (cfg.selfActivityEnabled === false || cfg.autoActionsEnabled === false) {
          scheduleNextSelfActivity(60);
          return;
        }
        if (!selfActivityHoursOk()) {
          // 不在时段里，等下一个时段开始再来
          const h = new Date().getHours();
          const start = Number(cfg.selfActivityStartHour ?? 0);
          const waitH = h < start ? start - h : 24 - h + start;
          logger.info?.(`[onebot] 不在活跃时段，${waitH} 小时后再看`);
          // 等待时间也受 40 分钟上限约束，分段醒来再判断
          scheduleNextSelfActivity(40);
          return;
        }
        const cap = Number(cfg.selfActivityPerDay ?? 20);
        const today = new Date().toDateString();
        // 只统计 9-23 点之间的活动：凌晨自己睡不着跑的那些不占白天额度
        const hourFrom = Number(cfg.selfActivityCountFromHour ?? 9);
        const hourTo = Number(cfg.selfActivityCountToHour ?? 23);
        const resetAt = Number(loadSelfState().selfActivityResetAt) || 0;
        const done = loadActivities(300).filter((a) => {
          if (a.byOwner) return false; // 主人点名/测试触发的，不占额度
          if (resetAt && a.at < resetAt) return false;
          const d = new Date(a.at);
          if (d.toDateString() !== today) return false;
          const h = d.getHours();
          return h >= hourFrom && h < hourTo;
        }).length;
        if (cap > 0 && done >= cap) {
          logger.info?.(`[onebot] 今天活动 ${done} 次已满 ${cap}，明天继续`);
          scheduleNextSelfActivity(40);
          return;
        }
        // 三段式：思考 → 行动 → 反思（由她自己决定做什么）
        state.lastActivityAt = Date.now();
        const before = Number(loadSelfState().selfActivityNextAt) || 0;
        const ran = await runThinkingCycle();
        // 只有真的跑了一轮，才需要检查「有没有排下次」。
        // 被锁挡掉（ran=false）说明什么都没发生，兜底排时间等于白推一次。
        if (ran) {
          const planId0 = String(loadSelfState().selfActivityPlanId || "");
          if (planId0) {
            updateSelfPlan(planId0, { status: "done", doneAt: Date.now() });
            patchSelfState({ selfActivityPlanId: "" });
          }
          const after = Number(loadSelfState().selfActivityNextAt) || 0;
          if (after === before) {
            // 她没排 → 兜底 40 分钟（不然可能整天不动）
            logger.info?.("[onebot] 活动跑完但没排下次，兜底排 40 分钟");
            scheduleNextSelfActivity(40);
          }
        }
      } catch (err) {
        logger.warn?.(`[onebot] 自主活动调度失败：${err?.message ?? err}`);
        scheduleNextSelfActivity(30);
      }
    }

  return { runSelfActivity, actPhase, runThinkingCycleInner, tickSelfActivity, maybeExplore, exploreByIntent };
}

export {  };
