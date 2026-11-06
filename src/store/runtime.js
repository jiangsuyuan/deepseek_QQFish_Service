// 运行时快照：健康、掉线、限频、记忆网络边。

export function createRuntimeStore(ctx) {
  const { AUDIT_PATH, EXPLORE_LOG, HEALTH_PATH, LEN_RING, LEN_RING_MAX, NET_MAX_LINKS, NET_PATH, OUTAGE_PATH, QZONE_PLAN, REMINDER_PATH, SELF_MODEL_PATH, WATCH_PATH, health, loadNet, logger, mkdirSync, readFileSync, state, writeFileSync } = ctx;
  function loadWatch() {
      if (state.watchCache) return state.watchCache;
      try {
        state.watchCache = JSON.parse(readFileSync(WATCH_PATH, "utf8")) || {};
      } catch {
        state.watchCache = {};
      }
      if (!Array.isArray(state.watchCache.topics)) state.watchCache.topics = [];
      if (!Array.isArray(state.watchCache.people)) state.watchCache.people = [];
      if (!Array.isArray(state.watchCache.notes)) state.watchCache.notes = [];
      return state.watchCache;
    }

  function saveWatch(w) {
      state.watchCache = w;
      try {
        mkdirSync(dirname(WATCH_PATH), { recursive: true });
        writeFileSync(WATCH_PATH, JSON.stringify(w, null, 1), "utf8");
      } catch (err) {
        logger.warn?.(`[onebot] 关注规则写盘失败：${err?.message ?? err}`);
      }
    }

  function watchHit(text, speakerId) {
      const w = loadWatch();
      const t = String(text || "");
      const hits = [];
      for (const k of w.topics) {
        if (k && t.includes(k)) hits.push("话题「" + k + "」");
      }
      for (const p of w.people) {
        if (p && String(speakerId) === String(p)) hits.push("关注的人 " + p);
      }
      return hits;
    }

  function loadReminders() {
      if (state.remindersLoaded) return;
      state.remindersLoaded = true;
      try {
        state.reminders = JSON.parse(readFileSync(REMINDER_PATH, "utf8"));
        if (!Array.isArray(state.reminders)) state.reminders = [];
      } catch {
        state.reminders = [];
      }
    }

  function saveReminders() {
      try {
        writeFileSync(REMINDER_PATH, JSON.stringify(state.reminders, null, 2), "utf8");
      } catch {
        // 忽略
      }
    }

  function loadLenRing() {
      if (state.lenRingLoaded) return;
      state.lenRingLoaded = true;
      try {
        const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean).slice(-600);
        for (const line of lines) {
          // 老路径写 kind:"reply"，现在她的发言基本都走工具、写 kind:"reply_to"
          if (!line.includes('"kind":"reply"') && !line.includes('"kind":"reply_to"')) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          const n = Number(r.len) || 0;
          if (n > 0 && n <= 150) LEN_RING.push(n);
        }
      } catch {
        // 读不到就从空开始，不影响回复
      }
      while (LEN_RING.length > LEN_RING_MAX) LEN_RING.shift();
    }

  function saveOutages() {
      try {
        if (state.outages.length > 200) state.outages = state.outages.slice(-200);
        writeFileSync(OUTAGE_PATH, JSON.stringify(state.outages));
      } catch {
        // 忽略
      }
    }

  function saveHealth() {
      try {
        writeFileSync(HEALTH_PATH, JSON.stringify(health), "utf8");
      } catch {
        // 忽略
      }
    }

  function loadSelfModel() {
      try {
        const d = JSON.parse(readFileSync(SELF_MODEL_PATH, "utf8"));
        return d && typeof d === "object" ? d : {};
      } catch {
        return {};
      }
    }

  function saveSelfModel(m) {
      try {
        writeFileSync(SELF_MODEL_PATH, JSON.stringify(m, null, 1));
      } catch {
        // 忽略
      }
    }

  function selfModelText() {
      const m = loadSelfModel();
      const bits = [];
      if (m.fact?.text) bits.push(`· 我是什么样的：${m.fact.text}`);
      if (m.inner?.text) bits.push(`· 我觉得我是什么样的：${m.inner.text}`);
      if (m.inner?.tensions?.length) bits.push(`· 我心里没摆平的事：${m.inner.tensions.join("；")}`);
      if (m.mirror?.text) bits.push(`· 在别人眼里我好像是：${m.mirror.text}`);
      return bits.length ? `[你对自己的认识]\n${bits.join("\n")}\n` : "";
    }

  function net() {
      if (!state.netCache) state.netCache = loadNet();
      return state.netCache;
    }

  function saveNetSoon() {
      state.netDirty = true;
      if (state.netTimer) return;
      state.netTimer = setTimeout(() => {
        state.netTimer = null;
        if (!state.netDirty) return;
        state.netDirty = false;
        try {
          writeFileSync(NET_PATH, JSON.stringify(state.netCache));
        } catch {
          // 忽略
        }
      }, 8000);
      state.netTimer.unref?.();
    }

  function netIndexAdd(kind, key, id) {
      const g = net();
      const idx = (g.index[kind] = g.index[kind] || {});
      const arr = (idx[key] = idx[key] || []);
      if (!arr.includes(id)) arr.push(id);
      if (arr.length > 400) idx[key] = arr.slice(-400);
    }

  function netLink(a, b, rel, w) {
      const g = net();
      const na = g.nodes[a];
      const nb = g.nodes[b];
      if (!na || !nb || a === b) return;
      const put = (from, to) => {
        const node = g.nodes[from];
        node.links = Array.isArray(node.links) ? node.links : [];
        const ex = node.links.find((l) => l.to === to);
        if (ex) {
          ex.w = Math.max(ex.w, w);
          return;
        }
        node.links.push({ to, rel, w });
        // 超过上限：丢掉权重最低的那条
        if (node.links.length > NET_MAX_LINKS) {
          node.links.sort((x, y) => y.w - x.w);
          node.links = node.links.slice(0, NET_MAX_LINKS);
        }
      };
      put(a, b);
      put(b, a);
      saveNetSoon();
    }

  function netAddNode(rec) {
      try {
        const g = net();
        const id = `m${rec.at}_${Math.random().toString(36).slice(2, 6)}`;
        const node = {
          id,
          at: rec.at,
          layer: rec.layer || "L4",
          kind: rec.kind || "misc",
          topic: Array.isArray(rec.topic) ? rec.topic.filter(Boolean).slice(0, 6) : [],
          who: Array.isArray(rec.who) ? rec.who.filter(Boolean).slice(0, 4) : [],
          mood: rec.mood || "",
          text: String(rec.text || "").slice(0, 3000),
          links: [],
          ref: rec.ref || "",
        };
        g.nodes[id] = node;

        // ── 横向边：同主题 / 同人 / 同期（24 小时内）──
        const recentIds = Object.keys(g.nodes).filter((k) => k !== id && rec.at - g.nodes[k].at < 7 * 86400_000);
        for (const k of recentIds.slice(-120)) {
          const other = g.nodes[k];
          if (!other) continue;
          const shareTopic = node.topic.some((t) => other.topic.includes(t));
          const shareWho = node.who.some((w) => other.who.includes(w));
          const near = Math.abs(rec.at - other.at) < 86400_000;
          if (shareTopic) netLink(id, k, "same-topic", 0.9);
          else if (shareWho) netLink(id, k, "same-person", 0.6);
          else if (near) netLink(id, k, "same-period", 0.35);
        }

        // ── 索引入口 ──
        netIndexAdd("time", new Date(rec.at).toISOString().slice(0, 10), id);
        netIndexAdd("kind", node.kind, id);
        netIndexAdd("layer", node.layer, id);
        for (const t of node.topic) netIndexAdd("topic", t, id);
        for (const w of node.who) netIndexAdd("person", w, id);
        if (node.mood) netIndexAdd("mood", node.mood, id);
        saveNetSoon();
        return id;
      } catch {
        return "";
      }
    }

  function appendExploreLog(rec) {
      try {
        writeFileSync(EXPLORE_LOG, JSON.stringify(rec) + "\n", { flag: "a" });
      } catch {
        // 忽略
      }
    }

  function loadQzonePlan() {
      try {
        const p = JSON.parse(readFileSync(QZONE_PLAN, "utf8"));
        return p && typeof p === "object" ? p : null;
      } catch {
        return null;
      }
    }

  function saveQzonePlan(p) {
      try {
        writeFileSync(QZONE_PLAN, JSON.stringify(p, null, 1));
      } catch (err) {
        logger.warn?.(`[onebot] 说说状态落盘失败：${err?.message ?? err}`);
      }
    }

  return { netAddNode, netLink, saveNetSoon, netIndexAdd, net, loadWatch, saveWatch, watchHit, loadSelfModel, saveSelfModel, selfModelText, loadQzonePlan, saveQzonePlan, saveReminders, loadReminders, saveOutages, saveHealth, loadLenRing, appendExploreLog };
}

export {  };
