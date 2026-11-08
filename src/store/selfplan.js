// 自主计划：日程表读写。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../core/logger.js";
import { dirnameOf } from "./msglog.js";
import { mkdirSync, renameSync, appendFileSync } from "node:fs";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

const SELF_PLAN_PATH = join(HOME, ".dsh/onebot-bridge/self-plan.jsonl");

const PLAN_GRACE_MS = 2 * 3600_000;

function readSelfPlan() {
  try {
    if (!existsSync(SELF_PLAN_PATH)) return [];
    return readFileSync(SELF_PLAN_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
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
}

function writeSelfPlan(rows) {
  try {
    mkdirSync(dirnameOf(SELF_PLAN_PATH), { recursive: true });
    const tmp = SELF_PLAN_PATH + ".tmp";
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    renameSync(tmp, SELF_PLAN_PATH);
  } catch {
    // 写失败不影响运行
  }
}

function addSelfPlan({ at, kind = "", note = "", source = "self" }) {
  const rec = {
    id: "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    at: Number(at) || Date.now(),
    kind: String(kind || "").slice(0, 40),
    note: String(note || "").slice(0, 200),
    status: "pending",
    created: Date.now(),
    source,
  };
  try {
    mkdirSync(dirnameOf(SELF_PLAN_PATH), { recursive: true });
    appendFileSync(SELF_PLAN_PATH, JSON.stringify(rec) + "\n");
  } catch {
    // 忽略
  }
  return rec;
}

function updateSelfPlan(id, patch) {
  const rows = readSelfPlan().map((r) => (String(r.id) === String(id) ? { ...r, ...patch } : r));
  writeSelfPlan(rows);
  return rows.find((r) => String(r.id) === String(id)) || null;
}

function nextSelfPlan() {
  const rows = readSelfPlan()
    .filter((r) => r.status === "pending")
    .sort((a, b) => Number(a.at) - Number(b.at));
  return rows[0] || null;
}

function claimDueSelfPlan(nowMs = Date.now()) {
  const due = readSelfPlan()
    .filter((r) => r.status === "pending" && Number(r.at) <= nowMs)
    .sort((a, b) => Number(a.at) - Number(b.at))[0];
  if (!due) return null;
  if (nowMs - Number(due.at) > PLAN_GRACE_MS) {
    updateSelfPlan(due.id, { status: "expired", expiredAt: nowMs });
    getLogger()?.info?.(
      `[onebot] 日程 ${due.id} 错过 ${Math.round((nowMs - due.at) / 60000)} 分钟，标 expired`,
    );
    return { ...due, expired: true };
  }
  updateSelfPlan(due.id, { status: "fired", firedAt: nowMs });
  return due;
}

function ensureSelfPlanPending(atMs, kind = "", note = "", source = "fallback") {
  const p = nextSelfPlan();
  if (p) return p;
  return addSelfPlan({ at: atMs, kind, note, source });
}

export { HOME, SELF_PLAN_PATH, PLAN_GRACE_MS, readSelfPlan, writeSelfPlan, addSelfPlan, updateSelfPlan, nextSelfPlan, claimDueSelfPlan, ensureSelfPlanPending };
