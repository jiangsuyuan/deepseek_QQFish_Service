import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

import { lastSvgRender, setLastSvgRender } from "../features/stickers.js";
import { audit } from "../core/audit.js";
import { downloadImage, fetchHotNews } from "../net/fetch.js";
import { findMsgInLog, readMsgLog } from "../store/msglog.js";
// 画图/看图/新闻类工具。

import { createImageLocator, channelKeyOfEntry } from "../util/image-locate.js";

export function registerMediaTools(app) {
  const { cfg, client, logger, sessions, state, pluginCtx: ctx } = app;
  // 取图坐标系：look_image 与 save_sticker 共用同一套
  const imageLocator = createImageLocator({ findMsgInLog, logger });
  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "draw_svg",
            description:
              "用 SVG 代码画一张图发出去。**适合**：图表、流程图、示意图、简单图标、文字排版、" +
              "几何图形、简笔画。**不适合**：写实画面、复杂人物、照片风格（那种用 draw_image）。" +
              "svg 参数要传**完整的 <svg>...</svg>**，宽高建议 400-800。" +
              "想画就画。",
            parameters: {
              send: {
                type: "boolean",
                description:
                  "画完要不要直接发到聊天里，默认 true。" +
                  "想先看效果再决定就填 false —— 渲染结果照样会摆在工具结果里给你看，只是不发出去。",
              },
              svg: { type: "string", description: "完整的 SVG 代码" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => {
                const blocks = [{ type: "text", text: JSON.stringify(v) }];
                // 把画出来的图摆回工具结果 —— 她画完立刻就能看见效果，好自己判断要不要改
                if (lastSvgRender && lastSvgRender.ref) {
                  blocks.push({ type: "text", text: "▼ 渲染结果（你画的就是这样）" });
                  blocks.push({ type: "image", attachment: lastSvgRender.ref });
                }
                return blocks;
              },
            },
            execute: async (args, exec) => {
              const sid = String(exec?.agent?.session?.id ?? "");
              const entry = sid ? sessions.bySessionId(sid) : null;
              const target = entry?.lastTarget;
              if (!target) return { ok: false, reason: "没有会话上下文" };

              let svg = String(args?.svg ?? "").trim();
              // 允许模型省略外层标签
              if (!svg.includes("<svg")) {
                return { ok: false, reason: "需要完整的 <svg>...</svg> 代码" };
              }
              if (svg.length > 12000) return { ok: false, reason: "SVG 太长（上限 12KB）" };
              if (/<script/i.test(svg) || /on\w+\s*=/i.test(svg)) {
                return { ok: false, reason: "SVG 里不允许脚本或事件属性" };
              }

              try {
                const sharpMod = await import(
                  "/opt/node-v24.22.1-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp/dist/index.mjs"
                );
                const sharp = sharpMod.default ?? sharpMod;
                const png = await sharp(Buffer.from(svg, "utf8"))
                  .resize({ width: 720, withoutEnlargement: false, fit: "inside" })
                  .png()
                  .toBuffer();
                if (!png.length || png.length > 3_000_000) {
                  return { ok: false, reason: "渲染结果异常" };
                }
                const tmp = join(HOME, ".dsh/onebot-bridge/svg.png");
                writeFileSync(tmp, png);
                // 同时把 SVG 源码存一份：出图有问题（文字重叠、位置错）时能直接看源码定位
                try {
                  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                  writeFileSync(
                    join(HOME, ".dsh/onebot-bridge/svg-src", `svg-${stamp}.svg`),
                    svg,
                    "utf8",
                  );
                } catch {
                  // 忽略
                }
                // 存成 attachment：这样 render 能把图摆回工具结果给她看
                const wantSend = args?.send !== false;
                let ref = null;
                try {
                  const att = sessions.svc?.("attachments");
                  if (att?.saveImage) ref = await att.saveImage({ data: png, mediaType: "image/png" });
                } catch {
                  // 存不了也不影响发送，只是她看不见
                }
                setLastSvgRender({ ref, bytes: png.length, sent: wantSend });

                if (wantSend) {
                  await client.sendImage(target, tmp);
                  audit({ kind: "draw_svg", len: svg.length, bytes: png.length, sent: true });
                  logger.info?.(`[onebot] 画了张 SVG 图并发出去（${png.length} 字节）`);
                } else {
                  audit({ kind: "draw_svg_preview", len: svg.length, bytes: png.length });
                  logger.info?.(`[onebot] 画了张 SVG 图（只是预览，没发出去）`);
                }

                return {
                  ok: true,
                  bytes: png.length,
                  sent: wantSend,
                  note: wantSend
                    ? "已经发出去了。图就在上面，你要是看着不对可以直接改 SVG 重画。"
                    : "只是预览，没发出去。看着行就再调一次 send:true，不行就改 SVG。",
                };
              } catch (err) {
                logger.warn?.(`[onebot] SVG 渲染失败：${err?.message ?? err}`);
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );
        try {
          mkdirSync(join(HOME, ".dsh/onebot-bridge/svg-src"), { recursive: true });
        } catch {
          // 忽略
        }
        logger.info?.("[onebot] SVG 画图工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] SVG 工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "draw_image",
            description:
              "用 AI 画一张写实/插画风格的图。气氛到了、或者对方想要图的时候画。" +
              "如果是图表、示意图、简单几何图形，优先用 draw_svg（更准更快）。" +
              "prompt 用英文描述画面。",
            parameters: {
              prompt: { type: "string", description: "英文画面描述，20 词以内" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const sid = String(exec?.agent?.session?.id ?? "");
              const entry = sid ? sessions.bySessionId(sid) : null;
              const target = entry?.lastTarget;
              if (!target) return { ok: false, reason: "没有会话上下文" };
              const prompt = String(args?.prompt ?? "").trim().slice(0, 300);
              if (!prompt) return { ok: false, reason: "prompt 为空" };

              const now = Date.now();
              state.drawTimes = state.drawTimes.filter((t) => now - t < 3600_000);
              const limit = Number(cfg.drawPerHour) || 2;
              if (state.drawTimes.length >= limit) {
                return { ok: false, reason: `本小时画图次数已用完（上限 ${limit}）` };
              }

              try {
                const url =
                  "https://image.pollinations.ai/prompt/" +
                  encodeURIComponent(prompt) +
                  "?width=768&height=768&nologo=true";
                const res = await fetch(url, {
                  signal: AbortSignal.timeout(60000),
                  headers: { "User-Agent": "Mozilla/5.0" },
                });
                if (!res.ok) throw new Error(`生图失败 ${res.status}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length < 1000) throw new Error("返回内容太小");
                state.drawTimes.push(now);
                await client.sendImage(target, await (async () => {
                  const tmp = join(HOME, ".dsh/onebot-bridge/draw.jpg");
                  writeFileSync(tmp, buf);
                  return tmp;
                })());
                audit({ kind: "draw_image", prompt: prompt.slice(0, 120) });
                logger.info?.(`[onebot] 画了张图：${prompt.slice(0, 40)}`);
                return { ok: true, sent: true, remaining: limit - state.drawTimes.length };
              } catch (err) {
                logger.warn?.(`[onebot] 画图失败：${err?.message ?? err}`);
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );
        logger.info?.("[onebot] 画图工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 画图工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "hot_news",
            description:
              "查百度热搜。对方问「最近有什么新鲜事」「今天有什么热点」时用，拿到标题后用自己的话聊，不要逐条念。\n" +
              "注意：news_now 更全（16 个平台，也含百度）——想看微博/知乎/抖音/B站那些用 news_now。" +
              "只想看百度这一个源时用这个也行。",
            parameters: {
              count: { type: "number", description: "返回几条，默认 8，最多 15" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const items = await fetchHotNews(cfg, logger);
              const n = Math.min(15, Math.max(1, Number(args?.count) || 8));
              return { ok: true, count: n, items: (items ?? []).slice(0, n) };
            },
          }),
        );
        logger.info?.("[onebot] 新闻工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 新闻工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "read_forward_more",
            description:
              "展开刚才那条合并转发聊天记录的更多内容（第 6 条起）。" +
              "当这个合集让你感兴趣、想看看后面大家还聊了什么时调用。",
            parameters: {
              count: { type: "number", description: "想看多少条，默认 10，最多 20" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const sid = String(exec?.agent?.session?.id ?? "");
              const entry = sid ? sessions.bySessionId(sid) : null;
              const fw = entry?.lastForward;
              if (!fw?.id) return { ok: false, reason: "当前没有可继续展开的转发" };
              try {
                const res = await client.call("get_forward_msg", { id: fw.id }, 8000);
                const msgs = Array.isArray(res?.messages) ? res.messages : Array.isArray(res) ? res : [];
                const start = 5;
                const count = Math.min(20, Math.max(1, Number(args?.count) || 10));
                const lines = msgs.slice(start, start + count).map((m) => {
                  const name = m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || "某人";
                  const segs2 = Array.isArray(m?.content)
                    ? m.content
                    : Array.isArray(m?.message)
                      ? m.message
                      : [];
                  const t = segs2
                    .filter((x) => x?.type === "text")
                    .map((x) => x?.data?.text ?? "")
                    .join("")
                    .trim();
                  const hasImg = segs2.some((x) => x?.type === "image");
                  if (!t && !hasImg) return "";
                  return `${name}：${t.slice(0, 120)}${hasImg ? "［附图］" : ""}`;
                }).filter(Boolean);
                return {
                  ok: true,
                  total: msgs.length,
                  from: start + 1,
                  shown: lines.length,
                  lines,
                  hasMore: start + lines.length < msgs.length,
                };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
              }
            },
          }),
        );
        logger.info?.("[onebot] 转发展开工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 转发展开工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        const pickEntry = (exec) => {
          const sid = String(exec?.agent?.session?.id ?? "");
          return sid ? sessions.bySessionId(sid) : null;
        };

        const grab = async (u) => {
          const s = String(u || "").trim();
          if (!s) return null;
          return await downloadImage(s, cfg.maxImageBytes || 6000000);
        };

        /** url 直连失败时，用 NapCat 的 get_image 换本地文件兜底 */
        const grabWithFallback = async (url, file) => {
          const a = await grab(url);
          if (a) return a;
          const f = String(file || "").trim();
          if (!f) return null;
          try {
            const r = await client.call("get_image", { file: f }, 15000);
            const p = String(r?.file ?? r?.path ?? r?.data?.file ?? "");
            if (p && existsSync(p)) {
              return { data: readFileSync(p), mediaType: "image/jpeg" };
            }
          } catch {
            // 兜底失败就算了
          }
          return null;
        };

        const keyOfEntry = (entry) => channelKeyOfEntry(entry);

        /**
         * 这个会话里哪些位置有图——带前后文，让她按语境挑，而不是瞎猜"最近一张"。
         * aroundId 给了就只看那条附近 span 条以内。
         */
        const buildImageCandidates = (key, { aroundId = "", limit = 8, span = 15 } = {}) => {
          const rows = readMsgLog(key, 400);
          if (!rows.length) return [];
          const imgIdx = [];
          rows.forEach((r, i) => {
            if (Array.isArray(r.img) && r.img.length) imgIdx.push(i);
          });
          let pick = imgIdx;
          if (aroundId) {
            const at = rows.findIndex((r) => String(r.id) === String(aroundId));
            if (at >= 0) pick = imgIdx.filter((i) => Math.abs(i - at) <= span);
          }
          return pick
            .slice(-Math.max(1, limit))
            .reverse()
            .map((i) => {
              const r = rows[i];
              return {
                id: r.id,
                from: r.n || r.u || "",
                minutesAgo: Math.max(0, Math.round((Date.now() - (Number(r.t) || 0) * 1000) / 60000)),
                text: String(r.x || "").slice(0, 80),
                imgCount: Array.isArray(r.img) ? r.img.length : 0,
                before: String(rows[i - 1]?.x || "").slice(0, 60),
                after: String(rows[i + 1]?.x || "").slice(0, 60),
              };
            });
        };

        const byMessageId = async (id) => {
          const r = await client.call("get_msg", { message_id: Number(id) || id }, 12000);
          const segs = Array.isArray(r?.message)
            ? r.message
            : Array.isArray(r?.data?.message)
            ? r.data.message
            : [];
          const seg = segs.find((x) => x?.type === "image");
          if (!seg) return null;
          return await grabWithFallback(seg.data?.url, seg.data?.file);
        };

        // 长截图：附件准入有单边像素上限（8192），整张递不进去。
        // 用 sharp 竖切成几段，一次只递一段——她想看后面再要下一段。
        let sharpLib = null;
        try {
          const pathMod = await import("node:path");
          const { createRequire } = await import("node:module");
          const candidates = [
            pathMod.join(
              pathMod.dirname(pathMod.dirname(process.execPath)),
              "lib/node_modules/@deepseek-ai/dsh/package.json",
            ),
            "/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json",
          ];
          for (const c of candidates) {
            try {
              sharpLib = createRequire(c)("sharp");
              break;
            } catch {}
          }
        } catch {}
        if (!sharpLib) logger.warn?.("[onebot] 没找到 sharp，长截图切段不可用");

        const MAX_SIDE = 6000;
        const SEG_H = 3000;
        const sliceForView = async (img, part) => {
          if (!sharpLib) return { img, note: "" };
          try {
            const meta = await sharpLib(img.data).metadata();
            const W = Number(meta?.width) || 0;
            const H = Number(meta?.height) || 0;
            if (!W || !H) return { img, note: "" };
            if (Math.max(W, H) <= MAX_SIDE) return { img, note: "" };
            if (H >= W) {
              const total = Math.max(2, Math.min(20, Math.ceil(H / SEG_H)));
              const idx = Math.min(Math.max(1, Number(part) || 1), total);
              const top = Math.round(((idx - 1) * H) / total);
              const height = Math.round(H / total);
              const buf = await sharpLib(img.data)
                .extract({ left: 0, top, width: W, height })
                .resize({ width: MAX_SIDE, withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
              return {
                img: { data: buf, mediaType: "image/jpeg", srcUrl: img.srcUrl },
                note: `\n（这是长图竖切后的第 ${idx}/${total} 段；要看下一段用 look_image({part:${idx + 1}})）`,
              };
            }
            const buf = await sharpLib(img.data)
              .resize({ width: MAX_SIDE, withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();
            return { img: { data: buf, mediaType: "image/jpeg", srcUrl: img.srcUrl }, note: "" };
          } catch (err) {
            logger.warn?.(`[onebot] 长图切段失败：${err?.message ?? err}`);
            return { img, note: "" };
          }
        };

        reg(
          defineTool({
            name: "look_image",
            description:
              "看一张图的真实内容（不是「[图片]」占位）。你在群里旁听时图片只留下来一个占位符，用这个把原图调出来看。\n" +
              "**先定位再挑**：不给 id 时会先返回这个会话里「哪些位置有图」的清单（带前后文），你按语境挑一条再把 id 给我；\n" +
              "给 messageId 而那条本身没图时，也会返回附近有图的位置，而不是替你挑。which=N 才表示直接看第 N 近的一张。\n" +
              "长截图会被自动竖切成几段，一次给一段；想看下面那段就加 part=2、part=3。",
            parameters: {
              which: { type: "number", description: "倒数第几张，1 = 最近一张（默认）" },
              part: { type: "number", description: "长截图看到第几段（默认 1）" },
              url: { type: "string", description: "图片直链（可选）" },
              messageId: { type: "string", description: "消息 id（可选）" },
              imageIndex: { type: "number", description: "这条有多张图时看第几张，默认 1" },
              question: { type: "string", description: "想从图里看什么（可选）" },
            },
            output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
            execute: async (args, exec) => {
              try {
                const entry = pickEntry(exec);
                const key = keyOfEntry(entry);
                const q =
                  String(args?.question || "").trim() ||
                  "这张图是什么？两三句话，只说画面里实际有的东西，别猜。";
                let img = await grab(args?.url);
                let fromNote = "";

                // 指定消息：只有它自己有图才看；没图就把附近有图的位置列出来，让她按语境挑
                if (!img && args?.messageId) {
                  // 统一的取图坐标系（和 save_sticker 共用）
                  const loc = imageLocator.byMessageId(key, args.messageId, Number(args?.imageIndex) || 1);
                  if (loc.ok) {
                    img = await grabWithFallback(loc.raw?.url, loc.raw?.file);
                    if (img) {
                      fromNote = `（图来自 ${loc.from}${loc.total > 1 ? `，这条共 ${loc.total} 张，看的是第 ${loc.index} 张` : ""}）`;
                    } else if (loc.total > 1) {
                      return { ok: false, reason: `这条有 ${loc.total} 张图，第 ${loc.index} 张取不到；换 imageIndex 试试` };
                    }
                  } else {
                    const cand = key ? buildImageCandidates(key, { aroundId: args.messageId }) : [];
                    if (cand.length) {
                      return {
                        ok: false,
                        reason:
                          "这条消息本身没有图。下面这条消息附近有图的位置，按语境挑一个 id 再让我看：",
                        candidates: cand,
                      };
                    }
                    img = await byMessageId(args.messageId);
                  }
                }

                // 没给 id/url：先给位置清单；只有明确 which=N 才直接看第 N 张
                if (!img && !args?.messageId && !args?.url) {
                  const cand = key ? buildImageCandidates(key, { limit: 10 }) : [];
                  const which = Number(args?.which) || 0;
                  if (which > 0 && cand.length) {
                    const target = cand[which - 1];
                    const rec = findMsgInLog(key, target.id);
                    if (rec?.img?.length) {
                      img = await grabWithFallback(rec.img[0]?.url, rec.img[0]?.file);
                      if (img) fromNote = `（第 ${which} 近的一张，#${rec.id}，${rec.n || rec.u} 发的）`;
                    }
                  } else if (cand.length) {
                    return {
                      ok: false,
                      reason: "先看这个会话里哪些位置有图（带前后文），按语境挑一条，把 id 给我：",
                      candidates: cand,
                    };
                  }
                  // 退回内存 imgLog
                  if (!img && entry) {
                    const log = Array.isArray(entry.imgLog) ? entry.imgLog : [];
                    const pick = log[log.length - (which || 1)];
                    if (pick) img = (await grabWithFallback(pick.url, pick.file)) || null;
                  }
                }

                if (!img) {
                  return {
                    ok: false,
                    reason: "没找到可看的图：这个会话最近的记录里没有图片，或者图已经过期；给个 url 也行",
                  };
                }
                const sliced = await sliceForView(img, args?.part);
                const desc = await sessions.describeImage(sliced.img, q);
                if (!desc) return { ok: false, reason: "图拿到了，但没看出内容" };
                audit({ kind: "view_image", desc: String(desc).slice(0, 200) });
                return { ok: true, desc: fromNote + String(desc) + (sliced.note || "") };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err).slice(0, 160) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "list_recent_images",
            description:
              "列出这个会话里**哪些位置有图**：每条带发送人、几分钟前、那条消息的文字，以及它前后各一句，方便按语境判断是哪张。\n" +
              "看到「图×N」但不确定指哪张时，先用它，再拿 id 去 look_image。",
            parameters: { limit: { type: "number", description: "最多列几条（默认 10）" } },
            output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
            execute: async (args, exec) => {
              const entry = pickEntry(exec);
              const key = keyOfEntry(entry);
              const n = Math.min(30, Math.max(1, Number(args?.limit) || 10));
              const items = key ? buildImageCandidates(key, { limit: n }) : [];
              return {
                ok: true,
                count: items.length,
                items,
                note: items.length
                  ? "挑一条，用 look_image({messageId:\"<id>\"}) 看"
                  : "这个会话最近的落盘记录里没有图片",
              };
            },
          }),
        );

        logger.info?.("[onebot] 看图工具已注册（look_image / list_recent_images）");
      } catch (err) {
        logger.warn?.("[onebot] 看图工具注册失败：" + (err?.message ?? err));
      }
    })();
}

export { HOME };
