// 创造者指令处理。

import { isSelf, isSelfAt } from "../util/self-ids.js";

export function createOwnerCommands(ctx) {
  const { audit, cfg, client, flushSeen, join, loadStickerLabels, logger, markSeen, openWindow, readdirSync, relayDone, sessions } = ctx;
  async function handlePoke(ev) {
      const target = String(ev.target_id ?? ev.target ?? "");
      if (target && !isSelf(cfg, target)) return; // 戳的不是我（新旧号都算我）
      const key = ev.group_id ? `group:${ev.group_id}` : `private:${ev.user_id}`;
      const nick = ev.sender?.nickname || ev.user_id;

      // 拉最近几条，看有没有在跟自己说话
      let talkingToMe = false;
      let hints = [];
      try {
        if (ev.group_id) {
          const hist = await client.call(
            "get_group_msg_history",
            { group_id: ev.group_id, count: 3 },
            6000,
          );
          const list = (hist?.messages ?? []).slice(-3);
          for (const m of list) {
            const segs = Array.isArray(m?.message) ? m.message : [];
            const hasAt = segs.some(
              (x) => x?.type === "at" && isSelfAt(cfg, x?.data?.qq),
            );
            const txt = segs
              .filter((x) => x?.type === "text")
              .map((x) => x?.data?.text ?? "")
              .join("");
            const byName = /(肥鱼|大鱼|竹筒|鱼鱼)/.test(txt);
            if (hasAt || byName) talkingToMe = true;
            if (txt.trim()) hints.push(`${m?.sender?.nickname ?? "某人"}：${txt.slice(0, 60)}`);
          }
        }
      } catch {
        // 拉不到历史就当作不是在叫我
        return;
      }

      if (!talkingToMe) {
        logger.info?.(`[onebot] 被 ${nick} 戳了一下，但前面没在跟我说话，不回`);
        audit({ kind: "poke_ignored", key, from: String(ev.user_id ?? "") });
        return;
      }

      logger.info?.(`[onebot] 被 ${nick} 戳了，前面确实在跟我说话，回一句`);
      audit({ kind: "poke_reply", key, from: String(ev.user_id ?? "") });
      const ent = sessions.entries.get(key);
      if (ent) ent.lastTarget = { ...ev, message_type: ev.group_id ? "group" : "private", group_id: ev.group_id, user_id: ev.user_id };
      void sessions
        .runProactive(
          key,
          "（对方戳了你一下" +
            (hints.length ? `，刚才在聊：「${hints.join(" / ")}」` : "") +
            "。想回就回一句，怎么回随你；不想回就当没看见。）",
        )
        .catch(() => {});
    }

  async function handleOwnerStickerCmd(ev, text) {
      if (!cfg.stickerEnabled || !cfg.stickerDir) return false;
      const t = String(text || "").trim();
      if (!t) return false;
      const filesNow = () => {
        try {
          return readdirSync(cfg.stickerDir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort();
        } catch {
          return [];
        }
      };

      if (/^(?:看看|查|列一下|列出|全部|所有)?\s*(?:我的|你的)?\s*(?:表情包?|表情)(?:列表|清单|库)?(?:都|全)?(?:有(?:哪些|什么|啥))?$/.test(t) && t.length <= 12) {
        try {
          const files = filesNow();
          if (!files.length) {
            await client.sendPrivate(ev.user_id, "库里还没有表情包。");
            return true;
          }
          const labels = loadStickerLabels(cfg.stickerDir);
          const lines = files.map(
            (f, i) =>
              `${i + 1}. ${f.replace(/\.[^.]+$/, "")}` +
              (labels[f]?.length ? `（${labels[f].join("/")}）` : ""),
          );
          const chunks = [];
          for (let i = 0; i < lines.length; i += 12) {
            chunks.push(
              `（${i + 1}-${Math.min(i + 12, lines.length)} / 共 ${lines.length} 张）\n` +
                lines.slice(i, i + 12).join("\n"),
            );
          }
          await client.sendPrivate(
            ev.user_id,
            `表情包共 ${files.length} 张（文件名编号有跳号，以这里的序号为准）。` +
              `看第几张发「看表情 序号」，按文件名看就发「看表情 m007」：\n${chunks[0]}`,
          );
          for (const c of chunks.slice(1)) await client.sendPrivate(ev.user_id, c);
          audit({ kind: "sticker_list", count: files.length });
          return true;
        } catch (e) {
          await client.sendPrivate(ev.user_id, `列表情包失败：${String(e?.message ?? e).slice(0, 80)}`);
          return true;
        }
      }

      const m = t.match(/^(?:看{1,2}表情|查看表情|表情图|表情)\s*[:：]?\s*(m?)(\d{1,4})\s*$/i) ||
        t.match(/^(?:看{1,2}|查看|打开|展示|来一张)\s*(?:第)?\s*(m?)(\d+)\s*(?:张|个|号)?\s*(?:表情|表情图|图|表情包)?\s*$/i);
      if (m) {
        try {
          const files = filesNow();
          const want = Number(m[2]);
          const byName = !!m[1];
          const name = byName
            ? files.find((f) => Number(/^m(\d+)\.[a-z]+$/i.exec(f)?.[1] ?? -1) === want)
            : files[want - 1];
          if (!name) {
            await client.sendPrivate(
              ev.user_id,
              `没有第 ${want} 张。发「表情包列表」看看序号范围（共 ${files.length} 张）。`,
            );
            return true;
          }
          const labels = loadStickerLabels(cfg.stickerDir);
          await client.sendImage(ev, join(cfg.stickerDir, name));
          await client.sendPrivate(
            ev.user_id,
            `${name}${labels[name]?.length ? "：" + labels[name].join("/") : ""}`,
          );
          audit({ kind: "sticker_view", name });
          return true;
        } catch (e) {
          await client.sendPrivate(ev.user_id, `发图失败：${String(e?.message ?? e).slice(0, 80)}`);
          return true;
        }
      }
      return false;
    }

  async function handleOwnerRelay(ev, text) {
      if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
      if (ev.message_type === "group") return false;
      const relayKey = String(ev.message_id ?? "");
      if (relayKey && relayDone.has(relayKey)) {
        logger.info?.(`[onebot] 定向搭话指令 ${relayKey} 已执行过，跳过`);
        return true;
      }
      const t = String(text || "").trim();
      // 识别「在群 X 和 Y 说句话」「去 X 群找 Y 聊两句」这类说法
      const looksLikeRelay = /(群|群聊)/.test(t) && /(说|聊|讲|问|找|@|艾特|和|跟)/.test(t);
      if (!looksLikeRelay) return false;

      let groupId = "";
      let targetQq = "";
      const g1 = t.match(/(?:群|群聊)\s*(\d{6,12})/);
      const g2 = t.match(/(\d{6,12})\s*(?:群|群聊)/);
      const g3 = t.match(/(?:在|去|到|进)\s*(\d{6,12})/);
      const gm = g1 ?? g2 ?? g3;
      if (gm) groupId = gm[1];

      const q1 = t.match(/(?:@|找|艾特|和|跟|对|与)\s*(\d{5,12})/);
      const q2 = t.match(/(\d{5,12})\s*(?:说|聊|讲|问)/);
      const qm = q1 ?? q2;
      if (qm) targetQq = qm[1];

      // 兜底：抓到两个数字就用（先群后人的常见顺序）
      if (!groupId || !targetQq) {
        const nums = [...t.matchAll(/\d{6,12}/g)].map((m) => m[1]);
        const uniq = [...new Set(nums)];
        if (uniq.length >= 2) {
          groupId = groupId || uniq[0];
          targetQq = targetQq || uniq[1];
        }
      }
      if (!groupId || !targetQq) return false;

      let rest = t
        .replace(groupId, " ")
        .replace(targetQq, " ")
        .replace(/^(?:在|去|到|进|让|你|她|请|帮我)\s*/, "")
        .replace(/(?:群聊?|里|中|的|找|艾特|@|和|跟|对|与)/g, " ")
        .replace(/^[:：,，\s]+/, "")
        .trim();
      const sayMatch = rest.match(/^说[:：]?\s*(.+)$/);
      const explicit = sayMatch ? sayMatch[1].trim() : "";

      if (relayKey) {
        relayDone.add(relayKey);
        if (relayDone.size > 200) {
          const first = relayDone.values().next().value;
          relayDone.delete(first);
        }
      }
      try {
        let content = explicit;
        if (!content) {
          // 不指定内容：让她按上下文自己开口
          content = await sessions.generate(
            `group:${groupId}`,
            `（内部指令：创造者让你去群里找 QQ ${targetQq} 主动搭一句话。` +
              `结合你对这个人的印象和群里最近的话题，说一句自然、简短、有来由的话，` +
              `不要@符号、不要称呼对方 QQ 号、不要解释你在执行任务，50 字以内。）`,
          );
        }
        content = String(content || "").trim().replace(/^@\S+\s*/, "");
        if (!content) {
          await client.sendPrivate(cfg.ownerId, "没生成出内容，换个说法再试？");
          return true;
        }
        await client.sendGroupAt(groupId, targetQq, content);
        if (cfg.followUpEnabled) {
          openWindow(`group:${groupId}`, targetQq);
          logger.info?.(`[onebot] 定向搭话后开窗口 group:${groupId} -> ${targetQq}`);
        }
        logger.info?.(`[onebot] 定向搭话：群 ${groupId} @ ${targetQq}：${content.slice(0, 40)}`);
        audit({ kind: "relay", groupId, targetQq, text: content.slice(0, 200) });
        // 关键：标记这条指令已处理，否则私聊补回复会反复重新执行它
        try {
          markSeen(
            `private:${cfg.ownerId}`,
            Number(ev.time) * 1000 || Date.now(),
            ev.message_id,
          );
          flushSeen();
        } catch {
          // 忽略
        }
        await client.sendPrivate(cfg.ownerId, `已让它在群 ${groupId} @ ${targetQq} 说：${content}`);
      } catch (err) {
        logger.warn?.(`[onebot] 定向搭话失败：${err?.message ?? err}`);
        await client.sendPrivate(cfg.ownerId, `搭话失败：${String(err?.message ?? err).slice(0, 150)}`);
      }
      return true;
    }

  return { handleOwnerRelay, handleOwnerStickerCmd, handlePoke };
}

export {  };
