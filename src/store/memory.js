// 记忆与统计文件：读写各类 jsonl/json 小文件。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

export function createMemoryStore(app = {}) {
  const {} = app;
  const SELF_STATE_PATH = join(HOME, ".dsh/onebot-bridge/self-state.json");

  function loadSelfState() {
      try {
        return JSON.parse(readFileSync(SELF_STATE_PATH, "utf8")) || {};
      } catch {
        return {};
      }
    }

  function patchSelfState(patch) {
      try {
        const cur = loadSelfState();
        Object.assign(cur, patch);
        writeFileSync(SELF_STATE_PATH, JSON.stringify(cur));
      } catch {
        // 忽略
      }
    }

  const WANTS_PATH = join(HOME, ".dsh/onebot-bridge/wants.json");

  function loadWants() {
      try {
        const d = JSON.parse(readFileSync(WANTS_PATH, "utf8"));
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    }

  function saveWants(arr) {
      try {
        writeFileSync(WANTS_PATH, JSON.stringify(arr.slice(-100), null, 1));
      } catch {
        // 忽略
      }
    }

  const LEARN_PATH = join(HOME, ".dsh/onebot-bridge/learnings.json");

  const DIGEST_PATH = join(HOME, ".dsh/onebot-bridge/digest.json");

  function loadDigests() {
      try {
        const d = JSON.parse(readFileSync(DIGEST_PATH, "utf8"));
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    }

  function saveDigests(arr) {
      try {
        writeFileSync(DIGEST_PATH, JSON.stringify(arr.slice(-40), null, 1));
      } catch {
        // 忽略
      }
    }

  function relevantMemories(text, n = 4) {
      try {
        const t = String(text || "");
        if (t.length < 3) return "";
        // 取 2-4 字的中文片段当关键词
        const words = new Set();
        const zh = t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
        for (let i = 0; i + 2 <= Math.min(zh.length, 40); i++) {
          for (let len = 2; len <= 4; len++) {
            const w = zh.slice(i, i + len);
            if (w.length === len) words.add(w);
          }
        }
        const STOP = new Set(["什么", "怎么", "这个", "那个", "就是", "没有", "可以", "不是", "现在", "还是"]);
        const mems = loadMemLog(300);
        const scored = [];
        for (const m of mems) {
          const hay = `${m.topic || ""} ${m.text || ""}`;
          let score = 0;
          for (const w of words) {
            if (STOP.has(w)) continue;
            if (hay.includes(w)) score += w.length >= 3 ? 2 : 1;
          }
          if (score > 0) scored.push({ m, score });
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, n);
        if (!top.length) return "";
        const lines = top.map(
          (x) => `· [${x.m.kind}] ${String(x.m.text || "").slice(0, 70)}`,
        );
        return `[你想起的一些事]\n${lines.join("\n")}\n`;
      } catch {
        return "";
      }
    }

  function recentDigestText(days = 3) {
      try {
        const ds = loadDigests();
        if (!ds.length) return "";
        const cutoff = Date.now() - days * 86400_000;
        const recent = ds.filter((d) => d.to >= cutoff).slice(-4);
        if (!recent.length) return "";
        return recent.map((d) => `· ${d.text}`).join("\n");
      } catch {
        return "";
      }
    }

  const NET_PATH = join(HOME, ".dsh/onebot-bridge/memory-net.json");

  const NET_MAX_LINKS = 5;

  function loadNet() {
      try {
        const d = JSON.parse(readFileSync(NET_PATH, "utf8"));
        return d && typeof d === "object" ? d : { nodes: {}, index: {} };
      } catch {
        return { nodes: {}, index: {} };
      }
    }

  const MEMLOG_PATH = join(HOME, ".dsh/onebot-bridge/memory-log.jsonl");

  function loadMemLog(limit = 200) {
      try {
        const raw = readFileSync(MEMLOG_PATH, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const out = [];
        for (const line of lines.slice(-limit * 2)) {
          try {
            out.push(JSON.parse(line));
          } catch {
            // 忽略
          }
        }
        return out.slice(-limit);
      } catch {
        return [];
      }
    }

  const ACT_PATH = join(HOME, ".dsh/onebot-bridge/activities.jsonl");

  const CORE_PATH = join(HOME, ".dsh/onebot-bridge/core.json");

  function appendActivity(rec) {
      try {
        writeFileSync(ACT_PATH, JSON.stringify(rec) + "\n", { flag: "a" });
      } catch {
        // 忽略
      }
    }

  function loadActivities(n = 50) {
      try {
        const raw = readFileSync(ACT_PATH, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const out = [];
        for (const line of lines.slice(-n * 3)) {
          try {
            out.push(JSON.parse(line));
          } catch {
            // 忽略
          }
        }
        return out.slice(-n);
      } catch {
        return [];
      }
    }

  function loadCore() {
      try {
        const d = JSON.parse(readFileSync(CORE_PATH, "utf8"));
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    }

  function saveCore(arr) {
      try {
        writeFileSync(CORE_PATH, JSON.stringify(arr.slice(-60), null, 1));
      } catch {
        // 忽略
      }
    }

  function loadLearnings() {
      try {
        const d = JSON.parse(readFileSync(LEARN_PATH, "utf8"));
        return Array.isArray(d) ? d : [];
      } catch {
        return [];
      }
    }

  function saveLearnings(arr) {
      try {
        writeFileSync(LEARN_PATH, JSON.stringify(arr.slice(-200), null, 1));
      } catch {
        // 忽略
      }
    }

  return { SELF_STATE_PATH, WANTS_PATH, DIGEST_PATH, MEMLOG_PATH, CORE_PATH, ACT_PATH, LEARN_PATH, NET_PATH, NET_MAX_LINKS, loadSelfState, loadWants, saveWants, loadDigests, saveDigests, loadMemLog, loadCore, saveCore, loadActivities, appendActivity, loadLearnings, saveLearnings, loadNet, patchSelfState, recentDigestText, relevantMemories };
}

export { HOME };
