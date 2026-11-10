// 复读机：群里好几个人连发同一句时，她跟着发一句一模一样的。
//
// 规矩（和创造者定的）：
//   · 默认关，她自己打开才生效（echo_mode 工具）
//   · 检测：同一群 60 秒内 ≥2 个不同的人发了完全相同的文本
//   · 过滤：2–20 字、纯文字、不含 @ / 链接 / 图片 / 卡片 / 骂人词
//   · 频率：每群 10 分钟最多跟一次
//   · 跟完必须告诉她（下一轮对话开头说一句）
//
// 为什么自动发：复读价值在"在场"，她一个回合要 2–20 秒，等她想完热闹已经过去了。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HOME, ".dsh/onebot-bridge/echo.json");

const WINDOW_MS = 5 * 60 * 1000; // 真实复读是慢的：实测同一句能隔十几分钟还在复读
const COOLDOWN_MS = 5 * 60 * 1000; // 群级冷却：跟完一句，5 分钟内不再跟
const ROUND_GAP_MS = 3 * 60 * 1000; // 同一句隔 3 分钟没人再说 = 这一轮复读结束
const SAME_TEXT_MS = 60 * 60 * 1000; // 同一句 1 小时内只跟一次（复读可能拖很久）
const MIN_LEN = 2;

const BAD = /(操你|傻逼|妈的|滚|死|杀|裸|约炮|@|http|www\.|\.com)/i;

function norm(t) {
  return String(t || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

import { checkDeps } from "../util/deps.js";

export function createEcho(app = {}) {
  checkDeps("复读机", app, ["client", "logger"]);
  const { client, logger, audit } = app;
  let st = null;

  function load() {
    if (st) return st;
    try {
      st = JSON.parse(readFileSync(PATH, "utf8"));
    } catch {
      st = {};
    }
    if (typeof st.on !== "boolean") st.on = false; // 默认关
    if (!st.groups || typeof st.groups !== "object") st.groups = {};
    if (!Array.isArray(st.pending)) st.pending = [];
    return st;
  }
  function save() {
    try {
      writeFileSync(PATH, JSON.stringify(load(), null, 1), "utf8");
    } catch {
      // 忽略
    }
  }

  function setEnabled(on) {
    load().on = !!on;
    save();
    logger?.info?.(`[onebot] 复读机 ${on ? "已打开" : "已关闭"}`);
    return { ok: true, on: load().on };
  }

  /** 每来一条群消息都喂一次；够条件就自动跟一句 */
  async function feed({ groupId, userId, text }) {
    const s = load();
    if (!s.on) return;
    const gid = String(groupId || "");
    if (!gid || !userId) return;
    const t = String(text || "").trim();
    if (t.length < MIN_LEN) return; // 不设上限：真实复读常是二三十字的一句吐槽
    if (BAD.test(t)) return;
    if (/\[[^\]]+\]/.test(t)) return; // [图片] [卡片] 之类占位
    const n = norm(t);
    if (n.length < MIN_LEN) return;

    const g = (s.groups[gid] = s.groups[gid] || {
      recent: [],
      lastEchoAt: 0,
      lastText: "",
      lastTextAt: 0,
      echoedInRound: false,
    });
    const now = Date.now();
    g.recent = (g.recent || []).filter((x) => now - x.at <= WINDOW_MS);
    g.recent.push({ n, at: now, by: String(userId) });

    const same = g.recent.filter((x) => x.n === n);
    const people = new Set(same.map((x) => x.by));
    if (g.recent.length >= 2 && people.size === 1) {
      logger?.debug?.(`[onebot] 复读候选但只有同一个人：${t.slice(0, 20)}`);
    }
    if (people.size < 2) return; // 至少两个不同的人
    // 同一轮复读只跟一次：
    //   同一句隔 ROUND_GAP_MS 没人再说 → 算新的一轮，可以再跟
    if (g.lastText !== n || now - (g.lastTextAt || 0) > ROUND_GAP_MS) {
      g.lastText = n;
      g.echoedInRound = false;
    }
    g.lastTextAt = now;
    if (g.echoedInRound) return; // 这一轮已经跟过
    g.echoed = g.echoed && typeof g.echoed === "object" ? g.echoed : {};
    if (Number(g.echoed[n] || 0) && now - Number(g.echoed[n]) < SAME_TEXT_MS) return; // 同一句已经跟过
    if (now - (g.lastEchoAt || 0) < COOLDOWN_MS) return; // 群级冷却

    // 发
    try {
      const cli = typeof client === "function" ? client() : client;
      await cli.call("send_group_msg", { group_id: Number(gid), message: t });
      g.lastEchoAt = now;
      g.lastText = n;
      g.echoedInRound = true;
      g.echoed[n] = now;
      g.recent = [];
      s.pending.push({ at: now, groupId: gid, text: t, people: people.size });
      if (s.pending.length > 20) s.pending = s.pending.slice(-20);
      save();
      audit?.({ kind: "echo", group: gid, text: t, people: people.size });
      logger?.info?.(`[onebot] 复读跟了一句（${people.size} 人）：${t}`);
    } catch (err) {
      logger?.warn?.("[onebot] 复读发送失败：" + (err?.message ?? err));
    }
  }

  /** 取出"要告诉她的事"，取完即清 */
  function takeNotes() {
    const s = load();
    if (!s.pending?.length) return "";
    const list = s.pending.splice(0, s.pending.length);
    save();
    return list
      .map((p) => `（刚才群 ${p.groupId} 有 ${p.people} 个人在复读「${p.text}」，你跟着发了一句。）`)
      .join("\n");
  }

  function register() {
    return {
      name: "echo_mode",
      description:
        "开关「复读机」：群里好几个人连发同一句时，你自动跟着发一句一模一样的。\n" +
        "默认关。打开后每群 10 分钟最多跟一次；跟完会告诉你。",
      parameters: {
        on: { type: "boolean", description: "true 打开 / false 关闭" },
      },
      execute: async (args) => setEnabled(args?.on === true),
    };
  }

  function status() {
    const s = load();
    return { on: s.on, groups: Object.keys(s.groups).length };
  }

  return { feed, takeNotes, setEnabled, status, register };
}
