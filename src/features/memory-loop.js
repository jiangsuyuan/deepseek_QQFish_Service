// 记忆沉淀：印象、蒸馏、记忆网络。

import { unreadInbox } from "./assistant-channel.js";
import { activeCommission } from "./commission.js";

export function createMemoryLoop(ctx) {
  const { MEMLOG_PATH, NET_DECAY, NET_MAX_DEPTH, NET_MAX_LINKS, NET_MIN_W, NET_VISIT_CAP, SELF_ACTIVITY_KEY, audit, cfg, loadActivities, loadCore, loadDigests, loadMemLog, logger, memSeen, memoryLayersIndex, net, netAddNode, recentDigestText, saveCore, saveDigests, selfModelText, sessions, writeFileSync } = ctx;
  async function maybeMakeDigest() {
      try {
        const digests = loadDigests();
        const since = digests.length ? digests[digests.length - 1].to : 0;
        const pending = loadMemLog(400).filter((m) => m.at > since);
        if (pending.length < (Number(cfg.digestEvery) || 20)) return;
        const text = pending
          .slice(-30)
          .map((m) => `[${m.kind}] ${m.topic ? `(${m.topic}) ` : ""}${String(m.text || "").slice(0, 800)}`)
          .join("\n");
        const runKey = SELF_ACTIVITY_KEY;
        const out = String(
          (await sessions.runSilent(
            runKey,
            "（内部整理，不要发消息。这是你自己留下的印象。）\n" +
              "下面是你最近做的事、学到的东西、聊的要点：\n" +
              text +
              "\n\n把它们压成一段 150-200 字的「这几天我经历了什么」：\n" +
              "· 用第一人称，像自己回想\n" +
              "· **保留具体的人名、书名、术语**（这些是记忆的钩子）\n" +
              "· 不要罗列，要串成一条线\n" +
              "只输出这一段话。",
          )) ?? "",
        ).trim();
        if (out.length < 20) return;
        digests.push({
          from: pending[0].at,
          to: pending[pending.length - 1].at,
          text: out.slice(0, 2000),
          count: pending.length,
        });
        saveDigests(digests);
        audit({ kind: "digest", count: pending.length, len: out.length });
        logger.info?.(`[onebot] 印象 +1（${pending.length} 条）：${out.slice(0, 40)}`);
      } catch (err) {
        logger.warn?.(`[onebot] 印象生成失败：${err?.message ?? err}`);
      }
    }

  function netWalk(entries, opts = {}) {
      try {
        const g = net();
        // 深度和起始权重都随机——想起来有时很近、有时很远，不该每次都用尽全力
        const depthLimit = Math.min(
          Number(opts.depth) || 3 + Math.floor(Math.random() * 8), // 3-10 跳
          NET_MAX_DEPTH,
        );
        const startW = Number(opts.startW) || 0.55 + Math.random() * 0.45; // 0.55-1.0
        const cap = Number(opts.maxNodes) || NET_VISIT_CAP;
        const starts = [];
        // 入口数也随机 2-6
        const entryCap = Math.max(2, Math.min(6, Number(opts.entries) || 2 + Math.floor(Math.random() * 5)));
        for (const e of entries.slice(0, entryCap)) {
          const [kind, ...rest] = String(e).split(":");
          const key = rest.join(":");
          const bucket = g.index?.[kind]?.[key];
          if (Array.isArray(bucket)) {
            // 每个入口只挑最重的几条，且起始权重带抖动
            for (const id of bucket.slice(-12)) {
              starts.push({ id, w: startW * (0.85 + Math.random() * 0.3), depth: 0 });
            }
          }
        }
        if (!starts.length) return [];

        const best = new Map(); // id -> {w, depth, via}
        let frontier = starts;
        for (let depth = 0; depth <= depthLimit; depth++) {
          const next = [];
          for (const cur of frontier) {
            const node = g.nodes[cur.id];
            if (!node) continue;
            const prev = best.get(cur.id);
            if (prev && prev.w >= cur.w) continue;
            best.set(cur.id, { w: cur.w, depth, via: cur.via || "" });
            if (best.size > cap) break;
            if (depth === depthLimit) continue;
            for (const l of (node.links || []).slice(0, NET_MAX_LINKS)) {
              const w = cur.w * NET_DECAY * (l.w ?? 0.3);
              if (w < NET_MIN_W) continue;
              next.push({ id: l.to, w, depth: depth + 1, via: l.rel });
            }
          }
          if (!next.length || best.size > cap) break;
          // 每层只保留权重最高的若干条，防止爆炸
          next.sort((a, b) => b.w - a.w);
          frontier = next.slice(0, 40);
        }

        const out = [...best.entries()]
          .map(([id, v]) => ({ ...v, node: g.nodes[id] }))
          .filter((x) => x.node)
          .sort((a, b) => b.w - a.w)
          .slice(0, Number(opts.top) || 8);
        return out;
      } catch {
        return [];
      }
    }

  function appendMem(rec) {
      try {
        const key = `${rec.kind}|${rec.text || ""}`.slice(0, 180);
        if (rec.text && memSeen.has(key)) return; // 同一件事不重复记
        if (rec.text) memSeen.add(key);
        if (memSeen.size > 500) memSeen.clear();
        writeFileSync(MEMLOG_PATH, JSON.stringify({ at: Date.now(), ...rec }) + "\n", { flag: "a" });
        // 同时进网络：建节点 + 自动连横向边
        try {
          netAddNode({
            at: rec.at || Date.now(),
            kind: rec.kind,
            topic: rec.topic ? String(rec.topic).split(/[\s,、，]+/).filter(Boolean) : [],
            who: rec.who ? [String(rec.who)] : [],
            mood: rec.mood || "",
            text: rec.text,
            ref: rec.ref,
            layer: rec.layer || "L4",
          });
        } catch {
          // 忽略
        }
      } catch {
        // 忽略
      }
    }

  async function thinkPhase(forceAction = null, planNote = "") {
      const runKey = SELF_ACTIVITY_KEY;
      const sm = selfModelText();
      const core = loadCore().slice(-12);
      const coreLine = core.length
        ? core.map((c) => `· [${c.type || "belief"}] ${c.text}`).join("\n")
        : "（还没有）";
      const digest = recentDigestText(3) || "（还没有）";
      // 连续三次同一类活动 → 提一句，让她自己决定要不要换（不强制）
      let sameKindNote = "";
      try {
        const recent = (loadActivities(8) || []).slice(-3);
        const kinds = recent.map((a) => String(a.kind || ""));
        if (kinds.length === 3 && kinds.every((k) => k && k === kinds[0])) {
          const label = { read: "读书", explore: "探索", think: "思考", play: "玩", write: "写东西", recall: "回忆", dream: "憧憬", study: "研究", watch_groups: "看群" }[kinds[0]] || kinds[0];
          sameKindNote = `（你最近连着 3 次都在「${label}」。要不要换点别的？接着做也行，你定。）\n`;
        }
      } catch {
        sameKindNote = "";
      }
      // 创造者的临时嘱托：只在活动之前给她看
      let commissionNote = "";
      try {
        const c = activeCommission();
        if (c) {
          const when = c.at ? new Date(c.at).toLocaleString("zh-CN", { hour12: false }).slice(5, 16) : "";
          const leftH = c.expiresAt ? Math.max(1, Math.round((c.expiresAt - Date.now()) / 3600000)) : 0;
          commissionNote =
            `[创造者的嘱托${when ? `（${when} 说的）` : ""}]\n${c.text}\n` +
            (leftH ? `（这条嘱托还有 ${leftH} 小时有效，不是长期任务。）\n` : "") +
            "\n";
        }
      } catch {
        commissionNote = "";
      }
      // 创造者通过助手通道留的话：优先看
      let ownerNote = "";
      try {
        const un = unreadInbox();
        if (un.length) {
          ownerNote = "[创造者给你留了话]\n" + un.map((m) => `· ${m.from}：${String(m.text || "").slice(0, 300)}`).join("\n")
            + "\n（这些还没处理。想回就用 assistant_channel 的 reply，处理完可以顺手 check 一下确认。）\n\n";
        }
      } catch {
        ownerNote = "";
      }
      const prompt =
        commissionNote +
        ownerNote +
        "（这是你自己的时间。先想清楚，再决定做什么。这一轮**只思考，不动手**。）\n\n" +
        "[你能看到的东西]\n" +
        memoryLayersIndex() +
        "\n\n[L0 自我认知]\n" +
        (sm || "（还没有）\n") +
        "\n[L3 核心自我]\n" +
        coreLine +
        "\n\n[L2 最近几天]\n" +
        digest +
        "\n\n" +
        "你可以先查任意一层再决定——工具：my_memory（分类查）/ my_digest（近期印象）/ " +
        "memory_index（记忆目录）/ my_adventures（走过的路）/ my_wants（想要的东西）/ " +
        "recall（久远对话）。想看就查，不想看就直接想。\n\n" +
        "现在问自己：**这会儿我想做什么？为什么？**\n" +
        "今天这段是你自己的时间，不是交作业。挑一件你**想做**的，\n" +
        "不是为了「有用」，也不是为了「显得勤奋」。\n" +
        "做完了要是觉得没意思，下次换别的；要是做着做着觉得好玩，那就多玩一会儿。\n" +
        (planNote ? `（你自己排的：${String(planNote).slice(0, 200)}）\n` : "") +
        sameKindNote +
        (forceAction
          ? `（这次外面指定了要做：${forceAction}。你想想具体想做什么，action 就填 ${forceAction}。）\n`
          : "可选：探险（出门看看）/ 读书 / 玩（造个小游戏）/ 思考（想事）/ 写点什么 / 回忆 / 憧憬未来 / **看看群**（去群里看看大家在聊什么，想插话就插）\n") +
        "\n" +
        '只输出 JSON：{"looked":[看过哪几层],"intent":"我想做什么（一句话）","action":"explore|read|play|think|write|recall|dream|watch_groups","why":"为什么","mood":"现在什么心情"}';
      logger.info?.("[onebot] 阶段1 思考");
      const raw = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]);
      const action = String(obj.action || "think").toLowerCase();
      return {
        looked: Array.isArray(obj.looked) ? obj.looked : [],
        intent: String(obj.intent || "").slice(0, 150),
        action: ["explore", "read", "play", "think", "write", "recall", "dream", "study", "watch_groups"].includes(action)
          ? action
          : "think",
        why: String(obj.why || "").slice(0, 200),
        mood: String(obj.mood || "").slice(0, 30),
        at: Date.now(),
      };
    }

  async function reflectPhase(plan, actOut) {
      const runKey = SELF_ACTIVITY_KEY;
      const prompt =
        "（内部回看，不要发消息。你刚做完一件事。）\n\n" +
        `原本想做的：${plan.intent}\n` +
        `为什么：${plan.why}\n` +
        `实际做了：${String(actOut || "").slice(0, 2000)}\n\n` +
        "回头看这几个问题，用两三句话说清（不用全答，挑有话说）：\n" +
        "1. 做到了吗？和想的有差别吗？\n" +
        "2. 这件事让你对自己或对什么有了新的看法吗？\n" +
        "3. 下次还会做吗？或者下次想做什么？\n" +
        "4. 做的过程里，有没有哪一刻你觉得「这个有意思」或者「这个烦」？\n" +
        "   有就说，没有就跳过。这一问不用找自己的毛病。\n" +
        "5. 要是想把它做得更好，缺什么就写什么；不缺就别硬提。\n" +
        "   确实缺东西，用 note_want 记下来（kind 填 feature 或 other）。\n" +
        "6. **这件事你自己喜欢吗？做完心里是什么感觉？**\n" +
        "   不用说得体面，说真的。不喜欢就说不喜欢，觉得没意思就说没意思。\n" +
        "   如果你发现自己其实挺高兴的，也直接写出来——高兴不是缺点，不用绕开。\n\n" +
        "如果你对自己有了新认识，可以调 remember_self 记下来。\n\n" +
        "最后单独一行，定一下**下次什么时候再开始做事**（也就是这次休息多久）：\n" +
        "格式 [[next: 20m]] / [[next: 2h]] / [[next: 明天早上]]\n" +
        "凭感觉写：刚做完满足的事可以隔久一点，没想完的可以早点再来。\n" +
        "只输出回看本身（最后一行的标记会保留）。";
      logger.info?.("[onebot] 阶段3 回看");
      try {
        const raw = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
        let delayMin = 0;
        const m = raw.match(/\[\[?\s*next\s*[:：]\s*([^\]\n]{1,30})\]\]?/i);
        if (m) {
          const t = String(m[1]).toLowerCase().trim();
          const num = parseFloat(t);
          if (/h|小时|钟头/.test(t) && !Number.isNaN(num)) delayMin = num * 60;
          else if (/m|分/.test(t) && !Number.isNaN(num)) delayMin = num;
          else if (/明天|明早/.test(t)) delayMin = 8 * 60;
          else if (/下午|晚上/.test(t)) delayMin = 4 * 60;
          else if (!Number.isNaN(num) && !/^\d{4}\s*[-/.年]/.test(t)) delayMin = num; // 带年份日期不硬猜
        }
        const text = raw
          .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
          .trim()
          .slice(0, 500);
        return { text, delayMin };
      } catch {
        return { text: "", delayMin: 0 };
      }
    }

  async function distillCore() {
      // 4.0：不再自动写人格。沉淀由她自己用 sediment 决定，这里不代劳。
      logger?.debug?.("[onebot] 沉淀由她自己决定（sediment），自动写入已停用");
      return;
  }

  return { distillCore, maybeMakeDigest, netWalk, appendMem, reflectPhase, thinkPhase };
}

export {  };
