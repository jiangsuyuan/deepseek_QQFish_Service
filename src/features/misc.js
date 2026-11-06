// 零散业务函数。

export function createMiscFeature(ctx) {
  const { HOME, audit, cfg, client, downloadImage, existsSync, join, logger, mkdirSync, people, readFileSync, runThinkingCycleInner, sessions, state, writeFileSync } = ctx;
  function crossGroupScope(gid, exec) {
      try {
        const sid = String(exec?.agent?.session?.id ?? "");
        const ent = sid ? sessions.bySessionId(sid) : null;
        const curKey = ent?.key ? String(ent.key) : "";
        if (!curKey || curKey === `group:${gid}`) return "";
        const curLabel = curKey.startsWith("group:") ? `群 ${curKey.slice(6)}` : `私聊 ${curKey.slice(8)}`;
        return ent?.proactiveTurn
          ? `（以上是群 ${gid} 的原文，不是当前会话。你现在在${curLabel}说话——别把那边的话题带过来。）`
          : `（以上是群 ${gid}，不是当前会话。）`;
      } catch {
        return "";
      }
    }

  function proactiveLocationNote(exec) {
      try {
        const sid = String(exec?.agent?.session?.id ?? "");
        const ent = sid ? sessions.bySessionId(sid) : null;
        if (!ent?.proactiveTurn || !ent?.key) return "";
        const k = String(ent.key);
        const label = k.startsWith("group:") ? `群 ${k.slice(6)}` : `私聊 ${k.slice(8)}`;
        return `（以上是别处的记录。你现在在${label}说话。）`;
      } catch {
        return "";
      }
    }

  async function judgeSwitchTalk(key, oldId, newId, newName, newText, lastReplyText) {
      try {
        let oldName = String(oldId);
        try {
          people.load();
          oldName = people.data[String(oldId)]?.name || oldName;
        } catch {
          // 忽略
        }
        const prompt =
          "（内部判断，不要发给任何人。只输出两行：A=是/否，B=是/否）\n" +
          `A：上一位「${oldName}」是不是已经不再跟你说话了（他最后那句不是冲你说的，或者他转去跟别人聊了）？\n` +
          (lastReplyText ? `你上一条对他的回复是：「${lastReplyText}」\n` : "") +
          `B：现在「${newName}」说「${newText}」。这句是不是**在接你刚才说的话**？\n` +
          "判断标准放宽一点：只要他这句是在回应你上一条（哪怕是接你的话题、顺着你的话往下说、"+ 
          "回答你的问题、或者对你说的事做评价），就算「是」。只有明显是在跟别人聊、跟你无关时才算「否」。\n" +
          "只输出：\nA=是/否\nB=是/否";
        const raw = String((await sessions.runSilent(key, prompt)) ?? "");
        const a = raw.match(/A\s*[=:：]\s*(是|否|yes|no)/i);
        const b = raw.match(/B\s*[=:：]\s*(是|否|yes|no)/i);
        if (!a || !b) return false;
        const yes = (m) => /^(是|yes)$/i.test(String(m?.[1] ?? ""));
        return yes(a) && yes(b);
      } catch {
        return false;
      }
    }

  async function imagePayloadFrom(src) {
      const url = typeof src === "string" ? src : String(src?.url || "");
      const file = typeof src === "string" ? "" : String(src?.file || "");
      if (!url && !file) return null;
      if (url) {
        const got = await downloadImage(url, cfg.maxImageBytes || 6000000);
        if (got) {
          got.srcUrl = url;
          got.srcFile = file;
          return got;
        }
      }
      try {
        const r = await client.call("get_image", { file: String(file || url) }, 12000);
        const p = String(r?.file ?? r?.path ?? r?.data?.file ?? "");
        if (p && existsSync(p)) {
          const buf = readFileSync(p);
          if (buf.length && buf.length <= (cfg.maxImageBytes || 6000000)) {
            logger.info?.("[onebot] 直连失败，改用 get_image 拿到本地图");
            return { data: buf, mediaType: "image/jpeg", srcUrl: url, srcFile: file };
          }
        }
      } catch {
        // 兜底也失败就算了
      }
      return null;
    }

  function autoConfigurePlugins(sid) {
      if (cfg.autoConfigurePlugins === false) return;
      const base = join(HOME, ".dsh");
      let changed = [];

      // fish-memory：开启该会话的记忆
      try {
        const fp = join(base, "fish-memory-config.json");
        const d = existsSync(fp) ? JSON.parse(readFileSync(fp, "utf8")) : {};
        d.sessions = d.sessions && typeof d.sessions === "object" ? d.sessions : {};
        if (!d.sessions[sid]) {
          d.sessions[sid] = true;
          writeFileSync(fp, JSON.stringify(d, null, 2), "utf8");
          changed.push("fish-memory");
        }
      } catch {
        // 插件没装就算了
      }

      // speak-up：把会话加进目标列表
      try {
        const sp = join(base, "speak-up-config.json");
        const d = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {};
        const list = Array.isArray(d["目标会话"]) ? d["目标会话"] : [];
        if (!list.includes(sid)) {
          list.push(sid);
          d["目标会话"] = list;
          writeFileSync(sp, JSON.stringify(d, null, 2), "utf8");
          changed.push("speak-up");
        }
      } catch {
        // 忽略
      }

      // feiyu-mood：只在还没设目标时设一次
      try {
        const mp = join(base, "feiyu-mood/config.json");
        const d = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
        if (!d.targetSession) {
          d.targetSession = sid;
          mkdirSync(join(base, "feiyu-mood"), { recursive: true });
          writeFileSync(mp, JSON.stringify(d, null, 2), "utf8");
          changed.push("feiyu-mood");
        }
      } catch {
        // 忽略
      }

      if (changed.length) {
        logger.info?.(`[onebot] 自动配置插件：${changed.join(",")} <- ${sid}`);
        audit({ kind: "plugin_autoconfig", sid, plugins: changed });
      }
    }

  async function runThinkingCycle(opts = {}) {
      if (cfg.autoActionsEnabled === false) return;
      if (state.activityRunning) {
        const busySec = Math.round((Date.now() - state.activityRunningSince) / 1000);
        logger.info?.(`[onebot] 已有一轮在进行（${busySec} 秒），这次跳过`);
        return false;
      }
      state.activityRunning = true;
      state.activityRunningSince = Date.now();
      try {
        await runThinkingCycleInner(opts);
        return true;
      } finally {
        state.activityRunning = false;
      }
    }

  return { judgeSwitchTalk, imagePayloadFrom, crossGroupScope, proactiveLocationNote, runThinkingCycle, autoConfigurePlugins };
}

export {  };
