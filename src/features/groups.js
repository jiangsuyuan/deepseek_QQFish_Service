import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// 群画像与巡查：群名缓存、群记录、活动/巡逻摘要。

export function createGroups(ctx) {
  const { GROUP_META_DIR, GROUP_META_PATH, client, groupMetaSaved, state } = ctx;
  function groupActivityList(hours) {
      const meta = loadGroupMeta() || {};
      const now = Date.now();
      const win = Math.max(1, Number(hours) || 24) * 3600_000;
      const out = [];
      for (const gid of Object.keys(meta)) {
        const m = meta[gid] || {};
        const recent = Array.isArray(m.recent) ? m.recent : [];
        const inWin = recent.filter((r) => (Number(r?.t) || 0) > now - win);
        out.push({
          group: gid,
          purpose: String(m?.profile?.purpose ?? "").slice(0, 30),
          lastAt: Number(m.lastMessageAt || m.at || 0),
          count: inWin.length,
          top: (Array.isArray(m.top) ? m.top : []).slice(0, 5),
          sample: inWin.slice(-2).map((r) => String(r?.l ?? "").slice(0, 60)).filter(Boolean),
        });
      }
      out.sort((a, b) => b.lastAt - a.lastAt);
      return out;
    }

  function groupPatrolList(gid, hours) {
      const meta = loadGroupMeta() || {};
      const m = meta[String(gid)];
      if (!m) return null;
      const now = Date.now();
      const win = Math.max(1, Number(hours) || 2) * 3600_000;
      const recent = Array.isArray(m.recent) ? m.recent : [];
      const lines = recent
        .filter((r) => (Number(r?.t) || 0) > now - win)
        .map((r) => String(r?.l ?? ""))
        .filter(Boolean);
      return {
        group: String(gid),
        purpose: String(m?.profile?.purpose ?? ""),
        total: lines.length,
        lines: lines.slice(-40),
      };
    }

  async function ensureGroupNames() {
      if (state.groupNames.size && Date.now() - state.groupNamesAt < 10 * 60000) return;
      try {
        const list = await client.call("get_group_list", {}, 8000);
        const arr = Array.isArray(list) ? list : (list?.data ?? []);
        for (const g of arr) {
          const gid = String(g.group_id ?? "");
          if (gid) state.groupNames.set(gid, String(g.group_name ?? ""));
        }
        state.groupNamesAt = Date.now();
      } catch {
        // 拿不到就用群号
      }
    }

  const groupLabel = (gid) => {
      const nm = state.groupNames.get(String(gid));
      return nm ? `${nm}(${gid})` : String(gid);
    };

  function saveGroupMeta() {
      try {
        mkdirSync(GROUP_META_DIR, { recursive: true });
        const seen = new Set();
        for (const [gid, rec] of Object.entries(loadGroupMeta())) {
          if (!/^\d{5,20}$/.test(gid)) continue;
          seen.add(gid);
          const json = JSON.stringify(rec);
          if (groupMetaSaved[gid] === json) continue;
          writeFileSync(join(GROUP_META_DIR, gid + ".json"), json);
          groupMetaSaved[gid] = json;
        }
        for (const gid of Object.keys(groupMetaSaved)) {
          if (!seen.has(gid)) {
            try {
              unlinkSync(join(GROUP_META_DIR, gid + ".json"));
            } catch {
              // 忽略
            }
            delete groupMetaSaved[gid];
          }
        }
      } catch {
        // 写失败不影响对话
      }
    }

  function loadGroupMeta() {
      if (state.groupMetaCache) return state.groupMetaCache;
      state.groupMetaCache = {};
      try {
        mkdirSync(GROUP_META_DIR, { recursive: true });
        const files = readdirSync(GROUP_META_DIR).filter((f) => f.endsWith(".json"));
        if (files.length) {
          for (const f of files) {
            try {
              const rec = JSON.parse(readFileSync(join(GROUP_META_DIR, f), "utf8"));
              const gid = f.replace(/\.json$/, "");
              if (rec && typeof rec === "object") state.groupMetaCache[gid] = rec;
            } catch {
              // 单群文件坏了跳过
            }
          }
        } else {
          // 迁移：老的 group-meta.json → 一群一个文件
          state.groupMetaCache = JSON.parse(readFileSync(GROUP_META_PATH, "utf8")) ?? {};
          saveGroupMeta();
        }
      } catch {
        state.groupMetaCache = {};
      }
      return state.groupMetaCache;
    }

  function groupMetaTouch(key, patch) {
      if (!String(key).startsWith("group:")) return;
      const meta = loadGroupMeta();
      const gid = String(key).slice(6);
      meta[gid] = { ...(meta[gid] ?? {}), ...patch, at: Date.now() };
      if (state.groupMetaTimer) return;
      state.groupMetaTimer = setTimeout(() => {
        state.groupMetaTimer = null;
        saveGroupMeta();
      }, 5000);
      state.groupMetaTimer.unref?.();
    }

  return { loadGroupMeta, saveGroupMeta, groupMetaTouch, groupLabel, groupActivityList, groupPatrolList, ensureGroupNames };
}

export {  };
