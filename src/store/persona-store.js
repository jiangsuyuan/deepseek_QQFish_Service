// 人格存储：P0 身份 / P1 底色 / P2 认同。
//
// 关键约定：
//   · 所有删除都是归档，不真删（persona-archive.jsonl）
//   · 每次变更写一条历史（self-history.jsonl），带 before/after/why/证据
//   · 历史可以回放出任意时刻的状态（my_core({ at })）
//   · P0 只接受确定性证据：cfg / audit / owner / stat
//   · P1 只接受反思类证据（mem / act 里的 think、回看）
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HOME, ".dsh/onebot-bridge");
const PERSONA = join(ROOT, "persona.json");
const CORE = join(ROOT, "core.json");
const ARCHIVE = join(ROOT, "persona-archive.jsonl");
const HISTORY = join(ROOT, "self-history.jsonl");
const SELFMODEL = join(ROOT, "self-model.json");
const CONFIG = join(ROOT, "config.json");
const AUDIT = join(ROOT, "audit.log");
const ACT = join(ROOT, "activities.jsonl");
const MEMLOG = join(ROOT, "memory-log.jsonl");

const LAYERS = { P0: 5, P1: 8, P2: 20 };
const TYPES = {
  P0: ["identity"],
  P1: ["trait", "tension"],
  P2: ["belief", "care", "want", "change", "principle", "liked", "joy"],
};
const CERTAIN = ["cfg", "audit", "owner", "stat"];

function readJson(p, dflt) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}
function readLines(p, n = 0) {
  try {
    const all = readFileSync(p, "utf8").split("\n").filter(Boolean);
    return n ? all.slice(-n) : all;
  } catch {
    return [];
  }
}
function ensureDir(p) {
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    // 忽略
  }
}

/** 含专名/年份/书名号 —— 用来判断“这是不是具体内容” */
const PROPER = /《[^》]+》|\d{4}\s*年|[A-Za-z]{4,}|\d{2,}\s*(卷|篇|章)/;

/** 判断一条底色是不是写得太"完整"（像散文/书面语） */
function tooComplete(text) {
  const t = String(text || "");
  const why = [];
  if (t.length > 60) why.push("超过 60 字");
  if (/(因为|所以|但是|而是|值得|因此|然而|好比|仿佛|像.{0,6}一样)/.test(t)) why.push("有书面连接词或比喻");
  if (/是.{0,12}的地方|是.{0,12}的事/.test(t)) why.push("「是……的地方」句式");
  return why;
}

export function createPersonaStore(app = {}) {
  const { logger } = app;

  function load() {
    const d = readJson(PERSONA, null);
    if (d && Array.isArray(d.items)) return d;
    return { version: 1, items: [], migratedAt: 0 };
  }
  function save(d) {
    ensureDir(PERSONA);
    writeFileSync(PERSONA, JSON.stringify(d, null, 1), "utf8");
  }

  function hist(rec) {
    ensureDir(HISTORY);
    appendFileSync(HISTORY, JSON.stringify(rec) + "\n", "utf8");
  }
  function archive(item, op, why) {
    ensureDir(ARCHIVE);
    appendFileSync(ARCHIVE, JSON.stringify({ at: Date.now(), op, why: why || "", item }) + "\n", "utf8");
  }

  /** 迁移：core.json + self-model → persona.json（只跑一次） */
  function migrateIfNeeded() {
    const d = load();
    if (d.migratedAt) return { migrated: false };
    const now = Date.now();
    const core = readJson(CORE, []);
    const items = [];
    let i = 0;
    for (const c of Array.isArray(core) ? core : []) {
      const text = String(c.text || "").trim();
      if (!text) continue;
      i += 1;
      const layer = "P2"; // 一律先落在认同层（含专名的都是具体内容）
      items.push({ id: `p2-${i}`, layer, type: String(c.type || "belief"), text, at: Number(c.at) || now, updatedAt: Number(c.at) || now });
    }
    // 从 P2 里挑出「无专名且是判断」的，提到 P1（最多 8 条）
    const candidates = items
      .filter((x) => !PROPER.test(x.text) && ["belief", "care", "want", "change"].includes(x.type))
      .slice(-8);
    let k = 0;
    for (const c of candidates) {
      k += 1;
      const moved = items.find((x) => x.id === c.id);
      moved.layer = "P1";
      moved.type = moved.type === "belief" ? "trait" : moved.type;
      moved.id = `p1-${k}`;
    }
    // P0：从 self-model 的 fact 拿一句
    const sm = readJson(SELFMODEL, null);
    const fact = String(sm?.fact?.text || "").trim();
    if (fact) {
      items.push({ id: "p0-1", layer: "P0", type: "identity", text: fact.slice(0, 200), at: Number(sm?.fact?.updatedAt) || now, updatedAt: now });
    }
    const out = { version: 1, items, migratedAt: now };
    save(out);
    logger?.info?.(`[onebot] persona.json 已迁移：P0 ${items.filter((x) => x.layer === "P0").length} / P1 ${k} / P2 ${items.filter((x) => x.layer === "P2").length}`);
    return { migrated: true, counts: { P0: items.filter((x) => x.layer === "P0").length, P1: k, P2: items.filter((x) => x.layer === "P2").length } };
  }

  function list({ layer, type, query, limit, archived } = {}) {
    const d = load();
    // 默认只看没归档的；archived:true 才看归档
    let rows = d.items.filter((x) => (archived ? !!x.archived : !x.archived));
    if (layer) rows = rows.filter((x) => x.layer === layer);
    if (type) rows = rows.filter((x) => x.type === type);
    if (query) {
      const q = String(query);
      rows = rows.filter((x) => x.text.includes(q));
    }
    if (limit) rows = rows.slice(-Number(limit));
    return rows;
  }

  function counts() {
    const d = load();
    const c = { P0: 0, P1: 0, P2: 0 };
    for (const x of d.items) if (!x.archived) c[x.layer] = (c[x.layer] || 0) + 1;
    return c;
  }

  /** 已归档条数（按层） */
  function archivedCounts() {
    const d = load();
    const c = { P0: 0, P1: 0, P2: 0 };
    for (const x of d.items) if (x.archived) c[x.layer] = (c[x.layer] || 0) + 1;
    return c;
  }

  /** 归档：打标记，不删。满的时候用来腾地方；以后 archived:true 还能查回来 */
  function archiveItems({ ids, why, by }) {
    const d = load();
    const want = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "")).filter(Boolean));
    if (!want.size) return { ok: false, reason: "要给她 ids（先 my_core 列出来）" };
    const done = [];
    const missing = [];
    for (const id of want) {
      const it = d.items.find((x) => x.id === id);
      if (!it) { missing.push(id); continue; }
      if (it.archived) { done.push(id); continue; }
      it.archived = true;
      it.archivedAt = Date.now();
      it.archivedWhy = String(why || "").slice(0, 100);
      hist({ at: Date.now(), op: "archive", layer: it.layer, id, before: it.text, after: "", why: it.archivedWhy, by: by || "self" });
      done.push(id);
    }
    if (done.length) save(d);
    return { ok: done.length > 0, archived: done, missing, reason: done.length ? "" : "一条都没归档" };
  }

  /** 从归档里捞回来 */
  function recallItems({ ids, by }) {
    const d = load();
    const want = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "")).filter(Boolean));
    if (!want.size) return { ok: false, reason: "要给 ids" };
    const done = [];
    for (const id of want) {
      const it = d.items.find((x) => x.id === id);
      if (!it || !it.archived) continue;
      it.archived = false;
      delete it.archivedAt;
      delete it.archivedWhy;
      hist({ at: Date.now(), op: "recall", layer: it.layer, id, before: "", after: it.text, why: "", by: by || "self" });
      done.push(id);
    }
    if (done.length) save(d);
    return { ok: done.length > 0, recalled: done, reason: done.length ? "" : "没有可捞的（id 不对，或者本来就没归档）" };
  }

  // ── 证据 ────────────────────────────────────────────
  /** 解析一条证据，返回 { kind: "certain"|"reflection"|"unknown", text } */
  function resolveEvidence(id) {
    const s = String(id || "");
    const [pre, ...rest] = s.split(":");
    const key = rest.join(":");
    if (pre === "cfg") {
      const cfg = readJson(CONFIG, {});
      const v = cfg[key];
      return { kind: "certain", text: v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v) };
    }
    if (pre === "audit") {
      const rows = readLines(AUDIT).filter((l) => l.includes(`"tool":"${key}"`));
      return { kind: "certain", text: rows.length ? `调用 ${rows.length} 次；最近：${rows[rows.length - 1]}` : "" };
    }
    if (pre === "owner") {
      const cfg = readJson(CONFIG, {});
      const uid = String(cfg.ownerId || "");
      const dir = join(ROOT, "messages/private", uid);
      const texts = [];
      for (const f of ["2026-11-08.jsonl"]) {
        try {
          for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
            if (!l.trim()) continue;
            const o = JSON.parse(l);
            if (o.x) texts.push(String(o.x));
          }
        } catch {
          // 忽略
        }
      }
      return { kind: "certain", text: texts.join("\n") };
    }
    if (pre === "stat") {
      if (key === "group_msgs") {
        const n = readLines(join(ROOT, "messages/group/578391484/2026-11-08.jsonl")).length;
        return { kind: "certain", text: `群消息 ${n} 条` };
      }
      if (key === "activity_count") {
        const n = readLines(ACT).length;
        return { kind: "certain", text: `活动 ${n} 次` };
      }
      return { kind: "certain", text: "" };
    }
    if (pre === "mem") {
      const at = Number(key);
      const row = readLines(MEMLOG).map((l) => JSON.parse(l)).find((x) => Number(x.at) === at);
      return row ? { kind: "reflection", text: String(row.text || row.topic || "") } : { kind: "unknown", text: "" };
    }
    if (pre === "act") {
      const at = Number(key);
      const row = readLines(ACT).map((l) => JSON.parse(l)).find((x) => Number(x.at) === at);
      return row ? { kind: "reflection", text: String(row.content || "") } : { kind: "unknown", text: "" };
    }
    return { kind: "unknown", text: "" };
  }

  /** 校验一组证据，返回 { ok, reason, kinds } */
  function verifyEvidence(layer, evidence) {
    const list = Array.isArray(evidence) ? evidence : [];
    if (!list.length) return { ok: false, reason: "没有证据" };
    const kinds = [];
    const ids = new Set();
    for (const ev of list) {
      const id = String(ev?.id || "");
      const quote = String(ev?.quote || "");
      if (!id || !quote) {
        return { ok: false, reason: "每条证据都要 id 和 quote（原文片段）。id 形如 mem:<时间戳> / act:<时间戳>，从 my_memory / my_activities 的结果里抄" };
      }
      const r = resolveEvidence(id);
      if (r.kind === "unknown") return { ok: false, reason: `找不到证据 ${id}` };
      if (!r.text.includes(quote)) return { ok: false, reason: `证据 ${id} 里没有这句原文：${quote.slice(0, 30)}` };
      kinds.push(r.kind);
      ids.add(id);
    }
    if (layer === "P0") {
      if (!kinds.includes("certain")) {
        return { ok: false, reason: "身份层只接受确定性证据：配置(cfg)、使用记录(audit)、创造者原话(owner)、可统计事实(stat)。感受和反思不够。" };
      }
      return { ok: true };
    }
    if (layer === "P1") {
      const refl = kinds.filter((k) => k === "reflection").length;
      if (ids.size < 3) {
        return { ok: false, reason: `底色层需要 3 条不同记录的反思，现在 ${ids.size} 条。id 从 my_memory（type:reflections）和 my_activities 里抄，形如 mem:<at> / act:<at>` };
      }
      if (refl < 3) return { ok: false, reason: `底色层的证据要是反思记录（mem:/act:），现在只有 ${refl} 条是。` };
      return { ok: true };
    }
    return { ok: true };
  }

  // ── 变更 ────────────────────────────────────────────
  function nextId(d, layer) {
    const n = d.items.filter((x) => x.layer === layer).length + 1;
    return `${layer.toLowerCase()}-${Date.now().toString(36)}-${n}`;
  }

  function add({ layer, type, text, evidence, why, by }) {
    const d = load();
    const cnt = d.items.filter((x) => x.layer === layer && !x.archived).length;
    if (cnt >= LAYERS[layer]) {
      return {
        ok: false,
        reason:
          `${layer} 满了（${cnt}/${LAYERS[layer]}）。先看看现在这些：my_core({layer:"${layer}"}) 列出来；` +
          `哪条不准、或者跟别的重复，就 sediment({archive:["p2-xxx","p2-yyy"], why:"重复"}) 归起来——` +
          `归档不会删，以后 archived:true 还能捞回来。`,
      };
    }
    if (!TYPES[layer].includes(type)) return { ok: false, reason: `${layer} 不接受类型 ${type}，可用：${TYPES[layer].join("/")}` };
    if (layer === "P1" && PROPER.test(text)) return { ok: false, reason: "底色层不能含专名/年份/书名号——那是具体内容，留在 P2" };
    const v = layer === "P2" ? { ok: true } : verifyEvidence(layer, evidence);
    if (!v.ok) return { ok: false, reason: v.reason };
    const now = Date.now();
    const item = { id: nextId(d, layer), layer, type, text: String(text).slice(0, 200), at: now, updatedAt: now };
    const hint = layer === "P1" ? tooComplete(item.text) : [];
    d.items.push(item);
    save(d);
    hist({ at: now, op: "add", layer, id: item.id, before: "", after: item.text, why: why || "", evidence: evidence || [], by: by || "self" });
    return { ok: true, item, ...(hint.length ? { hint: "这条读着有点文：" + hint.join("、") + "。人格条目要能单独看懂，又要直白，别写成散文。" } : {}) };
  }

  function revise({ id, text, evidence, why, by }) {
    const d = load();
    const item = d.items.find((x) => x.id === id);
    if (!item) return { ok: false, reason: `没有 ${id} 这条` };
    if (item.layer === "P1" && PROPER.test(text)) return { ok: false, reason: "底色层不能含专名/年份/书名号" };
    const v = by === "creator" || item.layer === "P2" ? { ok: true } : verifyEvidence(item.layer, evidence);
    if (!v.ok) return { ok: false, reason: v.reason };
    const before = item.text;
    item.text = String(text).slice(0, 200);
    item.updatedAt = Date.now();
    save(d);
    hist({ at: item.updatedAt, op: "revise", layer: item.layer, id, before, after: item.text, why: why || "", evidence: evidence || [], by: by || "self" });
    return { ok: true, item };
  }

  function retract({ id, why, by }) {
    const d = load();
    const i = d.items.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, reason: `没有 ${id} 这条` };
    const [item] = d.items.splice(i, 1);
    save(d);
    archive(item, "retract", why);
    hist({ at: Date.now(), op: "retract", layer: item.layer, id, before: item.text, after: "", why: why || "", by: by || "self" });
    return { ok: true, item };
  }

  // ── 历史与回放 ──────────────────────────────────────
  function history({ layer, days, limit = 50, query } = {}) {
    let rows = readLines(HISTORY).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    if (layer) rows = rows.filter((r) => r.layer === layer);
    if (days) {
      const cut = Date.now() - Number(days) * 86400_000;
      rows = rows.filter((r) => Number(r.at) >= cut);
    }
    if (query) {
      const q = String(query);
      rows = rows.filter((r) => String(r.before || "").includes(q) || String(r.after || "").includes(q));
    }
    return rows.slice(-Number(limit));
  }

  /** 回放到 ts 时刻：重建那天的三层状态 */
  function stateAt(ts) {
    const rows = history({ limit: 100000 }).filter((r) => Number(r.at) <= Number(ts));
    const map = new Map();
    for (const r of rows) {
      if (r.op === "add") map.set(r.id, { id: r.id, layer: r.layer, text: r.after, at: r.at });
      else if (r.op === "revise") {
        const cur = map.get(r.id) || { id: r.id, layer: r.layer };
        cur.text = r.after;
        map.set(r.id, cur);
      } else if (r.op === "retract") map.delete(r.id);
    }
    const out = { P0: [], P1: [], P2: [] };
    for (const v of map.values()) (out[v.layer] = out[v.layer] || []).push(v);
    return out;
  }

  return { load, save, migrateIfNeeded, list, counts, archivedCounts, archiveItems, recallItems, add, revise, retract, history, stateAt, verifyEvidence, resolveEvidence, LAYERS, TYPES };
}
