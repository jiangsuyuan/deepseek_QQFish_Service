#!/usr/bin/env node
/**
 * dsh-selfclock —— 她自己的闹钟。
 *
 * 只做一件事：读 self-plan.jsonl，到点了就敲一下桥（POST /internal/wake）。
 * 不决定做什么、不碰日程内容——决定权在日程表（她写的）和桥里的那一轮。
 *
 * 独立于聊天进程：桥重启/崩溃不影响它计时；它挂了也不影响聊天。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";

const HOME = process.env.HOME || homedir();
const BASE = join(HOME, ".dsh/onebot-bridge");
const PLAN = join(BASE, "self-plan.jsonl");
const TOKEN = join(BASE, ".internal-token");
const CONFIG = join(BASE, "config.json");
const TICK_MS = Math.max(5, Number(process.env.SELFCLOCK_TICK || 15)) * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function readPlan() {
  try {
    return readFileSync(PLAN, "utf8")
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

function token() {
  try {
    return readFileSync(TOKEN, "utf8").trim();
  } catch {
    return "";
  }
}

function bridgePort() {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    return Number(c.webuiPort) || 3081;
  } catch {
    return 3081;
  }
}

function wake(tk, port) {
  return new Promise((resolve) => {
    const body = "{}";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/internal/wake",
        method: "POST",
        timeout: 8000,
        headers: {
          "x-internal-token": tk,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ code: res.statusCode, body: d }));
      },
    );
    req.on("error", (e) => resolve({ code: 0, err: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, err: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

const tried = new Map();

async function once() {
  const tk = token();
  if (!tk) return; // 桥还没起来写过 token
  const now = Date.now();
  const due = readPlan()
    .filter((r) => r.status === "pending" && Number(r.at) <= now)
    .sort((a, b) => Number(a.at) - Number(b.at))[0];
  if (!due) return;
  const last = tried.get(due.id) || 0;
  if (now - last < 30000) return; // 同一个条目 30 秒内只敲一次
  tried.set(due.id, now);
  const res = await wake(tk, bridgePort());
  log("wake", due.id, "due", new Date(Number(due.at)).toISOString(), "→", res.code, res.body || res.err || "");
  if (tried.size > 200) {
    for (const [k, v] of tried) if (now - v > 3600_000) tried.delete(k);
  }
}

log("selfclock 启动，每", TICK_MS / 1000, "秒检查一次");
setInterval(() => {
  once().catch((e) => log("err", e?.message ?? e));
}, TICK_MS);
once().catch((e) => log("err", e?.message ?? e));
