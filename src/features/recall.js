// 回忆检索：跨会话搜历史原文。

export function createRecall(ctx) {
  const { cfg, humanizePunct, listSessionFiles, logger, readFileSync, textOfEvent, zstdDecompressSync } = ctx;
  async function recallSearch(currentSid, query, opts = {}) {
      // ═══════════════════════════════════════════════════════════
      // 结构化回忆：关键词 / 人 / 群 / 时间段，全都可以组合
      // ═══════════════════════════════════════════════════════════

      // ── 1. 关键词：拆词后 OR（模糊），不是 AND（精确） ──
      const RECALL_STOP = new Set([
        "有关", "关于", "跟", "和", "与", "的", "那个", "这个", "这件事", "那件事",
        "上次", "之前", "以前", "记得", "回忆", "想起来", "查一下", "查查",
        "说了", "说过", "是什么", "什么时候", "哪里", "吗", "呢", "啊", "吧",
        "你", "我", "他", "她", "它", "们", "有", "没", "是", "在", "了",
        "关于那个", "跟那个", "那个号", "上个月", "这个月", "今天", "昨天",
        "啥样", "什么样", "怎么样", "怎样", "如何", "干什么", "做什么",
      ]);
      const keys = String(query || "")
        .toLowerCase()
        .split(/[\s，,。！!？?、]+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2 && !RECALL_STOP.has(x))
        .slice(0, 6);

      // ── 2. 时间范围 ──
      function parseDay(str, isEnd) {
        const t = String(str || "").trim();
        if (!t) return null;
        const now = new Date();
        const ymd = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (isEnd) {
          // 包含当天
        }
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) { const p = t.split("-").map(Number); return new Date(p[0], p[1]-1, p[2]); }
        if (/^\d{1,2}-\d{1,2}$/.test(t)) { const p = t.split("-").map(Number); return new Date(now.getFullYear(), p[0]-1, p[1]); }
        if (/^今天$/.test(t)) return ymd(now);
        if (/^昨天$/.test(t)) { const d = ymd(now); d.setDate(d.getDate()-1); return d; }
        if (/^前天$/.test(t)) { const d = ymd(now); d.setDate(d.getDate()-2); return d; }
        if (/^上周$/.test(t)) { const d = ymd(now); d.setDate(d.getDate()-7); return d; }
        if (/^上个月$/.test(t)) { const d = ymd(now); d.setMonth(d.getMonth()-1); return d; }
        if (/^去年$/.test(t)) { const d = ymd(now); d.setFullYear(d.getFullYear()-1); return d; }
        if (/^(\d+)\s*天前?$/.test(t)) { const d = ymd(now); d.setDate(d.getDate()-Number(RegExp.$1)); return d; }
        return null;
      }
      let fromTs = 0, toTs = Number.MAX_SAFE_INTEGER;
      if (opts.days) {
        const d = new Date(); d.setDate(d.getDate() - Number(opts.days));
        fromTs = d.getTime();
      }
      if (opts.since) { const d = parseDay(opts.since, false); if (d) fromTs = d.getTime(); }
      if (opts.until) { const d = parseDay(opts.until, true); if (d) { d.setDate(d.getDate()+1); toTs = d.getTime(); } }

      // ── 3. 选会话文件 ──
      const all = listSessionFiles(opts.scope === "current" ? 40 : 200);
      let targets = [];
      if (opts.scope === "current" && currentSid) {
        const mine = all.find((x) => x.sid === String(currentSid));
        targets = mine ? [mine] : [];
      } else {
        targets = all;
      }
      if (!targets.length) return { ok: false, reason: "找不到会话文件" };

      // ── 4. 逐条匹配 ──
      const hits = [];
      for (const t of targets) {
        try {
          const raw = zstdDecompressSync(readFileSync(t.file)).toString("utf8");
          const rawLines = raw.split("\n");
          for (let lineNo = 0; lineNo < rawLines.length; lineNo++) {
            const line = rawLines[lineNo];
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            const ts = Number(ev.time) || Number(ev.ts) || 0;
            if (!ts || ts < fromTs || ts > toTs) continue;
            const got = textOfEvent(ev);
            if (!got || !got.text) continue;
            // 人过滤
            if (opts.person) {
              const p = String(opts.person).toLowerCase();
              const who = String(got.speaker || "").toLowerCase();
              const inText = String(got.text || "").toLowerCase().includes(p);
              if (!who.includes(p) && !inText) continue;
            }
            // 群过滤
            if (opts.group) {
              const g = String(opts.group);
              if (!String(t.sid).includes(g) && !String(got.text).includes(g)) continue;
            }
            // 只搜对方
            if (opts.onlyUser && got.role !== "对方") continue;
            // 关键词 OR（模糊）
            if (keys.length) {
              const low = got.text.toLowerCase();
              const matched = keys.filter((k) => low.includes(k));
              if (!matched.length) continue;
              hits.push({
                sid: t.sid, role: got.role, speaker: got.speaker || "",
                text: got.text.slice(0, 200), at: ts,
                score: matched.length, lineNo,
              });
            } else {
              hits.push({
                sid: t.sid, role: got.role, speaker: got.speaker || "",
                text: got.text.slice(0, 200), at: ts, score: 0, lineNo,
              });
            }
          }
        } catch (err) {
          logger.warn?.("[onebot] 读会话失败 " + t.sid + "：" + (err?.message ?? err));
        }
      }

      // ── 5. 排序 + 等距取样 ──
      // 有关键词时：先按命中词数（相关度）再按时间
      if (keys.length) hits.sort((a, b) => (b.score - a.score) || (a.at - b.at));
      else hits.sort((a, b) => a.at - b.at);

      const maxHits = Number(opts.limit) || Number(cfg.recallMaxHits) || 20;
      let picked = hits;
      if (hits.length > maxHits) {
        // 有时间过滤时不需要覆盖全跨度，直接取最相关 / 最近
        if (fromTs > 0 || toTs < Number.MAX_SAFE_INTEGER) {
          picked = hits.slice(0, maxHits);
        } else {
          picked = [];
          const step = (hits.length - 1) / (maxHits - 1);
          for (let i = 0; i < maxHits; i++) picked.push(hits[Math.round(i * step)]);
          const seen = new Set();
          picked = picked.filter((h) => {
            const k = h.sid + "|" + h.at + "|" + h.text.slice(0, 20);
            if (seen.has(k)) return false;
            seen.add(k); return true;
          });
        }
      }
      picked.sort((a, b) => a.at - b.at);

      // ── 6. 上下文：每条命中带前后各 N 条 ──
      const ctxN = Math.max(0, Math.min(10, Number(opts.context) || 0));
      if (ctxN > 0 && picked.length) {
        const bySid = {};
        for (const h of picked) (bySid[h.sid] = bySid[h.sid] || []).push(h);
        for (const sid of Object.keys(bySid)) {
          const file = targets.find((x) => x.sid === sid);
          if (!file) continue;
          let rawLines;
          try {
            rawLines = zstdDecompressSync(readFileSync(file.file)).toString("utf8").split("\n");
          } catch { continue; }
          for (const h of bySid[sid]) {
            const before = [], after = [];
            for (let k = Math.max(0, h.lineNo - ctxN); k < h.lineNo; k++) {
              try {
                const e = JSON.parse(rawLines[k]);
                const g = textOfEvent(e);
                if (g && g.text) before.push(g.text.slice(0, 120));
              } catch {}
            }
            for (let k = h.lineNo + 1; k <= Math.min(rawLines.length - 1, h.lineNo + ctxN); k++) {
              try {
                const e = JSON.parse(rawLines[k]);
                const g = textOfEvent(e);
                if (g && g.text) after.push(g.text.slice(0, 120));
              } catch {}
            }
            h.context = { before, after };
          }
        }
      }

      const cond = [];
      if (keys.length) cond.push("词=" + keys.join("/"));
      if (opts.person) cond.push("人=" + opts.person);
      if (opts.group) cond.push("群=" + opts.group);
      if (fromTs) cond.push("从=" + new Date(fromTs).toLocaleDateString("zh-CN"));
      if (toTs < Number.MAX_SAFE_INTEGER) cond.push("到=" + new Date(toTs).toLocaleDateString("zh-CN"));
      logger.info?.(
        "[onebot] recall 查询：" + (cond.length ? cond.join(" ") : "(无条件)") +
        " 命中=" + hits.length + " 返回=" + picked.length,
      );

      return {
        ok: true,
        total: hits.length,
        returned: picked.length,
        conditions: cond,
        hits: picked.map((h) => {
          const o = {
            at: h.at,
            date: new Date(h.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
            speaker: h.speaker,
            role: h.role,
            text: h.text,
          };
          if (h.context) o.context = h.context;
          return o;
        }),
      };
    }

  function readMessagesFromFile(file, limit) {
      try {
        const raw = zstdDecompressSync(readFileSync(file)).toString("utf8");
        const out = [];
        // 活动是 runSilent 跑的：它的 prompt 有固定特征，紧跟其后的回复是活动产出，不是对话
        let afterActivityPrompt = false;
        let lastSource = "qq"; // qq / webui / group
        for (const line of raw.split("\n")) {
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }

          // 先看这条 user/message 是不是活动 prompt
          if (ev.type === "user/message") {
            const rawText = (ev.data?.content ?? [])
              .filter((b) => b?.type === "text")
              .map((b) => b.text ?? "")
              .join("")
              .trim();
            if (
              /（这是你自己的时间|（内部|（你的时间|（现在研究代码|（内部探索|（内部回顾|（内部反思|（内部整理|（内部思考|（这是给你的|（下面的这些是/.test(
                rawText,
              )
            ) {
              afterActivityPrompt = true;
              continue; // 活动 prompt 本身也不进历史
            }
            afterActivityPrompt = false;
            // 只有带渠道标签的「真实消息」才更新来源；
            // DSH 注入的运行时说明（Time sampled 等）不含标签，不能让它把标记冲掉
            if (rawText.includes("[网页聊天]")) lastSource = "webui";
            else if (rawText.includes("[QQ群消息]")) lastSource = "group";
            else if (rawText.includes("[QQ私聊]")) lastSource = "qq";
          }
          // 活动 prompt 之后的回复：是活动产出，跳过
          if (afterActivityPrompt && ev.type === "assistant/message") {
            continue;
          }

          const got = textOfEvent(ev);
          if (!got.text || got.text.length < 2) continue;
          // 活动产出（思考计划的 JSON、反思草稿）不算对话
          const tx = got.text.trim();
          // 兜底：明显是 prompt 模板的整条丢掉
          if (/（QQ 聊天[:：]|像真人发消息|长度要有变化|点了智慧会发|不要复述我的问题/.test(tx)) continue;
          // 自主活动的产出（凌晨那波还没隔离会话时混进来的反思/见闻）不算对话
          if (/^(做到了|没做到|算做到|半做到|验了|核了|又空一栏|探险记录反而是|串起来是一条|翻出来了|想明白了)/.test(tx))
            continue;
          if (/^\{\s*"(summary|looked|core)"/.test(tx)) continue;
          if (/^(这条比记性差|这一层比|差别在于我原先)/.test(tx)) continue;
          if (/^\{.*"looked"/.test(tx)) continue;
          if (/^\[\[?(next|game|book)\s*[:：]/.test(tx)) continue;
          if (tx.startsWith("（内部") || tx.startsWith("（这是你自己")) continue;
          // 统一成毫秒时间戳，否则和图片记录排在一起会错位
          let ts = Number(ev.time) || Number(ev.ts) || 0;
          if (ts > 0 && ts < 1e12) ts *= 1000; // 秒 -> 毫秒
          // 她的输出里可能带 [split]（她自己要求分两条发的记号），读历史时也要拆
          const bits = tx
            .split(/\[split\]/i)
            .map((x) => x.trim())
            .filter(Boolean);
          if (bits.length > 1) {
            for (let k = 0; k < bits.length; k++) {
              const piece = got.role === "对方" ? bits[k] : humanizePunct(bits[k]);
              out.push({
                role: got.role === "对方" ? "me" : "her",
                text: piece.slice(0, 500),
                at: (ts || 0) + k,
                source: got.role === "对方" ? lastSource : lastSource || "qq",
              });
            }
          } else {
            out.push({
              role: got.role === "对方" ? "me" : "her",
              text: bits[0] ? bits[0].slice(0, 500) : tx.slice(0, 500),
              at: ts || 0,
            });
          }
        }
        return out.slice(-limit);
      } catch {
        return [];
      }
    }

  function sessionHistory(sid, limit = 60) {
      try {
        const files = listSessionFiles(60);
        logger.info?.(`[onebot] WebUI 历史：sid=${sid || "(空)"} 找到 ${files.length} 个会话文件`);
        // 1. 指定了 sessionId 就先找它
        if (sid) {
          const t = files.find((x) => x.sid === String(sid));
          if (t) {
            const got = readMessagesFromFile(t.file, limit);
            if (got.length) return got;
          }
        }
        // 2. 兜底：最近修改的几个会话里，挑「对方发言最多」的那个（私聊最像）
        let best = [];
        for (const t of files.slice(0, 8)) {
          const got = readMessagesFromFile(t.file, limit);
          const theirs = got.filter((m) => m.role === "me").length;
          logger.info?.(`[onebot] WebUI 历史：${t.sid} 读出 ${got.length} 条（对方 ${theirs} 条）`);
          if (theirs >= 2 && got.length > best.length) best = got;
        }
        return best;
      } catch {
        return [];
      }
    }

  return { recallSearch, sessionHistory, readMessagesFromFile };
}

export {  };
