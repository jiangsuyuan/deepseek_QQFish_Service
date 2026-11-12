import http from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { webHtml } from "./ui.js";
import { downloadImage } from "../net/fetch.js";
import { execFileSync } from "node:child_process";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

export function createWebServer(ctx) {
  const { WEBHIST_PATH, cfg, client, fireDuePlan, loadActivities, logger, state, webClients, webHistory } = ctx;
  function loadWebHistory(limit = 120) {
      try {
        const raw = readFileSync(WEBHIST_PATH, "utf8");
        state.webHistReadError = "";
        const out = [];
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            // 忽略
          }
        }
        return out.slice(-limit);
      } catch (err) {
        if (err && err.code === "ENOENT") {
          state.webHistReadError = "";   // 还没写过历史文件，就是空的
          return [];
        }
        state.webHistReadError = String(err?.code || "") + " " + String(err?.message || err);
        return [];
      }
    }

  function webPush(rec) {
      try {
        const item = { ...rec, at: Date.now(), id: "wh-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6) };
        // tool 记录不进历史文件（否则一刷新就混进聊天流里）
        if (rec && rec.role === "tool") {
          const line0 = "data: " + JSON.stringify(item) + "\n\n";
          for (const res0 of webClients) {
            try {
              res0.write(line0);
            } catch {
              webClients.delete(res0);
            }
          }
          return;
        }
        webHistory.push(item);
        if (webHistory.length > 100) webHistory.shift();
        try {
          appendFileSync(WEBHIST_PATH, JSON.stringify(item) + "\n");
        } catch {
          // 忽略
        }
        // 推 item 而不是 rec——item 带 at，客户端才能按时间排序。
        // 之前推 rec（没 at），WinForms 收到的时间戳全空，消息就会错位堆积。
        const line = "data: " + JSON.stringify(item) + "\n\n";
        for (const res of webClients) {
          try {
            res.write(line);
          } catch {
            webClients.delete(res);
          }
        }
      } catch {
        // 忽略
      }
    }

  function webStart() {
      if (!cfg.webuiEnabled || state.webServer) return;
      const token = String(cfg.webuiToken || "");
      if (!token || token.length < 16) {
        logger.warn?.("[onebot] webuiToken 太短或没设置，WebUI 不启动");
        return;
      }
      state.webServer = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        // 内部唤醒端点：给独立的 dsh-selfclock 用（只绑 127.0.0.1 + 文件 token）
        if (u.pathname === "/internal/wake") {
          void (async () => {
            try {
              const want = readFileSync(join(HOME, ".dsh/onebot-bridge/.internal-token"), "utf8").trim();
              const got = String(req.headers["x-internal-token"] || "");
              if (!want || got !== want) {
                res.writeHead(403).end("forbidden");
                return;
              }
              const fired = fireDuePlan();
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, fired }));
            } catch (err) {
              res.writeHead(500).end(String(err?.message ?? err));
            }
          })();
          return;
        }
        const tk = u.searchParams.get("token") || String(req.headers["x-webui-token"] || "");
        // 简单防爆破
        if (Date.now() < state.webLockedUntil) {
          res.writeHead(429).end("too many attempts");
          return;
        }
        if (tk !== token) {
          state.webAuthFails += 1;
          if (state.webAuthFails >= 5) {
            state.webLockedUntil = Date.now() + 3600_000;
            state.webAuthFails = 0;
            logger.warn?.("[onebot] WebUI 认证失败 5 次，锁定 1 小时");
          }
          res.writeHead(401).end("unauthorized");
          return;
        }
        state.webAuthFails = 0;

        if (u.pathname === "/") {
          res
            .writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store, no-cache, must-revalidate",
              pragma: "no-cache",
            })
            .end(webHtml(token));
          return;
        }
        if (u.pathname === "/history") {
          // 网页聊天有自己独立的一份记录，不和 QQ/群/活动混
          // 返回全量——原来只给 300 条，文件里 740 条，
          // 「上个月的对话」在网页上就成了空白
          const scope = String(u.searchParams.get("scope") || "all").toLowerCase();
          let list = loadWebHistory(2000);
          if (state.webHistReadError) {
            logger.warn?.("[onebot] /history 读取失败：" + state.webHistReadError);
            res
              .writeHead(500, { "content-type": "application/json; charset=utf-8" })
              .end(JSON.stringify({ error: "webui-history 读取失败", detail: state.webHistReadError }));
            return;
          }
          if (!list.length) list = webHistory.slice(-50);
          // tool 记录（[send_sticker] / [my_memory] 之类）是工具调用的痕迹，
          // 不是聊天内容。混在消息流里会被渲染成「发表情」这种怪气泡，
          // 还会把真正的对话挤到错误位置。
          list = list.filter((m) => m && m.role !== "tool");
          // scope=private 只看跟创造者的私聊（群聊太吵，客户端默认就这个视图）
          if (scope === "private") {
            list = list.filter((m) => !String(m.channel || "").startsWith("group"));
          } else if (scope === "group") {
            list = list.filter((m) => String(m.channel || "").startsWith("group"));
          }
          // 按时间排（回填过的旧记录会被追加到文件末尾，必须排序）
          list = list.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
          return;
        }
        if (u.pathname === "/stream") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          webClients.add(res);
          const ka = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              clearInterval(ka);
              webClients.delete(res);
            }
          }, 25_000);
          req.on("close", () => {
            clearInterval(ka);
            webClients.delete(res);
          });
          return;
        }
        // 她发的图片（表情包等）
        // PWA：manifest（start_url 带 token，否则从桌面图标打开会 401）
        if (u.pathname === "/manifest.json") {
          const iconDir = join(HERE, "icons");
          const has = (f) => {
            try {
              return existsSync(join(iconDir, f));
            } catch {
              return false;
            }
          };
          const icons = [];
          if (has("icon-192.png"))
            icons.push({ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" });
          if (has("icon-512.png"))
            icons.push({ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" });
          if (has("icon-maskable-512.png"))
            icons.push({
              src: "/icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            });
          const manifest = {
            name: "QQ 助手",
            short_name: "肥鱼",
            description: "她在这儿",
            start_url: `/?token=${encodeURIComponent(String(cfg.webuiToken || ""))}`,
            scope: "/",
            display: "standalone",
            orientation: "portrait",
            background_color: "#12141a",
            theme_color: "#12141a",
            lang: "zh-CN",
            icons,
          };
          res.writeHead(200, {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(manifest));
          return;
        }
        if (u.pathname.startsWith("/icon-")) {
          const name = u.pathname.slice(1).replace(/[^a-zA-Z0-9._-]/g, "");
          const file = join(HERE, "icons", name);
          try {
            const buf = readFileSync(file);
            res.writeHead(200, {
              "content-type": "image/png",
              "cache-control": "public, max-age=86400",
            });
            res.end(buf);
          } catch {
            res.writeHead(404).end("no icon");
          }
          return;
        }

        // 创造者从 WebUI 发来的图片（存在 uploads/，带 token 校验）
        if (u.pathname.startsWith("/uploads/")) {
          const name = u.pathname.slice(9).replace(/[^a-zA-Z0-9._-]/g, "");
          if (!name) {
            res.writeHead(400).end("bad name");
            return;
          }
          const file = join(HOME, ".dsh/onebot-bridge/uploads", name);
          try {
            const buf = readFileSync(file);
            const ext = (name.split(".").pop() || "png").toLowerCase();
            const mime =
              ext === "png"
                ? "image/png"
                : ext === "gif"
                  ? "image/gif"
                  : ext === "webp"
                    ? "image/webp"
                    : "image/jpeg";
            res.writeHead(200, { "content-type": mime, "cache-control": "private, max-age=600" });
            res.end(buf);
          } catch {
            res.writeHead(404).end("no image");
          }
          return;
        }
        if (u.pathname.startsWith("/img/")) {
          const name = u.pathname.slice(5).replace(/[^a-zA-Z0-9._-]/g, "");
          const file = join(HOME, ".dsh/onebot-bridge/workspace/pages", name);
          try {
            const buf = readFileSync(file);
            const ext = (name.split(".").pop() || "jpg").toLowerCase();
            const mime =
              ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
            res.writeHead(200, { "content-type": mime, "cache-control": "public, max-age=3600" });
            res.end(buf);
          } catch {
            res.writeHead(404).end("no image");
          }
          return;
        }
        // 她做的网页
        if (u.pathname.startsWith("/page/")) {
          const id = u.pathname.slice(6).replace(/[^a-z0-9]/gi, "");
          const file = join(HOME, ".dsh/onebot-bridge/workspace/pages", `${id}.html`);
          try {
            const body = readFileSync(file, "utf8");
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              // 完全隔离：不允许它碰 WebUI 的 storage / token
              "content-security-policy": "sandbox allow-scripts allow-popups; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:;",
              "x-content-type-options": "nosniff",
            });
            res.end(body);
          } catch {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("页面不存在");
          }
          return;
        }
        // ── 只读看板接口（4.3）──────────────────────────────
        if (u.pathname.startsWith("/api/")) {
          const json = (obj) => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(obj));
          };
          const ROOT = join(HOME, ".dsh/onebot-bridge");
          const readJson = (p, dflt) => {
            try {
              return JSON.parse(readFileSync(p, "utf8"));
            } catch {
              return dflt;
            }
          };
          const todayYmd = () => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          };
          const groupDirs = () => {
            try {
              return readdirSync(join(ROOT, "messages/group")).filter((g) => statSync(join(ROOT, "messages/group", g)).isDirectory());
            } catch {
              return [];
            }
          };
          const readDay = (gid, day) => {
            try {
              return readFileSync(join(ROOT, "messages/group", gid, day + ".jsonl"), "utf8")
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
          };
          try {
            if (u.pathname === "/api/stats") {
              const day = todayYmd();
              let inN = 0;
              let outN = 0;
              for (const gid of groupDirs()) {
                for (const r of readDay(gid, day)) {
                  if (r.d === "o") outN += 1;
                  else inN += 1;
                }
              }
              let last = null;
              try {
                const lines = readFileSync(join(ROOT, "usage.jsonl"), "utf8").trim().split("\n");
                last = JSON.parse(lines[lines.length - 1]);
              } catch {
                last = null;
              }
              const mood = readJson(join(ROOT, "mood.json"), { mood: 70, why: "", updatedAt: 0, history: [] });
              let acts = [];
              try {
                acts = loadActivities(20).slice(-5).reverse().map((r) => ({
                  time: new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5),
                  kind: r.kind,
                  intent: String((r.think || {}).intent || "").slice(0, 80),
                }));
              } catch {
                acts = [];
              }
              return json({
                online: !!client.connected,
                today: { in: inN, out: outN },
                context: { total: Number(last?.total || 0), sessions: Number(last?.sessions || 0) },
                sessions: (last?.top || []).map((x) => ({ key: String(x.key || ""), total: Number(x.total || 0) })),
                mood,
                activities: acts,
              });
            }
            if (u.pathname === "/api/groups") {
              const day = todayYmd();
              const out = groupDirs().map((gid) => {
                const rows = readDay(gid, day);
                let i2 = 0;
                let o2 = 0;
                let lastText = "";
                for (const r of rows) {
                  if (r.d === "o") o2 += 1;
                  else i2 += 1;
                  lastText = String(r.x || "").slice(0, 30);
                }
                let name = "";
                try {
                  const meta = readJson(join(ROOT, "group-meta.json"), {});
                  name = String(meta?.[gid]?.name || meta?.[gid]?.groupName || "");
                } catch {
                  name = "";
                }
                return { gid, name, in: i2, out: o2, last: lastText };
              });
              out.sort((a, b) => b.in - a.in);
              return json(out);
            }
            if (u.pathname === "/api/group") {
              const gid = String(u.searchParams.get("id") || "").replace(/[^0-9]/g, "");
              if (!gid) return json({ ok: false, error: "缺 id" });
              const day = todayYmd();
              const rows = readDay(gid, day).slice(-50);
              let name = "";
              try {
                const meta = readJson(join(ROOT, "group-meta.json"), {});
                name = String(meta?.[gid]?.name || meta?.[gid]?.groupName || "");
              } catch {
                name = "";
              }
              return json({
                gid,
                name,
                messages: rows.map((r) => ({
                  time: new Date(Number(r.t) * 1000).toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5),
                  who: r.d === "o" ? "她" : String(r.n || r.u || ""),
                  me: r.d === "o",
                  at: !!r.atMe,
                  text: String(r.x || "").slice(0, 200),
                })),
              });
            }
            if (u.pathname === "/api/logs") {
              let audit = [];
              try {
                audit = readFileSync(join(ROOT, "audit.log"), "utf8").trim().split("\n").slice(-12).reverse();
              } catch {
                audit = [];
              }
              let tail = [];
              try {
                tail = execFileSync("journalctl", ["-u", "dsh-web", "-n", "60", "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 4000 })
                  .split("\n")
                  .filter(Boolean)
                  .slice(-60);
              } catch {
                tail = ["（读不到 journalctl，可能是权限问题）"];
              }
              const errors = tail.filter((l) => /ReferenceError|TypeError|超时|失败|错误/i.test(l)).slice(-10);
              return json({ audit, tail, errors });
            }
            if (u.pathname === "/api/her") {
              const pdata = readJson(join(ROOT, "persona.json"), { items: [] });
              const items = Array.isArray(pdata.items) ? pdata.items : [];
              const cnt = { P0: 0, P1: 0, P2: 0 };
              for (const it of items) if (!it.archived) cnt[it.layer] = (cnt[it.layer] || 0) + 1;
              const mood = readJson(join(ROOT, "mood.json"), { mood: 70, history: [] });
              let acts = [];
              try {
                acts = loadActivities(20).slice(-8).reverse().map((r) => ({
                  time: new Date(r.at).toLocaleString("zh-CN", { hour12: false }).slice(5, 16),
                  kind: r.kind,
                  did: String(r.content || "").slice(0, 160),
                }));
              } catch {
                acts = [];
              }
              return json({
                persona: cnt,
                items: items.filter((x) => !x.archived).map((x) => ({ layer: x.layer, text: String(x.text || "").slice(0, 200), archived: !!x.archived })),
                mood,
                acts,
              });
            }
            if (u.pathname === "/api/sys") {
              let version = "";
              try {
                version = String(readJson(join(HOME, ".dsh/profiles/web/package.json"), {}).dependencies?.["dsh-onebot-bridge"] || "");
              } catch {
                version = "";
              }
              let pending = 0;
              try {
                pending = Array.isArray(state.inbox) ? state.inbox.filter((x) => x.status === "unread").length : 0;
              } catch {
                pending = 0;
              }
              const keys = ["activeStartHour", "activeEndHour", "followUpSeconds", "followUpMaxTurns", "quoteInGroup", "groupObserve", "stickerMaxCount", "compactThresholdMB", "styleHint"];
              const cfgView = {};
              for (const k of keys) cfgView[k] = cfg?.[k];
              return json({
                online: !!client.connected,
                uptime: typeof process.uptime === "function" ? Math.round(process.uptime() / 60) + " 分钟" : "—",
                version: version || "—",
                sessions: (() => {
                  try {
                    const lines = readFileSync(join(ROOT, "usage.jsonl"), "utf8").trim().split("\n");
                    return JSON.parse(lines[lines.length - 1]).sessions || 0;
                  } catch {
                    return 0;
                  }
                })(),
                pending,
                cfg: cfgView,
              });
            }
          } catch (err) {
            return json({ ok: false, error: String(err?.message ?? err) });
          }
          res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false}');
          return;
        }

        if (u.pathname === "/activities") {
          let items = [];
          try {
            const rows = loadActivities(120);
            items = rows.slice(-20).reverse().map((r) => {
              const d = new Date(r.at);
              const hh = String(d.getHours()).padStart(2, "0");
              const mm = String(d.getMinutes()).padStart(2, "0");
              return {
                at: r.at,
                time: `${hh}:${mm}`,
                kind: r.kind,
                intent: String((r.think || {}).intent || "").slice(0, 80),
                did: String(r.content || "").slice(0, 160),
                reflect: String(r.reflect || "").slice(0, 120),
              };
            });
          } catch {
            items = [];
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(items));
          return;
        }
        if (u.pathname === "/buttons") {
          let list = [];
          try {
            list = JSON.parse(readFileSync(join(HOME, ".dsh/onebot-bridge/webui-buttons.json"), "utf8"));
          } catch {
            list = [];
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(list) ? list : []));
          return;
        }
        if (u.pathname === "/pages") {
          let list = [];
          try {
            const dir = join(HOME, ".dsh/onebot-bridge/workspace/pages");
            list = readdirSync(dir)
              .filter((f) => f.endsWith(".html"))
              .map((f) => {
                const st = statSync(join(dir, f));
                let title = f.replace(/\.html$/, "");
                try {
                  const head = readFileSync(join(dir, f), "utf8").slice(0, 600);
                  const mt = head.match(/<title>([^<]{1,80})<\/title>/i);
                  if (mt) title = mt[1].trim();
                } catch {
                  // 忽略
                }
                return { id: f.replace(/\.html$/, ""), title, at: st.mtimeMs };
              })
              .sort((a, b) => b.at - a.at)
              .slice(0, 100);
          } catch {
            list = [];
          }
          if (u.searchParams.get("format") === "json") {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
            return;
          }
          const rows = list
            .map((p) => {
              const d = new Date(p.at);
              const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
              const safe = String(p.title).replace(/[<>&"]/g, "");
              return `<li><a href="/page/${p.id}?token=${encodeURIComponent(token)}" target="_blank">${safe}</a><span class="t">${when}</span></li>`;
            })
            .join("");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>她的页面</title>
  <style>
  body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;max-width:760px;margin:0 auto;padding:24px 18px;background:#0f1115;color:#e6e6e6}
  h1{font-size:18px;margin-bottom:16px}
  ul{list-style:none;padding:0}
  li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #23262d;border-radius:10px;margin-bottom:8px;background:#1a1d24}
  a{color:#7cc4ff;text-decoration:none;font-weight:500}
  a:hover{text-decoration:underline}
  .t{color:#8b93a1;font-size:12px;white-space:nowrap}
  .empty{color:#8b93a1}
  .bm{margin-bottom:20px;padding:12px 14px;border:1px solid #23262d;border-radius:10px;background:#171a20}
  .bm-t{font-size:12px;color:#8b93a1;margin-bottom:8px}
  .bm-l{display:flex;flex-wrap:wrap;gap:8px}
  .bm .btn{display:inline-block;padding:5px 14px;border-radius:14px;background:#1e222a;border:1px solid #2a2e38;color:#c9d1d9;text-decoration:none;font-size:13px}
  .bm .btn:hover{background:#262b35;border-color:#3a4150;text-decoration:none}
  </style></head><body>
  <h1>她的页面（${list.length}）</h1>
  ${(() => {
    let btns = [];
    try {
      btns = JSON.parse(readFileSync(join(HOME, ".dsh/onebot-bridge/webui-buttons.json"), "utf8"));
    } catch {
      btns = [];
    }
    if (!Array.isArray(btns) || !btns.length) return "";
    const items = btns
      .map(
        (b) =>
          `<a class="btn" href="${b.pageId ? `/page/${b.pageId}?token=${encodeURIComponent(token)}` : `/?token=${encodeURIComponent(token)}&prefill=${encodeURIComponent(b.label)}`}">${String(b.label).replace(/[<>&"]/g, "")}</a>`,
      )
      .join("");
    return `<div class="bm"><div class="bm-t">快捷入口</div><div class="bm-l">${items}</div></div>`;
  })()}
  ${list.length ? `<ul>${rows}</ul>` : '<p class="empty">还没有页面。她做页面的时候会出现在这里。</p>'}
  </body></html>`);
          return;
        }
        // ── /qqlogin：给客户端「登录 QQ」用，返回带 token 的 NapCat WebUI 链接 ──
        if (u.pathname === "/qqlogin") {
          let tok = "";
          let port = 6099;
          try {
            const p = join(HOME, "Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json");
            const j = JSON.parse(readFileSync(p, "utf8"));
            tok = String(j?.token ?? "");
            port = Number(j?.port) || 6099;
          } catch {
            // 读不到就返回失败
          }
          const body = tok
            ? JSON.stringify({
                ok: true,
                url: "http://127.0.0.1:" + port + "/webui?token=" + encodeURIComponent(tok),
                port,
                note: "客户端需要同时转发 " + port + " 端口",
              })
            : JSON.stringify({ ok: false, reason: "没读到 NapCat 的 webui.json" });
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          });
          res.end(body);
          return;
        }

        // 4.3：/send 已删除——看板只读，不再从网页替她说话
res.writeHead(404).end("not found");
      });
      state.webServer.listen(Number(cfg.webuiPort) || 3081, String(cfg.webuiBind || "127.0.0.1"), () => {
        logger.info?.(
          `[onebot] WebUI 已启动 http://${cfg.webuiBind || "127.0.0.1"}:${Number(cfg.webuiPort) || 3081}/?token=***`,
        );
      });
      state.webServer.on("error", (err) => {
        logger.warn?.(`[onebot] WebUI 启动失败：${err?.message ?? err}`);
        state.webServer = null;
      });
    }

  return { webStart, webPush, loadWebHistory };
}

export { HOME };
