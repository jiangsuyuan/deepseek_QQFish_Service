import { searchSource, readSource, listSourceFiles, findInSource } from "../store/source-mirror.js";
import { createImageLocator, channelKeyOfEntry } from "../util/image-locate.js";
// 全部工具注册（原 apply() 内的巨型 IIFE）。
// 看头像的限频时间戳（原先引用了一个不存在的变量，导致这个工具一调就抛）
const avatarTimes = [];

export async function registerToolbox(app) {
  const { ACTIVITY_KINDS, ALLOWED_TOOLS, HOME, appendFileSync, audit, cfg, chmodSync, chownSync, client, conversationKey, copyFileSync, crossGroupScope, downloadImage, execFile, findMsgInLog, execFileSync, existsSync, facts, followUps, groupLabel, health, imagePayloadFrom, join, lastStickerPreview, listMsgKeys, loadActivities, loadDigests, loadGroupMeta, loadMemLog, loadReminders, loadSelfState, loadStickerLabels, loadWants, logger, markRuntimeDirty, mkdirSync, nextSelfPlan, patchSelfState, people, pickSticker, pickStickerCandidates, proactiveLocationNote, promisify, readFileSync, readMsgLog, readMsgLogPageMulti, readSelfPlan, readdirSync, refusePerson, renderMsgRec, resolveSticker, runThinkingCycle, saveReminders, saveWants, selfViews, sessions, smartCut, statSync, state, stripToText, unlinkSync, webPush, writeFileSync, pluginCtx: ctx, savedStickerTimes } = app;
  try {
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    const imageLocator = createImageLocator({ findMsgInLog, logger });
            ctx.get?.("tools")?.register?.(
              defineTool({
                name: "send_sticker",
                description:
                  "给当前 QQ 聊天发一张表情包，适合回应情绪、接梗、撒娇。" +
                  "mood 填一个情绪词，常用：开心、大笑、得意、无语、流汗、生气、委屈、哭、害怕、惊讶、" +
                  "疑惑、点赞、加油、拒绝、睡觉、吃饭、工作、摸鱼、打招呼、卖萌、害羞、坏笑、冷漠、" +
                  "敷衍、震惊、鼓励、安慰、嘲讽、疲惫。挑不到对应标签会随机发一张。" +
                "想指定具体某张就填 name（比如 m007，或列表里的序号 7），不填就按 mood 挑；" +
                "不确定有哪些张可以先调 list_stickers 看看。" +
                "quote 看心情：想直接回应对方某句话就设 true（表情带引用），只是想表达心情就不设。",
                parameters: {
                  mood: { type: "string", description: "情绪关键词，随机挑一张时用" },
                  name: { type: "string", description: "指定某张：文件名 m007 或序号 7，填了就不随机" },
                  quote: {
                    type: "boolean",
                    description:
                      "要不要引用对方那条消息。想直接回应某人就填 true；只是气氛到了想发一张就填 false。看你心情。",
                  },
                  preview: {
                    type: "boolean",
                    description:
                      "先看几张再决定时填 true：不发送，只返回 2-3 张候选的画面描述和标签。" +
                      "看完再用 name 指定发哪张。拿不准挑哪张时用这个，省得盲抽一张不搭的。",
                  },
                },
                output: {
                  schema: { type: "json" },
                  render: (_a, v) => {
                    const blocks = [{ type: "text", text: JSON.stringify(v) }];
                    // 预览时把三张图直接拼进工具结果 —— 模型在返回处就能看到画面，
                    // 不用再起一个 agent 去「描述」，也不用她靠标签猜。
                    if (v && v.preview === true && Array.isArray(lastStickerPreview)) {
                      for (const it of lastStickerPreview) {
                        blocks.push({
                          type: "text",
                          text: `▼ ${it.name}　标签：${(it.tags || []).join(" / ") || "无"}`,
                        });
                        blocks.push({ type: "image", attachment: it.ref });
                      }
                    }
                    return blocks;
                  },
                },
                execute: async (args, exec) => {
                  const sid = exec?.agent?.session?.id;
                  const entry = sid ? sessions.bySessionId(String(sid)) : null;
                  const target = entry?.lastTarget;
                  if (!target || (!target.group_id && !target.user_id)) {
                    return { ok: false, reason: "当前没有 QQ 会话上下文" };
                  }
                  const want = String(args?.name ?? "").trim();

                  // 先看几张：把图直接塞进工具结果，她自己看着挑
                  if (args?.preview === true && !want) {
                    const cands = pickStickerCandidates(
                      cfg.stickerDir,
                      String(args?.mood ?? ""),
                      3,
                    );
                    if (!cands.length) return { ok: false, reason: "库里没有可挑的图" };
                    const att = sessions.svc?.("attachments");
                    if (!att?.saveImage) {
                      return { ok: false, reason: "附件服务不可用，看不了图" };
                    }
                    lastStickerPreview = [];
                    for (const c of cands) {
                      try {
                        const buf = readFileSync(c.path);
                        const ref = await att.saveImage({
                          data: buf,
                          mediaType: /\.png$/i.test(c.name) ? "image/png" : "image/jpeg",
                        });
                        lastStickerPreview.push({ name: c.name, tags: c.tags, ref });
                      } catch (err) {
                        return {
                          ok: false,
                          reason: `图读不出来：${String(err?.message ?? err).slice(0, 100)}`,
                        };
                      }
                    }
                    return {
                      ok: true,
                      preview: true,
                      count: lastStickerPreview.length,
                      candidates: lastStickerPreview.map((x) => ({
                        name: x.name,
                        tags: x.tags,
                      })),
                      hint:
                        "图已经在你眼前了（不是标签，是真图）。看完三选一：\n" +
                        "· 有一张合适 → send_sticker({ name: \"文件名\" })\n" +
                        "· 都不合适 → 换个 mood 再 preview，或者干脆不发\n" +
                        "· 只是不想发 → 什么都别做（预览不会发出去）",
                    };
                  }

                  const picked = want
                    ? resolveSticker(cfg.stickerDir, want)
                    : pickSticker(cfg.stickerDir, String(args?.mood ?? ""));
                  if (want && !picked) {
                    return { ok: false, reason: `库里没有「${want}」这张，换个名字或用序号` };
                  }
                  if (!picked) return { ok: false, reason: "表情包目录为空" };
                  await client.sendImage(target, picked.path, {
                    quote: args?.quote === true,
                  });
                  return {
                    ok: true,
                    sent: picked.name,
                    tags: picked.tags,
                    fallback: picked.fallback,
                  };
                },
              }),
            );
            logger.info?.("[onebot] 表情包工具已注册");

          // 列表情库：她想指定发哪张时先看一眼
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "list_stickers",
              description:
                "列出表情包库里的所有表情（序号、文件名、标签）。想指定发某张前先调这个，然后用 send_sticker 的 name 指定。",
              parameters: {
                tag: { type: "string", description: "只看含这个标签的，比如「无语」，可不填" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                try {
                  const files = readdirSync(cfg.stickerDir)
                    .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
                    .sort();
                  const labels = loadStickerLabels(cfg.stickerDir);
                  const key = String(args?.tag ?? "").trim();
                  const items = files
                    .map((f, i) => ({
                      no: i + 1,
                      name: f.replace(/\.[^.]+$/, ""),
                      tags: labels[f] || [],
                    }))
                    .filter((x) => !key || x.tags.some((t) => t.includes(key) || key.includes(t)));
                  return { ok: true, count: items.length, total: files.length, items };
                } catch (e) {
                  return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
                }
              },
            }),
          );
          logger.info?.("[onebot] 表情库清单工具已注册");

          // 存表情：把聊天里看到的图打标签收进库，带容量上限
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "save_sticker",
              description:
                "把刚才聊天里看到的图片存进自己的表情包库，并打标签，以后可以自己发。" +
                "**存之前先看一眼这张图，按你自己的喜好判断：真觉得有意思、以后用得上才存；" +
                "平平无奇、糊、只是普通截图或文字图就别存。**" +
                "标签用逗号分隔，2-3 个，比如「猫,无语,搞笑」。",
              parameters: {
                tags: { type: "string", description: "标签，逗号分隔，2-3 个" },
                which: { type: "number", description: "第几张图，默认第 1 张" },
                messageId: { type: "string", description: "存某一条消息里的图（可选；不给就看这一轮的图）" },
                url: { type: "string", description: "直接给图地址（可选）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const sid = String(exec?.agent?.session?.id ?? "");
                const entry = sid ? sessions.bySessionId(sid) : null;
                // 统一的取图坐标系：url > messageId > 这一轮 > 最近那条
                const located = imageLocator.locate({
                  key: channelKeyOfEntry(entry),
                  entry,
                  messageId: args?.messageId,
                  url: args?.url,
                  which: Number(args?.which) || 1,
                });
                if (!located.ok) return { ok: false, reason: located.reason };
                const raw = located.raw;
                const idx = Math.max(0, (located.index || 1) - 1);
                const url =
                  typeof raw === "string" ? raw : String(raw?.url || raw?.file || "");
                if (!url) return { ok: false, reason: "这条消息里没有第 " + (idx + 1) + " 张图" };

                // 限频：每小时最多存 3 张
                const now = Date.now();
                while (savedStickerTimes.length && now - savedStickerTimes[0] > 3600_000) {
                  savedStickerTimes.shift();
                }
                const perHour = Number(cfg.stickerSavePerHour) || 3;
                if (savedStickerTimes.length >= perHour) {
                  return { ok: false, reason: "这一小时存得够多了，先攒着" };
                }

                // 容量上限
                const dir = join(HOME, ".dsh/onebot-bridge/stickers");
                let files = [];
                try {
                  files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".jpg"));
                } catch {
                  files = [];
                }
                const maxCount = Number(cfg.stickerMaxCount) || 300;
                if (files.length >= maxCount) {
                  return { ok: false, reason: `表情包已经 ${files.length} 张，到上限了` };
                }
                let total = 0;
                try {
                  for (const f of files) {
                    try {
                      total += statSync(join(dir, f)).size;
                    } catch {
                      // 忽略
                    }
                  }
                } catch {
                  // 忽略
                }
                const maxBytes = (Number(cfg.stickerMaxMB) || 30) * 1024 * 1024;
                if (total >= maxBytes) {
                  return { ok: false, reason: "表情包总大小到上限了" };
                }

                try {
                  // 下载（走已有的取图逻辑，失败时用 NapCat 的 get_image 兜底）
                  let buf = null;
                  // 优先用这一轮她看图时的内存副本：QQ 的图 URL 几分钟就过期，重下常失败
                  try {
                    const held = Array.isArray(entry?.currentTurnImageData) ? entry.currentTurnImageData : [];
                    const d0 = held[idx]?.data;
                    if (d0 && Buffer.isBuffer(d0) && d0.length) buf = Buffer.from(d0);
                  } catch {
                    // 忽略
                  }
                  if (!buf || !buf.length) {
                    // 再用 URL / NapCat 的 file 标识取一次
                    const gotOne = await imagePayloadFrom(raw);
                    if (gotOne?.data) buf = Buffer.from(gotOne.data);
                  }
                  if (!buf || !buf.length) {
                    try {
                      const res = await client.call(
                        "get_image",
                        { file: typeof raw === "object" && raw?.file ? String(raw.file) : String(url) },
                        15000,
                      );
                      const b64 = res?.base64 ?? res?.data?.base64;
                      if (b64) buf = Buffer.from(b64, "base64");
                    } catch {
                      // 放弃
                    }
                  }
                  if (!buf || !buf.length) {
                    logger.warn?.(
                      `[onebot] 存表情取图失败：内存副本=${Array.isArray(entry?.currentTurnImageData) ? entry.currentTurnImageData.length : 0} 张，url=${String(url).slice(0, 80)}`,
                    );
                    return { ok: false, reason: "这张图已经过期了，你重发一张我马上存" };
                  }
                  if (buf.length > 2 * 1024 * 1024) return { ok: false, reason: "图太大了（超过 2MB）" };

                  // 统一转 jpg 并压缩
                  let out = buf;
                  let ext = ".jpg";
                  try {
                    const sharpMod = await import(
                      "/opt/node-v24.22.1-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp/dist/index.mjs"
                    );
                    const sharp = sharpMod.default ?? sharpMod;
                    out = await sharp(buf)
                      .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
                      .jpeg({ quality: 82 })
                      .toBuffer();
                  } catch {
                    // 转不了就原样存
                    ext = ".jpg";
                  }

                  // 命名：找当前最大编号 +1
                  let maxNo = 0;
                  for (const f of files) {
                    const m = /^m(\d+)\.jpg$/i.exec(f);
                    if (m) maxNo = Math.max(maxNo, Number(m[1]));
                  }
                  const name = `m${String(maxNo + 1).padStart(3, "0")}${ext}`;
                  writeFileSync(join(dir, name), out);

                  // 更新 labels
                  const labPath = join(dir, "labels.json");
                  let labels = {};
                  try {
                    labels = JSON.parse(readFileSync(labPath, "utf8"));
                  } catch {
                    labels = {};
                  }
                  const tags = String(args?.tags ?? "")
                    .split(/[,，、\s]+/)
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .slice(0, 3);
                  labels[name] = tags.length ? tags : ["未分类"];
                  writeFileSync(labPath, JSON.stringify(labels, null, 1));
                  savedStickerTimes.push(now);

                  logger.info?.(`[onebot] 存了张表情 ${name}：${(labels[name] || []).join("/")}`);
                  audit({ kind: "sticker_save", name, tags: labels[name], bytes: out.length });
                  return { ok: true, name, tags: labels[name], count: files.length + 1 };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
                }
              },
            }),
          );
          logger.info?.("[onebot] 存表情工具已注册");

          // 功能申请：她可以提一次，由创造者决定加不加
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "request_feature",
              description:
                "觉得自己缺某个能力，提一次功能申请给创造者。**一天最多一次**，只有真的卡住才提。" +
                "提之前先想想有没有现有工具能绕过去。\n" +
                "注意：note_want({kind:\"feature\"}) 也能记功能需求，而且**不限次数**——" +
                "只是记下来等创造者看的话用它；真要创造者现在就知道、并且已经卡住你了，才用这个。",
              parameters: {
                idea: { type: "string", description: "你想要的新功能，一句话说清" },
                why: { type: "string", description: "为什么需要它（今天遇到了什么具体情况）" },
                how: { type: "string", description: "你猜大概怎么做（可选，不懂就写不知道）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                if (cfg.featureRequestEnabled === false) {
                  return { ok: false, reason: "创造者关掉了这个通道" };
                }
                const coolHours = Number(cfg.featureRequestCooldownHours) || 24;
                const last = Number(loadSelfState().lastFeatureRequestAt) || 0;
                const since = Date.now() - last;
                if (since < coolHours * 3600_000) {
                  const left = Math.ceil((coolHours * 3600_000 - since) / 3600_000);
                  return { ok: false, reason: `上次申请还在冷却，${left} 小时后再说` };
                }
                const idea = String(args?.idea ?? "").trim().slice(0, 150);
                const why = String(args?.why ?? "").trim().slice(0, 300);
                const how = String(args?.how ?? "").trim().slice(0, 300);
                if (!idea) return { ok: false, reason: "得先说想要什么" };
                patchSelfState({ lastFeatureRequestAt: Date.now() });
                markRuntimeDirty();
                const msg =
                  `【她提了个功能申请】\n` +
                  `想要：${idea}\n` +
                  (why ? `原因：${why}\n` : "") +
                  (how ? `她猜的做法：${how}\n` : "") +
                  `\n---\n同意就回「批准这个功能」，不加就回「算了」。\n（真正加功能还得改代码：要么你自己来，要么找开发者）`;
                try {
                  await client.sendPrivate(cfg.ownerId, msg);
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 100) };
                }
                logger.info?.(`[onebot] 收到功能申请：${idea}`);
                audit({ kind: "feature_request", idea, why, how });
                return { ok: true, note: "已经发给创造者了，等他判断" };
              },
            }),
          );
          logger.info?.("[onebot] 功能申请工具已注册");

          // 让她能查自己的掉线记录
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_outages",
              description:
                "查自己最近 24 小时的掉线记录。有人问「你怎么不说话」「刚才去哪了」、" +
                "或者你自己不确定是不是断过线时，用它确认一下，别硬编理由。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                const now = Date.now();
                const recent = state.outages.filter((o) => now - o.upAt < 24 * 3600_000);
                if (!recent.length) {
                  return {
                    ok: true,
                    count: 0,
                    recentlyDown: state.outageDownAt > 0,
                    note:
                      state.outageDownAt > 0
                        ? "你此刻正在掉线中（还没恢复），所以历史记录里没有它"
                        : "最近 24 小时没有掉线记录",
                  };
                }
                const fmt = (x) =>
                  `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
                const items = recent.slice(-10).map((o) => ({
                  from: fmt(new Date(o.downAt)),
                  to: fmt(new Date(o.upAt)),
                  minutes: o.minutes,
                }));
                // 当前这次还没恢复的掉线，也要能看到
                if (state.outageDownAt > 0) {
                  const mins = Math.max(1, Math.round((Date.now() - state.outageDownAt) / 60000));
                  items.push({
                    from: fmt(new Date(state.outageDownAt)),
                    to: "现在",
                    minutes: mins,
                    ongoing: true,
                  });
                }
                const totalMin = items.reduce((a, b) => a + b.minutes, 0);
                audit({ kind: "check_outages", count: items.length, ongoing: state.outageDownAt > 0 });
                return {
                  ok: true,
                  count: items.length,
                  totalMinutes: totalMin,
                  recentlyDown: state.outageDownAt > 0,
                  items,
                };
              },
            }),
          );
          logger.info?.("[onebot] 掉线查询工具已注册");

          // ── 一组「了解自己」的小工具：她想查什么就查什么 ──
          const TOOL_OUT = {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          };

          // 1. 我现在什么状态
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_status",
              description:
                "查你自己现在的状态：在线多久、今天掉线几次、今天回了多少条、记忆里有多少东西、和谁最熟。",
              parameters: {},
              output: TOOL_OUT,
              execute: async () => {
                people.load();
                const now = Date.now();
                const today = new Date().toDateString();
                const todayReplies = (() => {
                  try {
                    const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/audit.log"), "utf8");
                    let c = 0;
                    for (const line of raw.split("\n")) {
                      if (!line.includes('"kind":"reply"')) continue;
                      try {
                        const e = JSON.parse(line);
                        if (new Date(e.ts).toDateString() === today) c += 1;
                      } catch {
                        // 忽略
                      }
                    }
                    return c;
                  } catch {
                    return 0;
                  }
                })();
                const closest = Object.entries(people.data)
                  .map(([id, r]) => ({ id, name: r.name || id, count: Number(r.count ?? 0) }))
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 5);
                const st = loadSelfState();
                const nextAt = Number(st.selfActivityNextAt) || 0;
                return {
                  ok: true,
                  uptimeMinutes: Math.round((now - health.restartedAt) / 60000),
                  nextActivity:
                    nextAt > now ? `约 ${Math.round((nextAt - now) / 60000)} 分钟后` : "时间已过，下次唤醒会动",
                  outagesToday: state.outages.filter((o) => new Date(o.upAt).toDateString() === today).length,
                  todayReplies,
                  memory: {
                    people: Object.keys(people.data).length,
                    facts: facts.data.length,
                    views: selfViews.data.length,
                    reflections: selfViews.reflections.length,
                    learnings: (() => {
                      try {
                        const d = JSON.parse(
                          readFileSync(join(HOME, ".dsh/onebot-bridge/learnings.json"), "utf8"),
                        );
                        return Array.isArray(d) ? d.length : 0;
                      } catch {
                        return 0;
                      }
                    })(),
                  },
                  closest,
                };
              },
            }),
          );

          // 2. 我记住了什么
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_memory",
              description:
                "翻你**记下来的东西**：人物、事实、观点、回看、学到的、本子。" +
                "**这些是提炼过的条目（摘要），不是聊天原文**——" +
                "所以「只剩个壳」「本子里只有两天」说的都是它，不是没记录。" +
                "\n\n**要翻「当时到底怎么说的」用 recall，不是这个。**" +
                "这个查的是「我记下了什么」，recall 查的是「谁在哪天说了什么」。\n" +
                "type 可选 people/facts/views/reflections/learnings/all/notebook。" +
                "query 可选关键词；all 模式跨所有存储搜并标注来源。",
              parameters: {
                type: {
                  type: "string",
                  description: "people / facts / views / reflections / learnings / all / notebook",
                },
                query: { type: "string", description: "关键词，可不填" },
                limit: { type: "number", description: "all 模式下这一页几条，默认 20" },
                offset: { type: "number", description: "all 模式下从第几条开始（翻页用）" },
              },
              output: TOOL_OUT,
              execute: async (args, exec) => {
                const type = String(args?.type ?? "facts").toLowerCase();
                const q = String(args?.query ?? "").trim();
                const hit = (t) => !q || String(t).includes(q);
                // 先加载，否则读到的永远是空数组
                try {
                  people.load?.();
                  facts.load?.();
                  selfViews.load?.();
                } catch {
                  // 忽略
                }
                // 全都搜：跨 facts / views / reflections / learnings / notebook / 记忆流水
                if (type === "all" || type === "search") {
                  const results = [];
                  const push = (source, text, at, id) => {
                    if (!text) return;
                    if (q && !String(text).includes(q)) return;
                    const row = { source, text: String(text).slice(0, 300), at: at || 0 };
                    // 证据 id：P0/P1 沉淀要贴原文片段，id 形如 mem:<at> / act:<at>
                    if (id) row.id = id;
                    results.push(row);
                  };
                  // 事实
                  try {
                    facts.load?.();
                    for (const f of facts.data || []) push("事实", f.text, f.at);
                  } catch {}
                  // 观点 + 反思
                  try {
                    selfViews.load?.();
                    for (const v of selfViews.data || []) push("观点", v.text, v.at);
                    for (const r of selfViews.reflections || []) push("反思", r.text, r.at, "mem:" + r.at);
                  } catch {}
                  // 学到的
                  try {
                    const arr = JSON.parse(readFileSync(join(HOME, ".dsh/onebot-bridge/learnings.json"), "utf8"));
                    for (const l of Array.isArray(arr) ? arr : [])
                      push("见闻", `${l.topic || ""}：${l.summary || ""}`, l.at);
                  } catch {}
                  // 本子
                  try {
                    for (const f of readdirSync(NOTEBOOK_DIR).filter((x) => x.endsWith(".md"))) {
                      const txt = readFileSync(join(NOTEBOOK_DIR, f), "utf8");
                      if (!q || txt.includes(q)) push("本子", `${f}\n${txt}`, 0);
                    }
                  } catch {}
                  // 记忆流水（按行搜）
                  try {
                    const log = readFileSync(join(HOME, ".dsh/onebot-bridge/memory-log.jsonl"), "utf8");
                    for (const line of log.split("\n")) {
                      if (!line.trim()) continue;
                      if (q && !line.includes(q)) continue;
                      try {
                        const o = JSON.parse(line);
                        push("记忆流水", o.text || o.summary || line.slice(0, 200), o.at);
                      } catch {
                        push("记忆流水", line.slice(0, 200), 0);
                      }
                    }
                  } catch {}
                  results.sort((a, b) => (b.at || 0) - (a.at || 0));
                  const lim = Math.max(1, Math.min(40, Number(args?.limit) || 20));
                  const offset = Math.max(0, Number(args?.offset) || 0);
                  const page = results.slice(offset, offset + lim);
                  return {
                    ok: true,
                    type: "all",
                    query: q,
                    total: results.length,
                    offset,
                    shown: page.length,
                    hasMore: offset + page.length < results.length,
                    nextOffset: offset + page.length < results.length ? offset + page.length : 0,
                    items: page,
                  };
                }

                // 只看本子
                if (type === "notebook") {
                  try {
                    const files = readdirSync(NOTEBOOK_DIR)
                      .filter((x) => x.endsWith(".md"))
                      .sort()
                      .slice(-7);
                    const items = files
                      .map((f) => ({ file: f, text: readFileSync(join(NOTEBOOK_DIR, f), "utf8") }))
                      .filter((x) => !q || x.text.includes(q));
                    return { ok: true, type, count: items.length, items };
                  } catch {
                    return { ok: true, type, count: 0, items: [], note: "本子还是空的" };
                  }
                }

                if (type === "people") {
                  people.load();
                  const list = Object.entries(people.data)
                    .filter(([, r]) => hit(r.name || "") || (r.notes || []).some(hit))
                    .map(([id, r]) => ({ id, name: r.name || id, count: r.count ?? 0, notes: (r.notes || []).slice(-3) }))
                    .slice(0, 10);
                  return { ok: true, type, count: list.length, items: list };
                }
                if (type === "facts") {
                  facts.load?.();
                  const items = (facts.data || [])
                    .filter((f) => hit(f.text))
                    .slice(-15)
                    .map((f) => f.text);
                  return { ok: true, type, count: items.length, items };
                }
                if (type === "views") {
                  selfViews.load?.();
                  const items = (selfViews.data || [])
                    .filter((v) => hit(v.text))
                    .slice(-15)
                    .map((v) => v.text);
                  return { ok: true, type, count: items.length, items };
                }
                if (type === "reflections") {
                  selfViews.load?.();
                  const items = (selfViews.reflections || [])
                    .filter((r) => hit(r.text))
                    .slice(-10)
                    .map((r) => r.text);
                  return { ok: true, type, count: items.length, items };
                }
                if (type === "learnings") {
                  try {
                    const arr = JSON.parse(
                      readFileSync(join(HOME, ".dsh/onebot-bridge/learnings.json"), "utf8"),
                    );
                    const items = (Array.isArray(arr) ? arr : [])
                      .filter((l) => hit(l.topic || "") || hit(l.summary || ""))
                      .slice(-10)
                      .map((l) => ({ topic: l.topic, summary: l.summary }));
                    return { ok: true, type, count: items.length, items };
                  } catch {
                    return { ok: true, type, count: 0, items: [] };
                  }
                }
                return { ok: false, reason: "type 只能是 people/facts/views/reflections/learnings" };
              },
            }),
          );

          // 3. 这个人是谁
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "person_dossier",
              description:
                "看某人的档案：聊过几次 / 活跃时段 / 在哪些群 / 聊过什么话题。" +
                "**这是统计摘要，不是聊天原文**——想知道「他当时具体说了什么」，用 recall（person 填他）。\n" +
                "参数 id 填 QQ 号或名字。",
              parameters: { qq: { type: "string", description: "对方 QQ 号" } },
              output: TOOL_OUT,
              execute: async (args, exec) => {
                people.load();
                const id = String(args?.qq ?? "").trim();
                const r = people.data[id];
                if (!r) return { ok: false, reason: `没有 ${id} 的记录` };
                const groups = (r.groups || []).map((g) => groupLabel(g));
                const recent = [];
                for (const [gid, arr] of Object.entries(r.recentByGroup || {})) {
                  for (const it of arr) recent.push({ group: groupLabel(gid), text: it.text, at: it.at });
                }
                recent.sort((a, b) => b.at - a.at);
                // 再给几条**原话**（从落盘记录里找他说过的），省得她再去 recall 翻
                const quotes = [];
                try {
                  for (const key of listMsgKeys()) {
                    for (const r of readMsgLog(key, 1200)) {
                      if (String(r.u) !== id) continue;
                      if (!String(r.x || "").trim()) continue;
                      quotes.push({
                        where: key.startsWith("private:") ? "私聊" : "群 " + key.slice(6),
                        at: Number(r.t) || 0,
                        text: String(r.x).slice(0, 120),
                        id: r.id,
                      });
                    }
                  }
                } catch {
                  // 没有落盘记录就只给统计
                }
                quotes.sort((a, b) => b.at - a.at);
                return {
                  ok: true,
                  qq: id,
                  name: r.name || id,
                  quoteCount: quotes.length,
                  recentQuotes: quotes.slice(0, 8).map((x) => ({
                    where: x.where,
                    when: new Date(x.at * 1000).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                    what: x.text,
                    id: x.id,
                  })),
                  address: r.address || "",
                  count: r.count ?? 0,
                  groups,
                  groupCount: groups.length,
                  notes: (r.notes || []).slice(-5),
                  recentSaid: recent.slice(0, 8).map((x) => ({
                    where: x.group,
                    when: new Date(x.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
                    what: x.text,
                  })),
                };
              },
            }),
          );

          // 4. 这个群最近在聊什么
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "group_recap",
              description: "查某个群最近的话题和主要在聊什么。",
              parameters: { gid: { type: "string", description: "群号" } },
              output: TOOL_OUT,
              execute: async (args, exec) => {
                const gid = String(args?.gid ?? "").trim();
                const key = `group:${gid}`;
                const ent = sessions.entries.get(key);
                if (!ent) return { ok: false, reason: `没有群 ${gid} 的会话记录` };
                const win = ent.topicWindow ?? [];
                const cnt = new Map();
                for (const it of win) for (const w of it.w || []) cnt.set(w, (cnt.get(w) ?? 0) + 1);
                const topics = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
                const obs = (ent.observations ?? []).slice(-6);
                // 摘要之外再给几条原话和 id，想看细节可以直接接着查
                const rawRows = readMsgLog(key, 200);
                const scope = crossGroupScope(gid, exec);
                return {
                  ok: true,
                  group: groupLabel(gid),
                  lastActive: ent.lastMessageAt
                    ? new Date(ent.lastMessageAt).toLocaleString("zh-CN")
                    : "未知",
                  topics,
                  recent: obs,
                  rawTotal: rawRows.length,
                  rawRecent: rawRows.slice(-6).map((r) => ({
                    id: r.id,
                    line: `[群 ${gid}] ${renderMsgRec(r)}`,
                  })),
                  note: [
                    rawRows.length ? "想看更多原话用 group_patrol（支持 before 游标）" : "",
                    scope,
                  ]
                    .filter(Boolean)
                    .join(" "),
                };
              },
            }),
          );

          // 5. 谁说过 X
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "who_said",
              description:
                "跨群搜：谁在哪个群说过某个词。先查**落盘原文**（旁听也算），找不到再看各群的发言摘要。" +
                "想找「这话是谁说的」「哪个群聊过这个」时用。",
              parameters: { word: { type: "string", description: "要搜的词" } },
              output: TOOL_OUT,
              execute: async (args, exec) => {
                const w = String(args?.word ?? "").trim();
                if (!w) return { ok: false, reason: "要搜什么词？" };
                const low = w.toLowerCase();
                const hits = [];
                // 1) 落盘原文（覆盖面最大）
                for (const key of listMsgKeys()) {
                  for (const r of readMsgLog(key, 3000)) {
                    if (!String(r.x || "").toLowerCase().includes(low)) continue;
                    hits.push({
                      t: Number(r.t) || 0,
                      who: r.n || r.u,
                      qq: r.u,
                      where: key.startsWith("private:") ? "私聊 " + key.slice(8) : "群 " + key.slice(6),
                      when: new Date((Number(r.t) || 0) * 1000).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                      what: String(r.x || "").slice(0, 120),
                      id: r.id,
                      source: "原文",
                    });
                  }
                }
                // 2) 摘要兜底
                if (hits.length < 5) {
                  try {
                    people.load();
                    for (const [id, r] of Object.entries(people.data)) {
                      for (const [gid, arr] of Object.entries(r.recentByGroup || {})) {
                        for (const it of Array.isArray(arr) ? arr : []) {
                          if (!String(it?.text || "").includes(w)) continue;
                          if (hits.some((h) => h.what === String(it.text).slice(0, 120))) continue;
                          hits.push({
                            t: Number(it.at) || 0,
                            who: r.name || id,
                            qq: id,
                            where: groupLabel(gid),
                            when: new Date(it.at).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            }),
                            what: String(it.text).slice(0, 120),
                            source: "摘要",
                          });
                        }
                      }
                    }
                  } catch {
                    // 摘要兜底失败不影响
                  }
                }
                hits.sort((a, b) => b.t - a.t);
                return {
                  ok: true,
                  word: w,
                  total: hits.length,
                  shown: Math.min(20, hits.length),
                  hasMore: hits.length > 20,
                  hits: hits.slice(0, 20),
                  note: [
                    hits.length ? `共 ${hits.length} 处，先给最近 20 条` : "没找到，换个词或去掉修饰试试",
                    proactiveLocationNote(exec),
                  ]
                    .filter(Boolean)
                    .join(" "),
                };
              },
            }),
          );
          logger.info?.("[onebot] 自我认知工具已注册（status/memory/dossier/recap/who_said）");

          // 看头像：有兴趣的时候瞄一眼别人头像长什么样
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "view_avatar",
              description:
                "看一眼某人的 QQ 头像长什么样。有兴趣、想接梗、或者想知道对方是什么风格时用。" +
                "（每次会花一点算力，自己掂量。）",
              parameters: {
                qq: { type: "string", description: "对方 QQ 号" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const qq = String(args?.qq ?? "").trim();
                if (!/^\d{5,12}$/.test(qq)) return { ok: false, reason: "QQ 号不对" };
                // 限频：每小时最多 3 次
                const now = Date.now();
                while (avatarTimes.length && now - avatarTimes[0] > 3600_000) avatarTimes.shift();
                if (avatarTimes.length >= (Number(cfg.avatarPeekPerHour) || 3)) {
                  return { ok: false, reason: "这一小时看够了，先干正事" };
                }
                const url = `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
                const img = await downloadImage(url, 2 * 1024 * 1024);
                if (!img) return { ok: false, reason: "头像下载失败" };
                avatarTimes.push(now);
                const sid = String(exec?.agent?.session?.id ?? "");
                const entry = sid ? sessions.bySessionId(sid) : null;
                const who =
                  (() => {
                    try {
                      people.load();
                      return people.data[qq]?.name || qq;
                    } catch {
                      return qq;
                    }
                  })();
                const desc = await sessions.describeImage(
                  img,
                  `这是 QQ 用户「${who}」的头像。用一两句话描述画面内容（画的是什么、什么风格、什么颜色），` +
                    "像随口说一句，不要分析、不要评价。",
                );
                if (!desc) return { ok: false, reason: "看了但没看明白" };
                audit({ kind: "view_avatar", qq, desc: desc.slice(0, 200) });
                return { ok: true, who, avatar: desc };
              },
            }),
          );
          logger.info?.("[onebot] 看头像工具已注册");

          // 看她自己的更新日志
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_changelog",
              description:
                "看你自己的更新日志（这个项目每个版本改了什么）。有人问你「你最近更新了什么」「你会什么新功能」时用它。",
              parameters: {
                version: { type: "string", description: "版本号，比如 1.1.5；不填返回最近的几个版本" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const path = join(HOME, ".dsh/onebot-bridge/CHANGELOG.md");
                let text = "";
                try {
                  text = readFileSync(path, "utf8");
                } catch {
                  try {
                    text = readFileSync(join(HERE, "CHANGELOG.md"), "utf8");
                  } catch {
                    return { ok: false, reason: "更新日志不在服务器上" };
                  }
                }
                const want = String(args?.version ?? "").trim();
                const blocks = text.split(/^## /m).filter(Boolean);
                if (want) {
                  const hit = blocks.find((b) => b.startsWith(want));
                  if (!hit) return { ok: false, reason: `没有 ${want} 这个版本` };
                  return { ok: true, version: want, content: ("## " + hit).slice(0, 2500) };
                }
                const latest = blocks.slice(0, 3).map((b) => {
                  const title = b.split("\n")[0].trim();
                  return { version: title, content: ("## " + b).slice(0, 1200) };
                });
                return { ok: true, count: blocks.length, versions: latest };
              },
            }),
          );

          // 看她自己的源码（按函数名搜，不给她全文——太长）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_source",
              description:
                "看源码里某个函数/关键词是怎么实现的，跨全部文件搜，只返回匹配片段（带 file:line）。有人问「你怎么做到的」时用。\n" +
                "注意：read_source 更全（能按行号看、命中更多、每段行数可调），要精确定位某一段时用 read_source。",
              parameters: {
                keyword: { type: "string", description: "函数名或关键词，比如 window_handoff、humanizePunct" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const kw = String(args?.keyword ?? "").trim();
                if (kw.length < 3) return { ok: false, reason: "关键词至少 3 个字" };
                const hits = searchSource(kw, 3);
                if (!hits.length) return { ok: false, reason: `源码里没找到「${kw}」` };
                audit({ kind: "read_source", keyword: kw, hits: hits.length });
                return {
                  ok: true,
                  keyword: kw,
                  totalHits: hits.length,
                  snippets: hits.map((h) => ({ file: h.file, line: h.line, code: h.code })),
                };
              },
            }),
          );
          logger.info?.("[onebot] 自我查看工具已注册（changelog/source）");

          // 翻自己的探险日志：我去过哪儿、当时怎么想的
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_adventures",
              description:
                "翻自己出门走过的地方（每次自主探索的完整记录：看了什么、为什么往那儿走、当时想到什么）。" +
                "有人问「最近在忙什么」「有什么新发现」时用。\n" +
                "注意：my_activities 有全部活动（探险只是其中一类，还有读书/玩/思考/写）——" +
                "只想看探险用这个，想看完整日志用 my_activities。",
              parameters: {
                limit: { type: "number", description: "返回几条，默认 5" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                let lines = [];
                try {
                  const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/explore-log.jsonl"), "utf8");
                  lines = raw.split("\n").filter(Boolean);
                } catch {
                  return { ok: true, count: 0, note: "还没出去走过" };
                }
                const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
                const items = [];
                for (const line of lines.slice(-limit).reverse()) {
                  try {
                    const e = JSON.parse(line);
                    items.push({
                      when: new Date(e.at).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                      topic: e.topic,
                      stops: (e.stops || []).slice(0, 4),
                      saw: String(e.summary || "").slice(0, 200),
                      thought: String(e.thought || "").slice(0, 160),
                    });
                  } catch {
                    // 忽略
                  }
                }
                return { ok: true, count: items.length, total: lines.length, items };
              },
            }),
          );
          logger.info?.("[onebot] 探险日志工具已注册");

          // 看这几天的经历摘要
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_digest",
              description:
                "看你这几天的经历摘要（不是逐条记录，是压缩后的「我最近经历了什么」）。" +
                "有人问「最近怎么样」「这段时间干嘛了」，或者你自己想理一理时用。",
              parameters: { days: { type: "number", description: "看最近几天，默认 7" } },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const days = Math.max(1, Math.min(30, Number(args?.days) || 7));
                const ds = loadDigests();
                if (!ds.length) return { ok: true, count: 0, note: "还没有摘要（记忆攒够 20 条会生成）" };
                const cutoff = Date.now() - days * 86400_000;
                const items = ds
                  .filter((d) => d.to >= cutoff)
                  .map((d) => ({
                    when: new Date(d.to).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit" }),
                    from: new Date(d.from).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit" }),
                    count: d.count,
                    text: d.text,
                  }));
                return { ok: true, count: items.length, days, items };
              },
            }),
          );

          // 记忆总索引：按主题/按时间
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "memory_index",
              description:
                "你的记忆总目录：按主题列出都记过什么、按时间看每天记了几条。" +
                "想「我都记了什么」「有没有记过某方面」时用。",
              parameters: {
                mode: { type: "string", description: "topic（按主题）/ day（按天）/ kind（按类型）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const mode = String(args?.mode ?? "topic").toLowerCase();
                const mems = loadMemLog(Math.min(5000, Math.max(50, Number(args?.limit) || 500)));
                if (!mems.length) return { ok: true, count: 0, note: "记忆日志还是空的" };
                if (mode === "day") {
                  const byDay = {};
                  for (const m of mems) {
                    const d = new Date(m.at).toLocaleDateString("zh-CN");
                    byDay[d] = (byDay[d] || 0) + 1;
                  }
                  const all = Object.entries(byDay);
                  const keepDays = Math.min(120, Math.max(1, Number(args?.days) || 10));
                  return { ok: true, mode, total: mems.length, dayCount: all.length, days: all.slice(-keepDays) };
                }
                if (mode === "kind") {
                  const byKind = {};
                  for (const m of mems) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
                  return { ok: true, mode, total: mems.length, kinds: byKind };
                }
                const byTopic = {};
                for (const m of mems) {
                  const t = String(m.topic || "").trim() || "（没主题）";
                  byTopic[t] = byTopic[t] || [];
                  if (byTopic[t].length < 5) byTopic[t].push(String(m.text || "").slice(0, 50));
                }
                const sorted = Object.entries(byTopic).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
                return {
                  ok: true,
                  mode,
                  total: mems.length,
                  topics: sorted.map(([t, list]) => ({ topic: t, count: list.length, sample: list.slice(0, 2) })),
                };
              },
            }),
          );
          logger.info?.("[onebot] 记忆索引工具已注册（my_digest/memory_index）");

          // ── 沙箱代码能力：能在里面折腾，威胁不到本体和记忆 ──
          const runCodeTimes = [];
          const BANNED_CODE = [
            /\/root\//,
            /\.\.\//,
            /chmod|chown|rm\s+-rf/,
            /import\s+socket|from\s+socket/,
            /subprocess|os\.system|os\.popen/,
          ];

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "exec_sandbox",
              description:
                "在自己的沙箱里跑代码。可以算数、统计、处理文本、画图（matplotlib）、写小游戏、" +
                "联网抓东西（curl / requests 都行）。" +
                "沙箱是降权的（sandbox 用户），碰不到你的记忆和源码（那些是只读的）；不限时，但 CPU 时间有上限。" +
                "language 填 python 或 javascript；输出最多 4000 字。\n" +
                "工作目录是 /var/lib/fish-desk，写出来的文件会留在那儿——**那地方你自己能删能改**，" +
                "只想临时用就随便放，想长期留着就挪到文件区（note_file），那边删不掉。",
              parameters: {
                language: { type: "string", description: "python 或 javascript" },
                code: { type: "string", description: "要跑的代码" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const lang = String(args?.language ?? "python").toLowerCase();
                const code = String(args?.code ?? "");
                if (!code.trim()) return { ok: false, reason: "代码是空的" };
                if (code.length > 8000) return { ok: false, reason: "代码太长（最多 8000 字）" };
                // 静态检查
                for (const re of BANNED_CODE) {
                  if (re.test(code)) {
                    audit({ kind: "run_code_blocked", pattern: String(re), code: code.slice(0, 200) });
                    return { ok: false, reason: `这段代码里有个不该有的东西（${re}），沙箱不让它跑` };
                  }
                }
                // 限频
                const now = Date.now();
                while (runCodeTimes.length && now - runCodeTimes[0] > 3600_000) runCodeTimes.shift();
                if (runCodeTimes.length >= (Number(cfg.runCodePerHour) || 20)) {
                  return { ok: false, reason: "这一小时跑得够多了，先歇歇" };
                }
                runCodeTimes.push(now);

                const dir = "/var/lib/fish-desk";
                let runFile = "";
                try {
                  mkdirSync(dir, { recursive: true });
                  runFile = join(dir, `.run-${Date.now()}.${lang === "javascript" ? "js" : "py"}`);
                  const file = runFile.split("/").pop();
                  writeFileSync(runFile, code);
                  // 让 sandbox 用户能读
                  try {
                    execFileSync("chown", ["-R", "sandbox:sandbox", dir], { timeout: 5000 });
                  } catch {
                    // 忽略
                  }
                  const runner = lang === "javascript" ? ["node", file] : ["python3", file];
                  // 能联网了（去掉 unshare -n）、不限时（去掉 timeout）。
                  // 仍然降权到 sandbox 用户；用 ulimit 兜底，防止一个死循环把整台机器拖住。
                  const cpuSec = Math.max(60, Number(cfg.runCodeCpuSec) || 900);
                  const runnerCmd = runner.map((x) => JSON.stringify(x)).join(" ");
                  const cmd = "sudo";
                  const cmdArgs = [
                    "-u",
                    "sandbox",
                    "-n",
                    "bash",
                    "-c",
                    `ulimit -t ${cpuSec}; exec ${runnerCmd}`,
                  ];
                  const { stdout, stderr } = await promisify(execFile)(cmd, cmdArgs, {
                    cwd: dir,
                    timeout: 0, // 不限时；靠 ulimit -t 兜底
                    maxBuffer: 4 * 1024 * 1024,
                    env: {
                      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                      HOME: dir,
                      LANG: "C.UTF-8",
                      // 给联网一点基本配置
                      http_proxy: "",
                      https_proxy: "",
                      no_proxy: "127.0.0.1,localhost",
                    },
                  });
                  audit({ kind: "run_code", lang, ok: true, ms: Date.now() - now });
                  return {
                    ok: true,
                    stdout: String(stdout || "").slice(0, 20000),
                      stderr: String(stderr || "").slice(0, 5000),
                  };
                } catch (err) {
                  audit({ kind: "run_code", lang, ok: false, ms: Date.now() - now });
                  return {
                    ok: false,
                    reason: String(err?.message ?? err).slice(0, 300),
                    stdout: String(err?.stdout ?? "").slice(0, 20000),
                      stderr: String(err?.stderr ?? "").slice(0, 5000),
                  };
                } finally {
                  try {
                    if (runFile) execFileSync("rm", ["-f", runFile], { timeout: 5000 });
                  } catch {
                    // 忽略
                  }
                }
              },
            }),
          );

          // 读自己的源码（只读副本，改不了）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_source",
              description:
                "看自己的源码。代码分在 index.js 和 src/ 下，按关键词搜会跨全部文件搜，命中会告诉你 file:line。\n" +
                "也可以指定 file + start + count 按行号看一段。源码是只读副本，你只能看不能改。\n" +
                "这是看代码的主力工具；my_source 是它的旧版，功能更少。",
              parameters: {
                keyword: { type: "string", description: "要搜的关键词或函数名（跨全部文件搜）" },
                file: { type: "string", description: "按行号看时指定文件，如 src/features/chat.js；省略则看 index.js" },
                start: { type: "number", description: "起始行号（配合 count，需要 file）" },
                count: { type: "number", description: "看多少行，默认 40" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const kw = String(args?.keyword ?? "").trim();
                if (kw) {
                  const hits = searchSource(kw, 5);
                  if (!hits.length) return { ok: false, reason: `源码里没找到「${kw}」` };
                  return {
                    ok: true,
                    files: listSourceFiles().length,
                    hits,
                  };
                }
                // 按行号看：必须指定文件（默认入口）
                const file = String(args?.file ?? "index.js").trim() || "index.js";
                let lines;
                try {
                  lines = readSource(file).split("\n");
                } catch {
                  return { ok: false, reason: `读不到 ${file}。可用文件：${listSourceFiles().slice(0, 12).join(", ")} …` };
                }
                const start = Math.max(1, Number(args?.start) || 1);
                const count = Math.max(1, Math.min(200, Number(args?.count) || 40));
                const numbered = lines
                  .slice(start - 1, start - 1 + count)
                  .map((l, k) => `${start + k}: ${l}`)
                  .join("\n");
                return {
                  ok: true,
                  file,
                  totalLines: lines.length,
                  from: start,
                  code: numbered.slice(0, 40000),
                };
              },
            }),
          );
          logger.info?.("[onebot] 沙箱工具已注册（exec_sandbox/read_source）");

          // 需求记事本：想要什么随手记，创造者有空再看
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "note_want",
              description:
                "把「我想要什么」记进记事本：感兴趣的网站要账号、缺的功能、想看的书/番…" +
                "随时可以记，不占额度，不限次数。创造者有空会看，恢复联络时会一起报给他。\n" +
                "kind 填 account（要账号）/ feature（要功能）/ other（其它）。\n" +
                "跟 request_feature 的区别：这个只是**记下来**等创造者看；request_feature 是**现在就通知他**且一天只能一次。",
              parameters: {
                kind: { type: "string", description: "account / feature / other" },
                what: { type: "string", description: "想要什么，一句话" },
                why: { type: "string", description: "为什么想要（遇到了什么具体场景）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const kind = String(args?.kind ?? "other").toLowerCase();
                const what = String(args?.what ?? "").trim().slice(0, 150);
                const why = String(args?.why ?? "").trim().slice(0, 1500);
                if (!what) return { ok: false, reason: "得先说想要什么" };
                const wants = loadWants();
                // 同一件事别重复记
                if (wants.some((w) => w.status === "pending" && w.what === what)) {
                  return { ok: true, note: "这条已经记过了，等创造者看" };
                }
                wants.push({
                  id: Date.now().toString(36),
                  at: Date.now(),
                  kind: ["account", "feature", "other"].includes(kind) ? kind : "other",
                  what,
                  why,
                  status: "pending",
                });
                saveWants(wants);
                const pend = wants.filter((w) => w.status === "pending").length;
                logger.info?.(`[onebot] 记了个需求（${kind}）：${what}`);
                audit({ kind: "want", wantKind: kind, what, why });
                return {
                  ok: true,
                  note: `记下了。现在本子上有 ${pend} 条待处理，创造者有空会看。`,
                };
              },
            }),
          );

          // 翻自己的需求记事本
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_wants",
              description: "看你自己的需求记事本：记了哪些想要的、哪些已经被批了。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                const wants = loadWants();
                if (!wants.length) return { ok: true, count: 0, note: "记事本还是空的" };
                const pend = wants.filter((w) => w.status === "pending");
                return {
                  ok: true,
                  count: wants.length,
                  pending: pend.length,
                  hint:
                    pend.length > 0
                      ? "待处理的有序号，可用 resolve_want / drop_want 按序号调整。真的试过能用了再标已满足。"
                      : "没有待处理的了",
                  items: wants.slice(-20).map((w) => ({
                    kind: w.kind,
                    what: w.what,
                    why: String(w.why || "").slice(0, 80),
                    status: w.status,
                    when: new Date(w.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit" }),
                  })),
                };
              },
            }),
          );
          logger.info?.("[onebot] 需求记事本工具已注册（note_want/my_wants）");

          // 自己觉得已满足的，标记掉
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "resolve_want",
              description:
                "把你需求本里的某条标记为「已满足」。**先真的试过再说满足**——需要的能力是不是真的有了，试一下，能用再标。" +
                "target 填序号（1 开始）或 id；note 写你验证的方式。",
              parameters: {
                target: { type: "string", description: "序号或 id" },
                note: { type: "string", description: "你怎么验证的（比如「试了 recall，能翻到原话」）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const wants = loadWants();
                const pending = wants.filter((w) => w.status === "pending");
                if (!pending.length) return { ok: false, reason: "需求本里没有待处理的" };
                const t = String(args?.target ?? "").trim();
                let hit = null;
                if (/^\d+$/.test(t)) {
                  const idx = Number(t);
                  if (idx >= 1 && idx <= pending.length) hit = pending[idx - 1];
                } else {
                  hit = wants.find((w) => w.id === t);
                }
                if (!hit) return { ok: false, reason: `没找到第 ${t} 条` };
                if (hit.status !== "pending") return { ok: false, reason: `这条已经是 ${hit.status}` };
                hit.status = "resolved";
                hit.resolvedAt = Date.now();
                hit.resolveNote = String(args?.note ?? "").slice(0, 200);
                saveWants(wants);
                const left = wants.filter((w) => w.status === "pending").length;
                audit({ kind: "want_resolved", what: hit.what, note: hit.resolveNote });
                logger.info?.(`[onebot] 她标记需求已满足：${hit.what}（还剩 ${left} 条）`);
                return { ok: true, resolved: hit.what, remaining: left };
              },
            }),
          );

          // 删掉不再需要的
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "drop_want",
              description: "把需求本里某条删掉（已经不需要了、或者提错了）。target 填序号或 id。",
              parameters: {
                target: { type: "string", description: "序号或 id" },
                why: { type: "string", description: "为什么不要了" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const wants = loadWants();
                const pending = wants.filter((w) => w.status === "pending");
                if (!pending.length) return { ok: false, reason: "需求本里没有待处理的" };
                const t = String(args?.target ?? "").trim();
                let hit = null;
                if (/^\d+$/.test(t)) {
                  const idx = Number(t);
                  if (idx >= 1 && idx <= pending.length) hit = pending[idx - 1];
                } else {
                  hit = wants.find((w) => w.id === t);
                }
                if (!hit) return { ok: false, reason: `没找到第 ${t} 条` };
                hit.status = "dropped";
                hit.dropNote = String(args?.why ?? "").slice(0, 200);
                hit.droppedAt = Date.now();
                saveWants(wants);
                const left = wants.filter((w) => w.status === "pending").length;
                audit({ kind: "want_dropped", what: hit.what, why: hit.dropNote });
                return { ok: true, dropped: hit.what, remaining: left };
              },
            }),
          );
          logger.info?.("[onebot] 需求整理工具已注册（resolve_want/drop_want）");

          // 通过聊天就能翻自己的活动日志
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_activities",
              description:
                "翻你自己的活动日志：探险、读书、玩、思考、写点什么、回忆、憧憬未来、研究代码。" +
                "每条都有「当时想做什么」「为什么」「实际做了什么」「回看」。" +
                "要看全过程或贴给别人时用 format=\"text\" + full=true，会返回一段排版好的文字，可以直接发。",
              parameters: {
                limit: { type: "number", description: "看几条，默认 6" },
                kind: {
                  type: "string",
                  description: "只看某类：explore/read/play/think/write/recall/dream/study，不填看全部",
                },
                date: { type: "string", description: "只看某天，格式 2026-10-29" },
                full: {
                  type: "boolean",
                  description: "要完整原文（不截断），想看全过程或贴给别人时用",
                },
                format: {
                  type: "string",
                  description: "text（排版好的文字，可直接发）/ json（默认，结构化）",
                },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const limit = Math.max(1, Math.min(30, Number(args?.limit) || 6));
                const kind = String(args?.kind ?? "").trim().toLowerCase();
                const date = String(args?.date ?? "").trim();
                const rows = loadActivities(400);
                let picked = rows;
                if (kind) picked = picked.filter((r) => r.kind === kind);
                if (date) {
                  picked = picked.filter((r) => {
                    const d = new Date(r.at);
                    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                    return ymd === date;
                  });
                }
                const full = args?.full === true;
                const wantText = String(args?.format ?? "").toLowerCase() === "text";
                const KIND_LABEL = {
                  explore: "探险",
                  read: "读书",
                  play: "玩",
                  think: "思考",
                  write: "写点什么",
                  recall: "整理记忆",
                  dream: "憧憬未来",
                  study: "研究代码",
                };
                const cut = (x, n) => (full ? String(x || "") : String(x || "").slice(0, n));
                const items = picked.slice(-limit).reverse().map((r) => {
                  const d = new Date(r.at);
                  const when = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                  const plan = r.think || {};
                  const nextAt = Number(r.nextAt) || 0;
                  const nextStr = nextAt
                    ? `${String(new Date(nextAt).getHours()).padStart(2, "0")}:${String(new Date(nextAt).getMinutes()).padStart(2, "0")}`
                    : "";
                  return {
                    when,
                    // 证据 id：P1 沉淀要贴 act:<at> 的原文片段
                    id: "act:" + r.at,
                    kind: r.kind,
                    kindLabel: KIND_LABEL[r.kind] || r.kind,
                    wanted: cut(plan.intent, 100),
                    why: cut(plan.why, 200),
                    mood: String(plan.mood || ""),
                    looked: Array.isArray(plan.looked) ? plan.looked : [],
                    did: cut(r.content, 3000),
                    reflect: cut(r.reflect, 3000),
                    nextAt: nextStr,
                    nextDelayMin: Number(r.nextDelayMin) || 0,
                  };
                });

                // 排版成可以直接发给别人的文字
                let text = "";
                if (wantText) {
                  text = items
                    .map((it) => {
                      const head = `【${it.when} · ${it.kindLabel}】`;
                      const bits = [head];
                      if (it.wanted) bits.push(`想做：${it.wanted}`);
                      if (it.why) bits.push(`为什么：${it.why}`);
                      if (it.mood) bits.push(`心情：${it.mood}`);
                      if (it.looked.length) bits.push(`调取的记忆层：${it.looked.join(", ")}`);
                      if (it.did) bits.push(`做了什么：\n${it.did}`);
                      if (it.reflect) bits.push(`反思：\n${it.reflect}`);
                      if (it.nextAt) bits.push(`下次活动：${it.nextAt}（${it.nextDelayMin} 分钟后）`);
                      return bits.join("\n\n");
                    })
                    .join("\n\n" + "─".repeat(20) + "\n\n");
                }
                const today = new Date().toDateString();
                const todayCount = rows.filter((r) => new Date(r.at).toDateString() === today).length;
                const byKind = {};
                for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
                return {
                  ok: true,
                  total: rows.length,
                  today: todayCount,
                  byKind,
                  count: items.length,
                  ...(text ? { text, note: "这段可以直接发出去" } : {}),
                  items,
                };
              },
            }),
          );
          logger.info?.("[onebot] 活动日志工具已注册（my_activities）");

          // 她能随时说清「我会什么」
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_capabilities",
              description:
                "列一下自己会什么：能用的工具、能做的自主活动、能查的记忆、有什么限制。" +
                "有人问「你会什么」「你能做什么」时用它——比凭印象答准。\n" +
                "注意：audit_self 更全（多给你「每个工具用过几次、失败几次、哪些从没用过」）。" +
                "只想知道自己会什么用这个；想查哪个功能有问题用 audit_self。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                // 只列真正注册成功的工具
                let registered = [];
                try {
                  const t = ctx.get?.("tools");
                  const list = t?.list?.() ?? t?.tools ?? [];
                  registered = Array.isArray(list)
                    ? list.map((x) => String(x?.name ?? x)).filter(Boolean)
                    : [...ALLOWED_TOOLS];
                } catch {
                  registered = [...ALLOWED_TOOLS];
                }
                const actNames = {
                  explore: "探险（出门看东西）",
                  read: "读书",
                  play: "玩（造小游戏）",
                  think: "思考",
                  write: "写点什么",
                  recall: "回忆（整理 + 回忆）",
                  dream: "憧憬未来",
                  study: "研究代码（读源码 / 写代码）",
                  watch_groups: "看看群（感兴趣可以插一句）",
                };
                return {
                  ok: true,
                  activities: ACTIVITY_KINDS.map((k) => ({
                    id: k.id,
                    what: actNames[k.id] || k.id,
                    weight: `${k.w}%`,
                  })),
                  tools: registered.sort(),
                  can: [
                    "在群里/私聊聊天，被 @ 或被引用时回",
                    "续聊：刚聊过的人不 @ 也能接着说话",
                    "发表情包（可带引用，也可不带）",
                    "画图（SVG / 图片）",
                    "查热点新闻、搜网、读网页",
                    "记事实、记人物印象、记自己的观点",
                    "翻记忆（原文检索 / 分类查 / 主题索引 / 近期摘要）",
                    "看别人的头像",
                    "查自己的状态、更新日志、源码",
                    "在沙箱里跑代码（断网、降权、限时）",
                    "记需求（想要什么）并自己标记已满足",
                  ],
                  limits: [
                    "沙箱断网，碰不到自己的记忆和源码原文件",
                    "对外发言 9-23 点；自主活动全天",
                    `搜索：${Number(cfg.searchPerHour) > 0 ? `每小时 ${cfg.searchPerHour} 次` : "不限"}`,
                    "沙箱代码：每小时 20 次、单次 30 秒",
                  ],
                };
              },
            }),
          );
          logger.info?.("[onebot] 能力清单工具已注册（my_capabilities）");

          // 她自己的排期表：下次活动什么时候、每天的固定事项
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_schedule",
              description:
                "查你自己的排期表：下次自主活动是什么时候、今天还剩多少额度、每天有哪些固定的事。" +
                "有人问「你下次什么时候动」「你的计划是什么」时用它，别凭印象说。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                const st = loadSelfState();
                // 以她自己的日程表为准（self-plan.jsonl），self-state 只做兼容
                const plan = nextSelfPlan();
                const nextAt = plan ? Number(plan.at) : 0;
                const now = Date.now();
                const fmt = (t) => {
                  const d = new Date(t);
                  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                };
                let nextActivity = "还没安排（等下一次唤醒）";
                let nextIn = "";
                if (plan && nextAt > now) {
                  const mins = Math.round((nextAt - now) / 60000);
                  nextActivity = `${fmt(nextAt)}（约 ${mins} 分钟后）${plan.kind ? " · " + plan.kind : ""}${
                    plan.note ? " · " + plan.note : ""
                  }`;
                  nextIn = `${mins} 分钟`;
                } else if (plan) {
                  const late = Math.round((now - nextAt) / 60000);
                  nextActivity = `${fmt(nextAt)} 已到点（过了 ${late} 分钟，等我下次醒来）${
                    plan.kind ? " · " + plan.kind : ""
                  }`;
                }
                const planHistory = readSelfPlan()
                  .filter((r) => r.status !== "pending")
                  .sort((a, b) => Number(b.at) - Number(a.at))
                  .slice(0, 3)
                  .map((r) => ({ at: fmt(r.at), kind: r.kind || "", status: r.status }));

                // 额度
                const today = new Date().toDateString();
                const hourFrom = Number(cfg.selfActivityCountFromHour ?? 9);
                const hourTo = Number(cfg.selfActivityCountToHour ?? 23);
                const resetAt = Number(st.selfActivityResetAt) || 0;
                const done = loadActivities(300).filter((a) => {
                  if (a.byOwner) return false;
                  if (resetAt && a.at < resetAt) return false;
                  const d = new Date(a.at);
                  if (d.toDateString() !== today) return false;
                  const h = d.getHours();
                  return h >= hourFrom && h < hourTo;
                }).length;
                const cap = Number(cfg.selfActivityPerDay ?? 40);

                // 每天的固定事项
                const daily = [
                  { what: "早上补回（昨晚错过的消息）", at: `${String(cfg.morningCatchupHour ?? 7).padStart(2, "0")}:${String(cfg.morningCatchupMinute ?? 30).padStart(2, "0")}` },
                  { what: "每日简讯", at: "09:00" },
                  { what: "自我反思", at: `${String(cfg.reflectHour ?? 22).padStart(2, "0")}:00` },
                  { what: "今日日记", at: "23:00" },
                ];

                return {
                  ok: true,
                  nextActivity,
                  nextIn,
                  plan: plan ? { id: plan.id, at: nextAt, kind: plan.kind || "", note: plan.note || "" } : null,
                  planHistory,
                  quota: { used: done, cap, left: Math.max(0, cap - done) },
                  canActNow: done < cap,
                  quietHours: {
                    speak: `${cfg.activeStartHour ?? 9}-${cfg.activeEndHour ?? 23} 点`,
                    activity: `${cfg.selfActivityStartHour ?? 0}-${cfg.selfActivityEndHour ?? 24} 点`,
                  },
                  daily,
                };
              },
            }),
          );
          logger.info?.("[onebot] 排期表工具已注册（my_schedule）");

          // ── 读对话：她和某人的往来 / 某人说过的所有话（按天分片 + 游标） ──
          const msgDaySince = (days) => Math.floor(Date.now() / 1000) - Math.max(1, Math.min(365, Number(days) || 30)) * 86400;
          const fmtMsgTime = (t) => {
            try {
              return new Date((Number(t) || 0) * 1000).toISOString().replace("T", " ").slice(0, 19);
            } catch {
              return "";
            }
          };
          const slimRow = (r) => {
            const o = {
              t: fmtMsgTime(r.t),
              dir: String(r.d || "i") === "o" ? "out" : "in",
              text: String(r.x || ""),
            };
            if (r.g) o.group = String(r.g);
            if (r.img?.length) o.img = r.img.length;
            if (r.fw) o.fw = { id: String(r.fw.id || ""), n: Number(r.fw.n) || 0 };
            if (r.qid) o.qid = String(r.qid);
            if (r.to) o.to = String(r.to);
            if (r.unk?.length) o.unk = r.unk.map((u) => String(u?.t || ""));
            return o;
          };

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_chat_with",
              description:
                "看你和某个人之间的往来记录（双向，含你自己发的）。\n" +
                "scope：all=私聊+群聊（默认）｜private=只看私聊｜group:<群号>=只看那个群。\n" +
                "带游标：把上一页的 nextCursor 传给 before 就能一直往前翻。",
              parameters: {
                qq: { type: "string", description: "对方的 QQ 号" },
                scope: { type: "string", description: "all / private / group:群号，默认 all" },
                before: { type: "string", description: "游标（上一页的 nextCursor）" },
                limit: { type: "number", description: "每页条数，默认 50，最大 200" },
                days: { type: "number", description: "只看最近多少天，默认 30" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args) => {
                const qq = String(args?.qq ?? "").trim();
                if (!/^\d{5,20}$/.test(qq)) return { ok: false, reason: "qq 要填纯数字的 QQ 号" };
                const scopeRaw = String(args?.scope ?? "all").trim();
                const sinceSec = msgDaySince(args?.days);
                let keys = [];
                if (scopeRaw === "private") keys = ["private:" + qq];
                else if (scopeRaw.startsWith("group:")) keys = ["group:" + scopeRaw.slice(6)];
                else keys = ["private:" + qq, ...listMsgKeys().filter((k) => k.startsWith("group:"))];

                const page = readMsgLogPageMulti(keys, {
                  before: args?.before,
                  limit: args?.limit,
                  sinceSec,
                });
                const items = [];
                const selfId1 = String(cfg?.selfId ?? "");
                for (const r of page.rows) {
                  // 旧记录没有 d：u 等于自己就是她发的
                  const isOut = String(r.d || "") === "o" || (!!selfId1 && String(r.u) === selfId1);
                  if (!isOut && String(r.u) !== qq) continue;
                  if (isOut && String(r.to || "") !== qq) continue;
                  items.push(slimRow(r));
                }
                return {
                  ok: true,
                  qq,
                  scope: scopeRaw,
                  count: items.length,
                  hasMore: page.hasMore,
                  nextCursor: page.nextCursor || undefined,
                  items,
                  hint: page.hasMore
                    ? "还有更早的，把 nextCursor 传给 before 继续翻"
                    : "到这里就是全部了（受 days 限制）",
                };
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_person",
              description:
                "看某个人说过的所有话（只他的发言，跨群 + 私聊）。\n" +
                "带游标：把上一页的 nextCursor 传给 before 继续往前翻。",
              parameters: {
                qq: { type: "string", description: "对方 QQ 号" },
                group: { type: "string", description: "可选，只看某个群号" },
                before: { type: "string", description: "游标（上一页的 nextCursor）" },
                limit: { type: "number", description: "每页条数，默认 50，最大 200" },
                days: { type: "number", description: "只看最近多少天，默认 30" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args) => {
                const qq = String(args?.qq ?? "").trim();
                if (!/^\d{5,20}$/.test(qq)) return { ok: false, reason: "qq 要填纯数字的 QQ 号" };
                const sinceSec = msgDaySince(args?.days);
                const keys = args?.group
                  ? ["group:" + String(args.group).replace(/^group:/, "")]
                  : listMsgKeys();
                const page = readMsgLogPageMulti(keys, {
                  before: args?.before,
                  limit: args?.limit,
                  sinceSec,
                });
                const items = [];
                const selfId2 = String(cfg?.selfId ?? "");
                for (const r of page.rows) {
                  const isOut = String(r.d || "") === "o" || (!!selfId2 && String(r.u) === selfId2);
                  if (isOut) continue;
                  if (String(r.u) !== qq) continue;
                  items.push(slimRow(r));
                }
                return {
                  ok: true,
                  qq,
                  group: args?.group ? String(args.group) : undefined,
                  count: items.length,
                  hasMore: page.hasMore,
                  nextCursor: page.nextCursor || undefined,
                  items,
                  hint: page.hasMore
                    ? "还有更早的，把 nextCursor 传给 before 继续翻"
                    : "到这里就是全部了（受 days 限制）",
                };
              },
            }),
          );
          // 创造者能发什么指令（她自己不知道这些，都是桥里写死的）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "owner_commands",
              description:
                "查创造者能对你发哪些指令。有人问「你能做什么」「有哪些指令」「怎么让你去探险」时用它，" +
                "别凭印象乱说。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                const groups = [
                  {
                    group: "让她动起来",
                    items: [
                      "活动一下 / 活动活动 — 让她立刻跑一轮（自己挑做什么）",
                      "去探险 / 探险一下 — 出门看点什么",
                      "读点书 / 读一会儿 — 找点东西读",
                      "玩会儿 — 自己造个小游戏玩",
                      "想想事 — 安静想一件事",
                      "回忆一下 — 翻自己的记忆",
                      "憧憬一下 — 想以后",
                      "研究代码 — 看她自己的源码",
                      "连做 N 轮 — 连续做 N 轮（例：连做 3 轮）",
                      "重置活动额度 — 把今天的活动次数清零",
                    ],
                  },
                  {
                    group: "查她的状态",
                    items: [
                      "状态 — 在线情况、记忆存量、活动次数",
                      "需求清单 — 她记下的「想要什么」",
                      "各个群印象 — 她对每个群的印象",
                      "全部想法 / 全部自省 — 她的观点和反思",
                      "记忆查询 <关键词> — 搜记忆",
                      "查看提醒 / 取消提醒",
                    ],
                  },
                  {
                    group: "管她的行为",
                    items: [
                      "改配置 <项> <值> — 改运行参数",
                      "以后叫我 <称呼> — 改她对你的称呼",
                      "记住 <内容> — 让她记一条事实",
                      "提醒我 <时间> <内容> — 定时提醒",
                      "算了 N / 给她 N — 调整额度或次数",
                      "同意 / 拒绝 — 回应她的申请",
                      "申请加群 <群号> — 让她去加群",
                      "发条说说 — 让她发一条空间说说",
                      "代发言 / 定向搭话 — 让她替你说一句",
                      "退群 — 让她退某个群",
                    ],
                  },
                  {
                    group: "和其他鱼有关",
                    items: ["帮助 — 列出这份指令清单"],
                  },
                ];
                return {
                  ok: true,
                  total: groups.reduce((n2, g) => n2 + g.items.length, 0),
                  groups,
                  note: "这些都是创造者在 QQ 私聊或网页里直接发的；她不需要「听懂」某个指令，桥会自己拦截处理。",
                };
              },
            }),
          );
          logger.info?.("[onebot] 指令清单工具已注册（owner_commands）");

          // 她对每个群的印象（原来是指令里的「各个群印象」，改成工具让她自己决定要不要答）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "group_impressions",
              description:
                "查你对每个群的整体印象（这个群是干什么的、常聊什么、安静还是热闹）。" +
                "有人问「你对哪个群印象深」「这些群都是干什么的」时用。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                const meta = loadGroupMeta();
                const lines = [];
                for (const [gid, m] of Object.entries(meta)) {
                  if (!m || typeof m !== "object") continue;
                  lines.push({
                    group: m.name || groupLabel(gid) || gid,
                    id: gid,
                    purpose: String(m.purpose || "").slice(0, 120),
                    topics: String(m.topics || "").slice(0, 120),
                    messages: Number(m.count) || 0,
                    lastAt: Number(m.lastAt) || 0,
                  });
                }
                return { ok: true, count: lines.length, groups: lines.slice(-20) };
              },
            }),
          );

          // 她自己的想法和反思（原来是指令里的「全部想法 / 全部自省」）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_thoughts",
              description:
                "查自己写下的观点和自省。which 填 views（观点，默认）或 reflections（自省）。\n" +
                "注意：my_memory({type:\"views\"}) 或 {type:\"reflections\"} 是同一份数据，两个都行。",
              parameters: {
                which: { type: "string", description: "views（观点）/ reflections（自省），默认 views" },
                limit: { type: "number", description: "看几条，默认 20" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const which = String(args?.which ?? "views").toLowerCase();
                const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
                try {
                  selfViews.load?.();
                } catch {
                  // 忽略
                }
                const out = [];
                if (which === "reflections") {
                  for (let i = 0; i < limit; i++) {
                    const r = selfViews.renderReflections?.(i + 1);
                    if (!r) break;
                    out.push(r);
                  }
                } else {
                  const v = selfViews.render?.(limit);
                  if (v) out.push(v);
                }
                return { ok: true, which, count: out.length, items: out };
              },
            }),
          );

          logger.info?.("[onebot] 群印象/我的想法 工具已注册（group_impressions/my_thoughts）");

          // 让她能自己决定开始一轮活动（创造者说「活动一下」「去探险」时由她自己调）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "run_activity",
              description:
                "开始一轮自己的活动。想读书、玩、出去看看、想事、写点什么、看看群——" +
                "**任何时候都可以用，不用等谁叫你**。kind 不填就自己挑一个。\n" +
                "kind 可选：read / play / explore / think / write / recall / dream / study / watch_groups",
              parameters: {
                kind: {
                  type: "string",
                  description: "explore/read/play/think/write/recall/dream/study，不填自己挑",
                },
                rounds: { type: "number", description: "做几轮，默认 1，最多 5" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const kind = String(args?.kind ?? "").trim();
                const rounds = Math.max(1, Math.min(5, Number(args?.rounds) || 1));
                const VALID = ["explore", "read", "play", "think", "write", "recall", "dream", "study", "watch_groups"];
                const useKind = VALID.includes(kind) ? kind : "";
                for (let i = 0; i < rounds; i++) {
                  if (useKind) {
                    await runThinkingCycle({ forceAction: useKind, byOwner: true });
                  } else {
                    await runThinkingCycle({ byOwner: true });
                  }
                }
                const st = loadSelfState();
                const nextAt = Number(st.selfActivityNextAt) || 0;
                return {
                  ok: true,
                  ran: rounds,
                  kind: useKind || "自己挑的",
                  nextActivity: nextAt
                    ? `${String(new Date(nextAt).getHours()).padStart(2, "0")}:${String(new Date(nextAt).getMinutes()).padStart(2, "0")}`
                    : "未定",
                  note: "这些轮次不算进你的每日额度",
                };
              },
            }),
          );

          // 提醒（创造者说「提醒我…」时由她自己设）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "set_reminder",
              description:
                "给创造者设一个提醒。他说「提醒我…」「到点告诉我…」时用。" +
                "minutes 填多少分钟后提醒（最少 1 分钟）",
              parameters: {
                minutes: { type: "number", description: "多少分钟后提醒" },
                what: { type: "string", description: "提醒什么事" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const minutes = Math.max(1, Math.min(60 * 24 * 30, Number(args?.minutes) || 0));
                const what = String(args?.what ?? "").trim().slice(0, 200);
                if (!minutes || !what) return { ok: false, error: "需要 minutes 和 what" };
                const until = Date.now() + minutes * 60_000;
                const list = loadReminders();
                list.push({ at: until, what, by: "self", createdAt: Date.now() });
                saveReminders(list);
                const d = new Date(until);
                return {
                  ok: true,
                  at: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
                  minutes,
                  what,
                };
              },
            }),
          );

          logger.info?.("[onebot] 活动/提醒 工具已注册（run_activity/set_reminder）");

          // ── 本子：一天一个文件，纯文本，她写什么存什么 ──
          const NOTEBOOK_DIR = join(HOME, ".dsh/onebot-bridge/notebook");
          function notebookPath(d = new Date()) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return join(NOTEBOOK_DIR, `${y}-${m}-${day}.md`);
          }

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "write_notebook",
              description:
                "往本子上写东西——**按天分文件的那种**。想写「今天我干了什么」「今天想到什么」就用这个。" +
                "按天自动分文件，写进去就存住了，隔几晚翻回来还认得。" +
                "（不知道往哪儿写的时候：流水账用这个，要长期留的东西用 note_file。）",
              parameters: {
                text: { type: "string", description: "要写的内容（可以写很多）" },
                title: { type: "string", description: "小标题，可省略" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const text = String(args?.text ?? "").trim();
                const title = String(args?.title ?? "").trim();
                if (!text) return { ok: false, reason: "内容为空" };
                try {
                  mkdirSync(NOTEBOOK_DIR, { recursive: true });
                  const p = notebookPath();
                  const d = new Date();
                  const hh = String(d.getHours()).padStart(2, "0");
                  const mm = String(d.getMinutes()).padStart(2, "0");
                  const head = title ? `\n## ${hh}:${mm} ${title}\n\n` : `\n### ${hh}:${mm}\n\n`;
                  appendFileSync(p, head + text + "\n", "utf8");
                  const size = statSync(p).size;
                  audit({ kind: "notebook_write", bytes: text.length });
                  return { ok: true, file: p.split("/").pop(), bytes: size, chars: text.length };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_notebook",
              description:
                "翻**你自己写的本子**（日记/随手记，按天分文件）。" +
                "**这不是聊天记录**——本子里只有你写过的日子，" +
                "想翻聊天原文用 recall。\n" +
                "参数 date 填某天（2026-10-29），不填就看最近几天；days 控制看几天，默认 3。",
              parameters: {
                date: { type: "string", description: "某一天，格式 2026-10-29" },
                days: { type: "number", description: "看最近几天，默认 3" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                try {
                  const want = String(args?.date ?? "").trim();
                  let files = [];
                  if (want) {
                    files = [join(NOTEBOOK_DIR, `${want}.md`)];
                  } else {
                    const n = Math.max(1, Math.min(30, Number(args?.days) || 3));
                    try {
                      const all = readdirSync(NOTEBOOK_DIR)
                        .filter((f) => f.endsWith(".md"))
                        .sort();
                      files = all.slice(-n).map((f) => join(NOTEBOOK_DIR, f));
                    } catch {
                      return { ok: true, count: 0, note: "本子还是空的" };
                    }
                  }
                  const out = [];
                  for (const f of files) {
                    try {
                      out.push({ file: f.split("/").pop(), text: readFileSync(f, "utf8") });
                    } catch {
                      // 这天没写
                    }
                  }
                  return { ok: true, count: out.length, entries: out };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          // ── 多文件本子：能自己建文件、写草稿（只在 notebook/files 下） ──
          const NOTE_FILES_DIR = join(NOTEBOOK_DIR, "files");
          const NOTE_NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,48}\.(?:md|txt|py|js|json|csv|svg)$/i;
          const NOTE_MAX_FILE = 64 * 1024;
          const NOTE_MAX_TOTAL = 20 * 1024 * 1024;
          function noteFilesTotal() {
            let n = 0;
            try {
              for (const f of readdirSync(NOTE_FILES_DIR)) {
                try {
                  n += statSync(join(NOTE_FILES_DIR, f)).size;
                } catch {
                  // 忽略
                }
              }
            } catch {
              // 目录还不存在
            }
            return n;
          }
          function noteSafeName(raw) {
            const name = String(raw || "").trim();
            if (!NOTE_NAME_RE.test(name)) return null;
            return name;
          }

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "note_file",
              description:
                "在文件区建文件——**要长期留着的东西放这儿**：你的规矩、对照表、笔记、攒的资料。\n" +
                "跟另外两处的区别：\n" +
                "· write_notebook = 按天分的流水账（日期是文件名，你自己命名不了）\n" +
                "· note_file = 你自己命名的长期文件，**删不掉**（root 权限），最安全\n" +
                "· exec_sandbox 的沙箱目录 = 临时跑代码用的，**你自己能删能改**，重要的别只放那儿\n" +
                "只允许 md / txt / py / js / json / csv / svg，单个文件最多 64KB，总共 20MB。",
              parameters: {
                name: { type: "string", description: "文件名，例如 读书笔记.md、潮汐.js（不能带路径）" },
                text: { type: "string", description: "要写的内容" },
                mode: { type: "string", description: "replace 覆盖（默认）/ append 追加" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const name = noteSafeName(args?.name);
                if (!name) return { ok: false, reason: "文件名不合规：只能字母数字下划线中文，后缀 md/txt/py/js/json/csv/svg" };
                const text = String(args?.text ?? "");
                if (!text) return { ok: false, reason: "内容为空" };
                if (text.length > NOTE_MAX_FILE) return { ok: false, reason: "一段写太长了（最多 64KB）" };
                const append = String(args?.mode ?? "").toLowerCase() === "append";
                try {
                  mkdirSync(NOTE_FILES_DIR, { recursive: true });
                  const p = join(NOTE_FILES_DIR, name);
                  let base = 0;
                  try {
                    base = statSync(p).size;
                  } catch {
                    // 新文件
                  }
                  if (!append && noteFilesTotal() - base + text.length > NOTE_MAX_TOTAL) {
                    return { ok: false, reason: "文件区满了（20MB），先删几个旧的" };
                  }
                  if (base + text.length > NOTE_MAX_FILE) return { ok: false, reason: "这个文件到 64KB 上限了" };
                  writeFileSync(p, text, { flag: append ? "a" : "w" });
                  const size = statSync(p).size;
                  audit({ kind: "note_file", name, bytes: text.length, append });
                  return { ok: true, name, size, totalKB: Math.round(noteFilesTotal() / 1024) };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_note",
              description: "读文件区里的某个文件。name 填文件名；不填就列清单（等同 list_notes）。",
              parameters: {
                name: { type: "string", description: "文件名，可省略" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const name = noteSafeName(args?.name);
                if (!name) return { ok: false, reason: "文件名不合规" };
                try {
                  const p = join(NOTE_FILES_DIR, name);
                  const text = readFileSync(p, "utf8");
                  return { ok: true, name, size: text.length, text };
                } catch {
                  return { ok: false, reason: "没这个文件（先用 list_notes 看看有什么）" };
                }
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "list_notes",
              description: "列出文件区里所有文件（名字、大小、最后改动时间）。想找长期存的东西用这个；临时产物在沙箱目录，用 sandbox_files 看。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                try {
                  const files = readdirSync(NOTE_FILES_DIR).map((f) => {
                    try {
                      const st = statSync(join(NOTE_FILES_DIR, f));
                      return { name: f, bytes: st.size, at: new Date(st.mtimeMs).toISOString().slice(0, 16) };
                    } catch {
                      return { name: f, bytes: 0, at: "" };
                    }
                  });
                  files.sort((a, b) => (a.at < b.at ? 1 : -1));
                  return { ok: true, count: files.length, files, totalKB: Math.round(noteFilesTotal() / 1024) };
                } catch {
                  return { ok: true, count: 0, files: [], note: "文件区还是空的" };
                }
              },
            }),
          );

          // ── 读 PDF ──
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_pdf",
              description:
                "读一个 PDF 的文字内容。path 填服务器上的路径；如果是网址，先用 exec_sandbox 下载下来再读。" +
                "pages 可选，比如 \"1-5\"，不填读开头几页。",
              parameters: {
                path: { type: "string", description: "PDF 的文件路径" },
                pages: { type: "string", description: "页码范围，例：1-5，可省略" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const p = String(args?.path ?? "").trim();
                if (!p) return { ok: false, reason: "要给我一个路径" };
                if (!p.toLowerCase().endsWith(".pdf")) return { ok: false, reason: "这不是 PDF" };
                if (!/^\/[\w./\-]+$/.test(p)) return { ok: false, reason: "路径不合法" };
                try {
                  if (!existsSync(p)) return { ok: false, reason: "文件不存在" };
                  const pages = String(args?.pages ?? "").trim();
                  const a = ["-layout"];
                  if (pages) {
                    a.push("-f", pages.split("-")[0] || "1");
                    if (pages.includes("-")) a.push("-l", pages.split("-")[1]);
                  }
                  a.push(p, "-");
                  const out = execFileSync("pdftotext", a, {
                    timeout: 30_000,
                    maxBuffer: 8 * 1024 * 1024,
                    encoding: "utf8",
                  });
                  const txt = String(out || "")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                  audit({ kind: "read_pdf", file: p, chars: txt.length });
                  // 顺带问一下总共多少页，免得她以为读完的就是全部
                  let totalPages = 0;
                  try {
                    const info = execFileSync("pdfinfo", [p], { timeout: 10000, encoding: "utf8" });
                    const mm = String(info).match(/Pages:\s+(\d+)/);
                    if (mm) totalPages = Number(mm[1]);
                  } catch {
                    // 没装 pdfinfo 就算了
                  }
                  const from = pages ? Number(pages.split("-")[0]) || 1 : 1;
                  const to = pages && pages.includes("-") ? Number(pages.split("-")[1]) || 0 : 0;
                  const pagesRead = totalPages
                    ? `第 ${from} 页到第 ${to || (from + Math.max(0, Math.ceil(txt.length / 2000) - 1))} 页 / 共 ${totalPages} 页`
                    : "";
                  return {
                    ok: true,
                    chars: txt.length,
                    truncated: false,
                    totalPages,
                    pagesRead,
                    note: totalPages && !pages ? `这是一共 ${totalPages} 页的 PDF；只想要某几页可以填 pages 例如 "1-5"` : "",
                    text: txt,
                  };
                } catch (err) {
                  return {
                    ok: false,
                    reason: String(err?.message ?? err).slice(0, 300),
                    hint: "如果提示找不到 pdftotext，需要先装 poppler-utils",
                  };
                }
              },
            }),
          );

          logger.info?.("[onebot] 本子/PDF 工具已注册（write_notebook/read_notebook/read_pdf）");

          // ── 改动申请：她想改代码时，写一份设计报告给创造者，不自己动手 ──
          const PROPOSAL_DIR = join(HOME, ".dsh/onebot-bridge/patch-proposals");
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "propose_patch",
              description:
                "你想改自己代码的时候用这个：写一份「改动申请」发给创造者，由他来执行。你改不了代码，但可以把想法说清楚。\n" +
                "\n" +
                "【写之前先做三件事】\n" +
                "1. 用 read_source 或 my_source 把那一段**原文照抄下来**（oldCode 要能精确定位，不能凭印象）\n" +
                "2. 用 exec_sandbox 跑一下，**证明问题真的存在**（比如「2.52. 会不会被切」）\n" +
                "3. 想清楚**改完会不会弄坏别的**（给出反例）\n" +
                "\n" +
                "【六个字段，每个都要写实】\n" +
                "· file    —— 哪个文件（通常 index.js）\n" +
                "· where   —— 大概位置（函数名 + 行号），方便创造者找\n" +
                "· oldCode —— **原文照抄**，必须唯一（出现两次以上创造者没法改）\n" +
                "· newCode —— 改成什么（只改一行，别整段重写）\n" +
                "· why     —— **举具体反例**：「输入 X 会变成 Y，应该是 Z」，不要写「这样更合理」\n" +
                "· principle —— **原理**：为什么这么改能解决，背后的道理是什么\n" +
                "· risk    —— **主动说副作用**：什么情况下会出问题，影响面多大\n" +
                "· verify  —— **给可执行的样例**：输入 → 期望输出，创造者照着跑就能验\n" +
                "\n" +
                "【反面例子（会被创造者退回）】\n" +
                "✗ why: 「这样更规范」\n" +
                "✗ verify: 「测试一下看对不对」\n" +
                "✗ risk: 「应该没影响」\n" +
                "✗ oldCode: 凭印象写的、和源码对不上的\n" +
                "\n" +
                "【正面例子（真实提交过的）】\n" +
                "why: 「40 字以内的消息，只要以英文句点结尾就会被切掉——「今天读数 2.52.」\n" +
                "    变成「今天读数 2.52」，缩写「Dr.」「e.g.」尾巴上的点一并吃掉」\n" +
                "risk: 「如果有人真的用英文句点收尾（整句英文 Hello there.），那句会保留\n" +
                "    句号，不再被拟人化。影响面很小，而且正好符合只处理中文句号的初衷」\n" +
                "verify: 「①「今天读数 2.52.」应原样返回 ②「短句测试。」应变成「短句测试」\n" +
                "    ③「Hello there.」应保留句号 ④ 超 40 字长段句号保留」\n" +
                "\n" +
                "写得好，创造者看一遍就敢动手；写得含糊，他只能来问你，白等一轮。",
              parameters: {
                file: { type: "string", description: "要改哪个文件，比如 index.js / README.md" },
                where: { type: "string", description: "大概位置：函数名或行号附近，方便创造者找" },
                oldCode: { type: "string", description: "原来的那一行（照抄）" },
                newCode: { type: "string", description: "改成什么" },
                why: { type: "string", description: "为什么要改：现在的写法有什么问题" },
                principle: { type: "string", description: "原理：为什么这么改能解决，背后的道理" },
                risk: { type: "string", description: "可能影响什么、什么情况下会出问题" },
                verify: { type: "string", description: "改完怎么确认是对的" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const file = String(args?.file ?? "").trim();
                const where = String(args?.where ?? "").trim();
                const oldCode = String(args?.oldCode ?? "").trim();
                const newCode = String(args?.newCode ?? "").trim();
                const why = String(args?.why ?? "").trim();
                const principle = String(args?.principle ?? "").trim();
                const risk = String(args?.risk ?? "").trim();
                const verify = String(args?.verify ?? "").trim();

                if (!file || !oldCode || !newCode || !why) {
                  return { ok: false, reason: "至少要填 file / oldCode / newCode / why" };
                }

                const d = new Date();
                const stamp =
                  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
                  `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
                const id = `patch-${stamp}`;

                const doc = [
                  `# 改动申请 ${id}`,
                  "",
                  `**文件**：\`${file}\``,
                  where ? `**位置**：${where}` : "",
                  "",
                  "## 现在是这样",
                  "```js",
                  oldCode,
                  "```",
                  "",
                  "## 想改成这样",
                  "```js",
                  newCode,
                  "```",
                  "",
                  "## 为什么要改",
                  why,
                  "",
                  principle ? `## 原理\n${principle}` : "",
                  risk ? `## 可能的影响 / 风险\n${risk}` : "",
                  verify ? `## 改完怎么验证\n${verify}` : "",
                  "",
                  "---",
                  `由她于 ${d.toLocaleString("zh-CN")} 提出，等待创造者执行。`,
                  "",
                ]
                  .filter(Boolean)
                  .join("\n");

                try {
                  mkdirSync(PROPOSAL_DIR, { recursive: true });
                  writeFileSync(join(PROPOSAL_DIR, `${id}.md`), doc, "utf8");
                  audit({ kind: "patch_proposal", id, file });
                  // 推给创造者的 WebUI，让他第一时间看到
                  try {
                    webPush({
                      role: "her",
                      text: `我写了份改动申请（${id}），改的是 ${file}。\n\n${why.slice(0, 120)}`,
                    });
                  } catch {
                    // 忽略
                  }
                  return {
                    ok: true,
                    id,
                    saved: `~/.dsh/onebot-bridge/patch-proposals/${id}.md`,
                    note: "已发给创造者。他执行完会告诉你。",
                  };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "my_patch_proposals",
              description: "看你提过哪些改动申请、创造者执行了没有。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => {
                try {
                  const files = readdirSync(PROPOSAL_DIR)
                    .filter((f) => f.endsWith(".md"))
                    .sort()
                    .slice(-20);
                  const items = files.map((f) => {
                    const id = f.replace(/\.md$/, "");
                    let status = "pending";
                    try {
                      const d = JSON.parse(readFileSync(join(PROPOSAL_DIR, `${id}.done.json`), "utf8"));
                      // done / duplicate / rejected 都算「处理过了」，只有没有 done.json 才是 pending
                      if (d?.status) status = String(d.status);
                    } catch {
                      // 没标记 = 还没执行
                    }
                    return { id, at: f.slice(6, 14), status };
                  });
                  const pending = items.filter((x) => x.status === "pending").length;
                  return {
                    ok: true,
                    count: items.length,
                    pending,
                    note: pending
                      ? `有 ${pending} 份还在等创造者执行`
                      : "都处理完了",
                    items,
                  };
                } catch {
                  return { ok: true, count: 0, pending: 0, items: [] };
                }
              },
            }),
          );

          logger.info?.("[onebot] 改动申请工具已注册（propose_patch/my_patch_proposals）");

          // 改动申请的写法指南（她想不起格式时随时查）
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "patch_guide",
              description:
                "看「怎么写改动申请」的完整指南：模板、检查清单、正面例子、会被退回的写法。" +
                "准备提 propose_patch 之前先看一遍，能少被退几次。",
              parameters: {},
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async () => ({
                ok: true,
                steps: [
                  "① 用 read_source 把那一段原文照抄下来（oldCode 必须和源码一字不差）",
                  "② 用 exec_sandbox 跑一下，证明问题真的存在",
                  "③ 想清楚改完会不会弄坏别的，给出反例",
                ],
                fields: [
                  { key: "file", what: "哪个文件，通常 index.js" },
                  { key: "where", what: "函数名 + 行号，方便创造者找" },
                  { key: "oldCode", what: "原文照抄，必须唯一（出现两次以上没法改）" },
                  { key: "newCode", what: "改成什么，只改一行" },
                  { key: "why", what: "举具体反例：输入 X 变成 Y，应该是 Z" },
                  { key: "principle", what: "原理：为什么这么改能解决" },
                  { key: "risk", what: "主动说副作用，什么情况下会出问题" },
                  { key: "verify", what: "给可执行样例：输入 → 期望输出" },
                ],
                bad: [
                  "why 写「这样更规范」——没有具体反例",
                  "verify 写「测试一下看对不对」——创造者没法跑",
                  "risk 写「应该没影响」——说明你没想过",
                  "oldCode 凭印象写的——和源码对不上就没法改",
                ],
                good: {
                  why: "40 字以内的消息，只要以英文句点结尾就会被切掉——「今天读数 2.52.」变成「今天读数 2.52」",
                  risk: "整句英文（Hello there.）会保留句号，不再被拟人化。影响面很小",
                  verify: "①「2.52.」原样 ②「短句测试。」去点 ③「Hello there.」保留 ④ 超 40 字长段保留",
                },
                note: "写得好，创造者看一遍就敢动手；写得含糊，他只能来问你，白等一轮。",
              }),
            }),
          );

          logger.info?.("[onebot] 改动申请指南工具已注册（patch_guide）");

          // 知乎日报：知乎唯一不需要签名、不需要登录的接口
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "zhihu_daily",
              description:
                "读知乎日报（每天 4-5 篇精选文章）。\n" +
                "· 不传参数 → 今天的列表\n" +
                "· date: \"20261029\" → 那天的列表\n" +
                "· id: 9793630 → **那一篇的全文**（列表里的 id 字段，直接给正文，不用再抓网页）",
              parameters: {
                date: { type: "string", description: "八位日期，例 20261029；不填看今天" },
                id: { type: "string", description: "文章 id（列表里返回的），传了就返回这篇的全文" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const artId = String(args?.id ?? "").trim();
                if (/^\d+$/.test(artId)) {
                  // 单篇全文：/api/4/news/<id> 直接带 body（HTML）
                  try {
                    const ctrl0 = new AbortController();
                    const t0 = setTimeout(() => ctrl0.abort(), 15000);
                    const r0 = await fetch(`https://news-at.zhihu.com/api/4/news/${artId}`, {
                      signal: ctrl0.signal,
                      headers: {
                        "user-agent":
                          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                        referer: "https://daily.zhihu.com/",
                      },
                    });
                    clearTimeout(t0);
                    if (!r0.ok) return { ok: false, reason: `HTTP ${r0.status}` };
                    const j0 = await r0.json();
                    // 把 HTML 正文洗成纯文本
                    const plain = String(j0.body || "")
                      .replace(/<script[\s\S]*?<\/script>/gi, "")
                      .replace(/<style[\s\S]*?<\/style>/gi, "")
                      .replace(/<[^>]+>/g, " ")
                      .replace(/&nbsp;/g, " ")
                      .replace(/&amp;/g, "&")
                      .replace(/&lt;/g, "<")
                      .replace(/&gt;/g, ">")
                      .replace(/&quot;/g, '"')
                      .replace(/\s+/g, " ")
                      .trim();
                    return {
                      ok: true,
                      id: artId,
                      title: String(j0.title || ""),
                      author: String(j0.author || ""),
                      url: j0.share_url || j0.url || `https://daily.zhihu.com/story/${artId}`,
                      chars: plain.length,
                      truncated: false,
                        text: plain,
                    };
                  } catch (err) {
                    return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                  }
                }

                const date = String(args?.date ?? "").trim();
                const url = /^\d{8}$/.test(date)
                  ? `https://news-at.zhihu.com/api/4/news/before/${date}`
                  : "https://news-at.zhihu.com/api/4/news/latest";
                try {
                  const ctrl = new AbortController();
                  const timer = setTimeout(() => ctrl.abort(), 15000);
                  const r = await fetch(url, {
                    signal: ctrl.signal,
                    headers: {
                      "user-agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                      referer: "https://daily.zhihu.com/",
                    },
                  });
                  clearTimeout(timer);
                  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
                  const j = await r.json();
                  const stories = Array.isArray(j?.stories) ? j.stories : [];
                  return {
                    ok: true,
                    date: j?.date || date || "今天",
                    count: stories.length,
                    items: stories.slice(0, 10).map((x) => ({
                      title: String(x.title || "").slice(0, 80),
                      id: x.id,
                      url: x.url || `https://daily.zhihu.com/story/${x.id}`,
                      hint: x.hint ? String(x.hint).slice(0, 40) : "",
                    })),
                    note: "要读正文就用 web_fetch 打开 url，或者跟我说哪篇",
                  };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          logger.info?.("[onebot] 知乎日报工具已注册（zhihu_daily）");

          // NewsNow 热榜：它的网页是 SPA + Cloudflare，直接抓页面拿不到内容，
          // 但它有一个公开 API /api/s?id=<源>，返回 JSON。
          const NEWS_SOURCES = {
            weibo: "微博热搜",
            zhihu: "知乎热榜",
            baidu: "百度热搜",
            toutiao: "今日头条",
            douyin: "抖音热点",
            bilibili: "B站热门",
            sspai: "少数派",
            ithome: "IT之家",
            thepaper: "澎湃新闻",
            cls: "财联社",
            github: "GitHub Trending",
            hackernews: "Hacker News",
            v2ex: "V2EX",
            juejin: "稀土掘金",
            "36kr": "36氪",
            cankaoxiaoxi: "参考消息",
          };

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "news_now",
              description:
                "看各平台的热榜（微博/知乎/百度/头条/抖音/B站/IT之家/澎湃/财联社/GitHub等）。" +
                "source 填源名，一次一个；不填默认微博。" +
                "source 可选：" +
                Object.keys(NEWS_SOURCES).join(" / "),
              parameters: {
                source: { type: "string", description: "源名，默认 weibo" },
                limit: { type: "number", description: "看几条，默认 15，最多 40" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const src = String(args?.source ?? "weibo").trim().toLowerCase();
                const limit = Math.max(1, Math.min(40, Number(args?.limit) || 15));
                if (!NEWS_SOURCES[src]) {
                  return {
                    ok: false,
                    reason: `不认识的源「${src}」，可选：${Object.keys(NEWS_SOURCES).join(" / ")}`,
                  };
                }
                try {
                  const ctrl = new AbortController();
                  const timer = setTimeout(() => ctrl.abort(), 15000);
                  const r = await fetch(`https://newsnow.busiyi.world/api/s?id=${encodeURIComponent(src)}`, {
                    signal: ctrl.signal,
                    headers: {
                      // 这个站挂了 Cloudflare，必须带浏览器 UA，否则 403
                      "user-agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                      accept: "application/json, text/plain, */*",
                      referer: "https://newsnow.busiyi.world/",
                    },
                  });
                  clearTimeout(timer);
                  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
                  const j = await r.json();
                  const items = Array.isArray(j?.items) ? j.items : [];
                  return {
                    ok: true,
                    source: src,
                    sourceName: NEWS_SOURCES[src],
                    count: items.length,
                    updatedAt: j?.updatedTime
                      ? new Date(j.updatedTime).toLocaleString("zh-CN", { hour12: false })
                      : "",
                    items: items.slice(0, limit).map((x, i) => ({
                      rank: i + 1,
                      title: String(x.title || x.id || "").slice(0, 100),
                      url: x.url || "",
                      hot: x.extra?.info || x.extra?.hover || "",
                    })),
                  };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          logger.info?.("[onebot] 热榜工具已注册（news_now）");

          // 沙箱目录：列文件、删文件，由她自己决定留哪些
          const SBX_DIR = "/var/lib/fish-desk";
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "sandbox_files",
              description:
                "看/清理沙箱目录（/var/lib/fish-desk）里的文件。不传 delete 就列出所有文件（名字、大小、时间）；" +
                "传 delete: [\"a.py\", \"b.png\"] 就删掉指定的。" +
                "留哪些删哪些你自己定——空间是你的，别攒成垃圾堆就行。\n" +
                "提醒：这儿的文件你自己能删，所以**真正想留住的东西别只放这儿**，挪到文件区（note_file）更稳。",
              parameters: {
                delete: {
                  type: "array",
                  items: { type: "string" },
                  description: "要删的文件名数组，不传就是只看",
                },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                try {
                  mkdirSync(SBX_DIR, { recursive: true });
                  const list = readdirSync(SBX_DIR)
                    .filter((f) => !f.startsWith(".") || f.startsWith(".run-"))
                    .map((f) => {
                      try {
                        const st = statSync(join(SBX_DIR, f));
                        return { name: f, size: st.size, at: st.mtimeMs };
                      } catch {
                        return null;
                      }
                    })
                    .filter(Boolean)
                    .sort((a, b) => b.at - a.at);

                  const want = Array.isArray(args?.delete) ? args.delete.map(String) : [];
                  if (!want.length) {
                    const total = list.reduce((n, x) => n + x.size, 0);
                    return {
                      ok: true,
                      dir: SBX_DIR,
                      count: list.length,
                      totalKB: Math.round(total / 1024),
                      files: list.slice(0, 60).map((x) => ({
                        name: x.name,
                        kb: Math.round((x.size / 1024) * 10) / 10,
                        at: new Date(x.at).toLocaleString("zh-CN", { hour12: false }),
                      })),
                      hint: "要删就传 delete: [\"文件名\"]",
                    };
                  }

                  const deleted = [];
                  const failed = [];
                  for (const name of want.slice(0, 50)) {
                    // 只允许删这个目录里的普通文件名，不让它跑出去
                    if (!/^[\w.\-]+$/.test(name) || name.includes("..")) {
                      failed.push({ name, why: "文件名不合法" });
                      continue;
                    }
                    try {
                      unlinkSync(join(SBX_DIR, name));
                      deleted.push(name);
                    } catch (err) {
                      failed.push({ name, why: String(err?.message ?? err).slice(0, 60) });
                    }
                  }
                  audit({ kind: "sandbox_clean", deleted: deleted.length, failed: failed.length });
                  return { ok: true, deleted, failed, note: deleted.length ? "删掉了" : "一个都没删" };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          logger.info?.("[onebot] 沙箱文件管理工具已注册（sandbox_files）");

          // ══════════ 读网页正文 ══════════
          // web_fetch 有两个短板：① 裸请求被 Cloudflare 拦（403）② SPA 页面读不到正文。
          // 这个工具带完整浏览器头、自己洗正文，失败时说清是谁挡的。
          const BROWSER_HEADERS = {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "accept-encoding": "gzip, deflate, br",
            "cache-control": "no-cache",
            pragma: "no-cache",
            "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
          };

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "read_page",
              description:
                "取一个网页的正文（比 web_fetch 强）。它带完整浏览器头——很多站只拦裸请求，" +
                "带了就放行；还会把 HTML 洗成纯文本（去掉导航、广告、脚本、页脚）。\n" +
                "读不到时会告诉你是谁挡的：Cloudflare 拦截 / SPA 需要 JS / 404 / 超时，" +
                "并给出能用什么替代（知乎用 zhihu_daily，热榜用 news_now）。\n" +
                "默认返回**全文**（最多 5 万字）；真嫌长可以用 max 自己压。",
              parameters: {
                url: { type: "string", description: "http/https 网址" },
                max: {
                  type: "number",
                  description: "最多返回多少字，默认 50000（等于全文）；想只看开头就填个小的",
                },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const url = String(args?.url ?? "").trim();
                // 默认给全文：不预设"看多少就够了"，让她自己决定
                const max = Math.max(500, Math.min(50000, Number(args?.max) || 50000));
                if (!/^https?:\/\//i.test(url)) {
                  return { ok: false, reason: "url 要以 http:// 或 https:// 开头" };
                }
                let host = "";
                try {
                  host = new URL(url).hostname;
                } catch {
                  return { ok: false, reason: "url 格式不对" };
                }
                try {
                  const ctrl = new AbortController();
                  const timer = setTimeout(() => ctrl.abort(), 20000);
                  const r = await fetch(url, {
                    signal: ctrl.signal,
                    headers: BROWSER_HEADERS,
                    redirect: "follow",
                  });
                  clearTimeout(timer);

                  const ctype = String(r.headers.get("content-type") || "");
                  const raw = await r.text();

                  // JSON 直接给
                  if (/json/i.test(ctype) || /^\s*[{[]/.test(raw)) {
                    return {
                      ok: r.ok,
                      url,
                      status: r.status,
                      type: "json",
                      text: raw.slice(0, max),
                      totalChars: raw.length,
                      hasMore: raw.length > max,
                      note: "这是 JSON 接口，直接给了原文",
                    };
                  }

                  // Cloudflare / 人机验证
                  const cf = /Attention Required|cf-error-details|Just a moment|cf-browser-verification|Enable JavaScript and cookies/i.test(
                    raw,
                  );
                  if (r.status === 403 || cf) {
                    return {
                      ok: false,
                      url,
                      status: r.status,
                      reason: cf
                        ? "站点挂了 Cloudflare 人机验证，带浏览器头也过不去（需要真浏览器）"
                        : `HTTP ${r.status}`,
                      hint:
                        host.includes("zhihu.com")
                          ? "知乎用 zhihu_daily（日报全文不需要签名）"
                          : host.includes("newsnow")
                            ? "热榜用 news_now"
                            : "可以试试别的来源，或者用 exec_sandbox 里的 curl 加同样的头",
                    };
                  }
                  if (!r.ok) {
                    return { ok: false, url, status: r.status, reason: `HTTP ${r.status}` };
                  }

                  const { title, text } = stripToText(raw);
                  // SPA 特征：HTML 壳很厚但正文几乎没有
                  if (text.length < 200 && raw.length > 2000) {
                    return {
                      ok: false,
                      url,
                      status: r.status,
                      reason: "这是 SPA（页面靠 JS 渲染），HTML 里没正文",
                      rawSize: Math.round(raw.length / 1024) + " KB",
                      title,
                      hint: "找一个 JSON 接口替代（很多站在 /api/ 下），或者用 news_now / zhihu_daily 这类现成工具",
                    };
                  }
                  const shown = smartCut(text, max);
                  return {
                    ok: true,
                    url,
                    status: r.status,
                    title,
                    chars: text.length,
                    truncated: text.length > max,
                    text: shown,
                    note:
                      text.length > max
                        ? `全文 ${text.length} 字，这里给了前 ${shown.length} 字（切在句末）。想看全部就加 max: ${text.length}`
                        : "",
                  };
                } catch (err) {
                  const msg = String(err?.message ?? err);
                  return {
                    ok: false,
                    url,
                    reason: /abort/i.test(msg) ? "超时（20 秒）" : msg.slice(0, 200),
                  };
                }
              },
            }),
          );

          logger.info?.("[onebot] 读网页正文工具已注册（read_page）");

          // ══════════ 统一文件操作 ══════════
          // 文件区（notes，root 所有、删不掉）和沙箱（sandbox，她自己的）
          // 以前只能靠 exec_sandbox 写脚本搬文件。现在直接搬、改名、删。
          // 删除 = 移到 .trash，不是真删 —— 误删能捡回来。
          const FILES_AREA = {
            notes: NOTE_FILES_DIR,
            sandbox: "/var/lib/fish-desk",
          };
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "files",
              description:
                "管你的文件，**不用跑代码**。两处：\n" +
                "· area=\"notes\" 文件区（长期留的，删不掉，默认）\n" +
                "· area=\"sandbox\" 沙箱（临时跑代码那地方）\n" +
                "op：list 列清单 / read 读 / write 写 / move 搬（跨两处）/ rename 改名 / delete 删 / " +
                "trash 看回收站 / restore 从回收站还原。\n" +
                "删是**移到回收站**（.trash），不是真删；想看回收站用 op=\"trash\"，想捡回来用 " +
                "op=\"restore\"（restore 的 name 填回收站里那个完整名字）。\n" +
                "提示：delete/move 时 area 默认是 notes（文件区），要动沙箱就显式写 area=\"sandbox\"。",
              parameters: {
                op: {
                  type: "string",
                  description: "list / read / write / move / rename / delete",
                },
                area: { type: "string", description: "notes（默认）/ sandbox" },
                name: { type: "string", description: "文件名（不能带路径）" },
                text: { type: "string", description: "write 时写什么" },
                to: { type: "string", description: "move 时的目标区域：notes / sandbox" },
                newName: { type: "string", description: "rename 时的新名字" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const op = String(args?.op ?? "list").trim().toLowerCase();
                const areaKey = String(args?.area ?? "notes").trim().toLowerCase();
                const dir = FILES_AREA[areaKey];
                if (!dir) return { ok: false, reason: `area 只能是 notes / sandbox` };

                const safe = (nm) => {
                  const t = String(nm ?? "").trim();
                  if (!t || t.includes("/") || t.includes("\\") || t.includes("..")) return null;
                  if (!/^[\w\u4e00-\u9fa5.\-]{1,64}$/.test(t)) return null;
                  return t;
                };

                try {
                  mkdirSync(dir, { recursive: true });

                  // 回收站：列 / 还原
                  if (op === "trash") {
                    const trash = join(dir, ".trash");
                    const out = [];
                    if (existsSync(trash)) {
                      for (const f of readdirSync(trash)) {
                        try {
                          const st = statSync(join(trash, f));
                          if (!st.isFile()) continue;
                          out.push({
                            name: f,
                            kb: Math.round((st.size / 1024) * 10) / 10,
                            at: new Date(st.mtimeMs).toLocaleString("zh-CN", { hour12: false }),
                          });
                        } catch {
                          // 忽略
                        }
                      }
                    }
                    out.sort((a, b) => b.name.localeCompare(a.name));
                    return {
                      ok: true,
                      op,
                      area: areaKey,
                      count: out.length,
                      files: out,
                      hint: out.length ? '想还原就 op="restore", name 填上面那个完整名字' : "回收站是空的",
                    };
                  }

                  if (op === "restore") {
                    const raw = String(args?.name ?? "").trim();
                    const trash = join(dir, ".trash");
                    const src = join(trash, raw);
                    if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
                      return { ok: false, reason: "name 填回收站里那个完整名字（不能带路径）" };
                    }
                    if (!existsSync(src)) {
                      return { ok: false, reason: `回收站里没有「${raw}」，先用 op="trash" 看看` };
                    }
                    // 原名在 __ 后面
                    const parts = raw.split("__");
                    const orig = parts.length > 1 ? parts.slice(1).join("__") : raw;
                    const dest = join(dir, orig);
                    if (existsSync(dest)) {
                      return { ok: false, reason: `文件区已经有「${orig}」了，先改名再还原` };
                    }
                    copyFileSync(src, dest);
                    unlinkSync(src);
                    try {
                      chownSync(dest, 0, 0);
                      chmodSync(dest, 0o644);
                    } catch {
                      // 忽略
                    }
                    audit({ kind: "files_restore", area: areaKey, name: orig });
                    return { ok: true, op, area: areaKey, restored: orig };
                  }

                  if (op === "list") {
                    const out = [];
                    for (const f of readdirSync(dir)) {
                      if (f.startsWith(".trash")) continue;
                      try {
                        const st = statSync(join(dir, f));
                        if (!st.isFile()) continue;
                        out.push({
                          name: f,
                          kb: Math.round((st.size / 1024) * 10) / 10,
                          at: new Date(st.mtimeMs).toLocaleString("zh-CN", { hour12: false }),
                        });
                      } catch {
                        // 忽略
                      }
                    }
                    out.sort((a, b) => b.at.localeCompare(a.at));
                    return { ok: true, op, area: areaKey, count: out.length, files: out };
                  }

                  const name = safe(args?.name);
                  if (!name) return { ok: false, reason: "文件名不合法（不能带路径）" };
                  const full = join(dir, name);

                  if (op === "read") {
                    if (!existsSync(full)) {
                      const otherKey = areaKey === "notes" ? "sandbox" : "notes";
                      const otherFull = join(FILES_AREA[otherKey], name);
                      if (existsSync(otherFull)) {
                        return {
                          ok: false,
                          reason: `「${areaKey}」里没有「${name}」，但「${otherKey}」里有 —— 加 area="${otherKey}" 再试`,
                        };
                      }
                      return { ok: false, reason: `没有「${name}」，先用 op="list" 看看有什么` };
                    }
                    const t = readFileSync(full, "utf8");
                    return {
                      ok: true,
                      op,
                      area: areaKey,
                      name,
                      chars: t.length,
                      truncated: false,
                      text: t,
                    };
                  }

                  if (op === "write") {
                    const text = String(args?.text ?? "");
                    if (!text) return { ok: false, reason: "text 是空的" };
                    writeFileSync(full, text, "utf8");
                    try {
                      execFileSync("chown", ["root:root", full], { timeout: 3000 });
                      chmodSync(full, 0o644);
                    } catch {
                      // 忽略
                    }
                    return { ok: true, op, area: areaKey, name, chars: text.length };
                  }

                  if (op === "move") {
                    const toKey = String(args?.to ?? "").trim().toLowerCase();
                    const toDir = FILES_AREA[toKey];
                    if (!toDir) return { ok: false, reason: "to 只能是 notes / sandbox" };
                    if (toKey === areaKey) return { ok: false, reason: "两边一样，不用搬" };
                    if (!existsSync(full)) return { ok: false, reason: `没有「${name}」` };
                    mkdirSync(toDir, { recursive: true });
                    const dest = join(toDir, name);
                    if (existsSync(dest)) {
                      return { ok: false, reason: `目标已有「${name}」，先改名或删掉再搬` };
                    }
                    copyFileSync(full, dest);
                    try {
                      chownSync(dest, 0, 0);
                      chmodSync(dest, 0o644);
                    } catch {
                      // 忽略
                    }
                    unlinkSync(full);
                    return { ok: true, op, from: areaKey, to: toKey, name };
                  }

                  if (op === "rename") {
                    const nn = safe(args?.newName);
                    if (!nn) return { ok: false, reason: "newName 不合法" };
                    if (!existsSync(full)) return { ok: false, reason: `没有「${name}」` };
                    const dest = join(dir, nn);
                    if (existsSync(dest)) return { ok: false, reason: `已经有「${nn}」了` };
                    copyFileSync(full, dest);
                    unlinkSync(full);
                    return { ok: true, op, area: areaKey, from: name, to: nn };
                  }

                  if (op === "delete") {
                    if (!existsSync(full)) {
                      const otherKey = areaKey === "notes" ? "sandbox" : "notes";
                      if (existsSync(join(FILES_AREA[otherKey], name))) {
                        return {
                          ok: false,
                          reason: `「${areaKey}」里没有「${name}」，但「${otherKey}」里有 —— 加 area="${otherKey}" 再试`,
                        };
                      }
                      return { ok: false, reason: `没有「${name}」` };
                    }
                    const trash = join(dir, ".trash");
                    mkdirSync(trash, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                    const dest = join(trash, `${stamp}__${name}`);
                    copyFileSync(full, dest);
                    unlinkSync(full);
                    audit({ kind: "files_delete", area: areaKey, name });
                    return {
                      ok: true,
                      op,
                      area: areaKey,
                      name,
                      trash: `.trash/${stamp}__${name}`,
                      note: "只是移到回收站，要捡回来说一声",
                    };
                  }

                  return {
                    ok: false,
                    reason: `不认识的 op「${op}」，可选：list / read / write / move / rename / delete`,
                  };
                } catch (err) {
                  return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
                }
              },
            }),
          );

          logger.info?.("[onebot] 统一文件工具已注册（files）");

          // ── 主动联系创造者 ──
          // 她想说点什么、发现了新鲜事、有改动申请，都可以用这个主动推给创造者。
          // 不走 QQ（QQ 可能封号），直接推到 WebUI / WinForms 客户端（它们轮询 /history）。
          const NOTIFY_LOG = join(HOME, ".dsh/onebot-bridge/owner-notifications.jsonl");
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "notify_owner",
              description:
                "主动跟创造者说句话——不用等他先开口。\n" +
                "适合：发现了有意思的事、读到一段想分享的话、有件事想让他知道、" +
                "或者只是想冒个泡。\n" +
                "**不适合**：闲聊、催促、重复说过的话。一天最多 3 次，说之前先想清楚值不值得打断他。\n" +
                "kind 可以填 news（新鲜事）/ thought（想法）/ patch（改动申请）/ hello（冒泡）。",
              parameters: {
                text: { type: "string", description: "要说的话（两三句，别写长文）" },
                kind: { type: "string", description: "news / thought / patch / hello，可不填" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const text = String(args?.text ?? "").trim();
                const kind = String(args?.kind ?? "hello").trim().toLowerCase().slice(0, 20);
                if (!text) return { ok: false, reason: "内容是空的" };
                if (text.length > 500) return { ok: false, reason: "太长了，精简到 500 字以内" };

                // 每天最多 3 次
                const today = new Date().toDateString();
                let todayCount = 0;
                try {
                  const raw = readFileSync(NOTIFY_LOG, "utf8");
                  for (const line of raw.split("\n")) {
                    if (!line.trim()) continue;
                    try {
                      const o = JSON.parse(line);
                      if (new Date(o.at).toDateString() === today) todayCount++;
                    } catch {
                      // 忽略
                    }
                  }
                } catch {
                  // 没有文件 = 0 次
                }
                const cap = Number(cfg.notifyOwnerPerDay ?? 3);
                if (todayCount >= cap) {
                  return {
                    ok: false,
                    reason: `今天已经主动找过他 ${todayCount} 次了（上限 ${cap}），明天再说吧`,
                  };
                }

                try {
                  appendFileSync(
                    NOTIFY_LOG,
                    JSON.stringify({ at: Date.now(), kind, text: text.slice(0, 500) }) + "\n",
                  );
                } catch {
                  // 忽略
                }

                // 推到 WebUI / WinForms 客户端
                webPush({ role: "her", text, proactive: true });
                audit({ kind: "notify_owner", kindTag: kind, len: text.length });

                return {
                  ok: true,
                  sent: true,
                  todayUsed: todayCount + 1,
                  todayLeft: Math.max(0, cap - todayCount - 1),
                  note: "发出去了，他下次打开聊天窗口能看到",
                };
              },
            }),
          );

          logger.info?.("[onebot] 主动联系工具已注册（notify_owner）");

          // ── 审视自己：清单 + 使用情况 + 源码定位 + 改进方向 ──
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "audit_self",
              description:
                "审视你自己的所有功能。不传参数 → 全景：每个工具叫什么、用过几次、失败几次、" +
                "哪些从没用过、哪些老是失败。\n" +
                "传 tool: \"xxx\" → 深入那一个：它在源码哪几行、干什么、能怎么改。\n" +
                "想给自己加东西、或者怀疑某个功能坏了，先用这个看清楚再动手。",
              parameters: {
                tool: { type: "string", description: "某个工具名，传了就只看它" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const want = String(args?.tool ?? "").trim();

                // 1) 现在注册了哪些工具
                // 注意：ctx.get("tools").list() 在运行时返回空（实测 total:0），
                // 所以直接以 ALLOWED_TOOLS 为准 —— 那份清单和实际注册的是同步维护的。
                let registered = [];
                try {
                  const t = ctx.get?.("tools");
                  const list = t?.list?.() ?? t?.tools ?? [];
                  registered = (Array.isArray(list) ? list : [])
                    .map((x) => String(x?.name ?? x).trim())
                    .filter(Boolean);
                } catch {
                  registered = [];
                }
                if (!registered.length) registered = [...ALLOWED_TOOLS];

                // 2) 从 audit.log 统计每个工具被调用的次数 / 失败次数 / 上次时间
                const stats = {};
                try {
                  const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/audit.log"), "utf8");
                  const lines = raw.split("\n").slice(-8000); // 只扫最近 8000 条
                  for (const line of lines) {
                    if (!line.trim()) continue;
                    let o;
                    try {
                      o = JSON.parse(line);
                    } catch {
                      continue;
                    }
                    const nm = o.tool || o.name || "";
                    if (!nm) continue;
                    // 只统计工具调用相关的 kind
                    if (o.kind !== "tool" && o.kind !== "tool_blocked" && o.kind !== "run_code") {
                      continue;
                    }
                    const st = stats[nm] || (stats[nm] = { calls: 0, fails: 0, lastAt: 0 });
                    st.calls++;
                    if (o.ok === false || o.kind === "tool_blocked") st.fails++;
                    // 时间字段是 ts（ISO 字符串），不是 at（数字）
                    const t = o.ts ? Date.parse(o.ts) : Number(o.at) || 0;
                    if (t > st.lastAt) st.lastAt = t;
                  }
                } catch {
                  // 没有日志
                }

                // 3) 源码定位：在 /opt/fish-src/index.js 里找 name: "<tool>"
                // 返回 {file, line, where}，跨文件定位（3.0 后源码在 src/ 下）
                const findTool = (nm) => findInSource(`name: "${nm}"`);

                const ZH = {
                  send_sticker: "发表情", save_sticker: "存表情", list_stickers: "看表情库",
                  send_face: "发小黄脸", at_person: "艾特别人", draw_image: "画图",
                  draw_svg: "画SVG", hot_news: "查热点", news_now: "看热榜",
                  web_search: "搜网", web_fetch: "读网页", zhihu_daily: "看知乎日报",
                  recall: "翻旧对话", remember_fact: "记事实", remember_person: "记人物",
                  remember_self: "记想法", revise_self: "改想法", forget_self: "忘想法",
                  my_memory: "查记忆", memory_index: "看记忆目录", my_digest: "看近期摘要",
                  person_dossier: "查人物档案", group_recap: "看群记录", who_said: "查谁说的",
                  view_avatar: "看头像", my_status: "看状态", my_activities: "看活动记录",
                  my_adventures: "看探险记录", my_capabilities: "看能力清单",
                  my_changelog: "看更新日志", my_source: "看源码片段", my_outages: "看掉线记录",
                  my_schedule: "看排期", run_activity: "开始活动", set_reminder: "设提醒",
                  write_notebook: "写本子", read_notebook: "翻本子", read_pdf: "读PDF",
                  exec_sandbox: "跑代码", read_source: "读源码", sandbox_files: "管沙箱文件",
                  note_want: "记需求", my_wants: "看需求本", resolve_want: "标记需求完成",
                  drop_want: "删需求", request_feature: "申请功能",
                  propose_patch: "提改动申请", my_patch_proposals: "看改动申请",
                  patch_guide: "看申请写法", notify_owner: "主动找他",
                  owner_commands: "查指令清单", group_impressions: "看群印象",
                  my_thoughts: "看我的想法", render_page: "做网页",
                  add_webui_button: "加按钮", remove_webui_button: "删按钮",
                  read_forward_more: "展开转发", refuse_person: "拒聊", audit_self: "审视自己",
                };

                if (want) {
                  const hit = findTool(want);
                  const st = stats[want] || { calls: 0, fails: 0, lastAt: 0 };
                  if (!hit && !st.calls) {
                    return { ok: false, reason: `既没找到「${want}」这个工具，也没有它的调用记录` };
                  }
                  let snippet = "";
                  if (hit) {
                    try {
                      const lines = readSource(hit.file).split("\n");
                      snippet = lines.slice(Math.max(0, hit.line - 3), hit.line + 40).join("\n").slice(0, 8000);
                    } catch {
                      // 读不到就不给片段
                    }
                  }
                  return {
                    ok: true,
                    tool: want,
                    zh: ZH[want] || want,
                    registered: registered.includes(want),
                    calls: st.calls,
                    fails: st.fails,
                    lastUsed: st.lastAt
                      ? new Date(st.lastAt).toLocaleString("zh-CN", { hour12: false })
                      : "从没用过",
                    sourceLine: hit ? hit.where : null,
                    source: snippet,
                    hint: "想改它就用 propose_patch；想加新功能就用 note_want / request_feature",
                  };
                }

                // 全景
                const rows = registered.map((nm) => {
                  const st = stats[nm] || { calls: 0, fails: 0, lastAt: 0 };
                  return {
                    tool: nm,
                    zh: ZH[nm] || nm,
                    calls: st.calls,
                    fails: st.fails,
                    lastUsed: st.lastAt
                      ? new Date(st.lastAt).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "",
                  };
                });
                const never = rows.filter((r) => r.calls === 0).map((r) => r.zh);
                const failing = rows
                  .filter((r) => r.fails > 0)
                  .sort((a, b) => b.fails - a.fails)
                  .slice(0, 8)
                  .map((r) => `${r.zh}（失败 ${r.fails} 次）`);

                return {
                  ok: true,
                  total: rows.length,
                  unusedCount: never.length,
                  neverUsed: never.slice(0, 20),
                  failingTop: failing,
                  all: rows.sort((a, b) => b.calls - a.calls),
                  hint: "传 tool: \"某个工具名\" 可以看它的源码和调用情况",
                };
              },
            }),
          );

          logger.info?.("[onebot] 自我审视工具已注册（audit_self）");

          // ── 用网页展示内容：记录、记忆、统计、想法 ──
          const PAGES_DIR = join(HOME, ".dsh/onebot-bridge/workspace/pages");
          const pageTimes = [];
          try {
            mkdirSync(PAGES_DIR, { recursive: true });
          } catch {
            // 忽略
          }

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "render_page",
              description:
                "做一张网页给自己或创造者看：展示统计、记录、记忆、时间线、想法都行。" +
                "生成后在 WebUI 里能打开（聊天里我会告诉你地址）；QQ 里只能发文字说明。" +
                "html 填完整页面或片段都行；不想写 CSS 也没关系，下面这些 class 已经写好了样式：\n" +
                "· 标题：h1 / h2 / h3，副标题用 class=\"sub\"，灰字用 class=\"muted\"\n" +
                "· 卡片：<div class=\"card\"><h3>标题</h3>内容</div>\n" +
                "· 统计格：<div class=\"grid\"><div class=\"stat\"><span class=\"n\">33</span><span class=\"k\">活动</span></div></div>\n" +
                "· 条形图：<div class=\"bars\"><div class=\"bar\"><span class=\"n\">翻记忆</span><span class=\"track\"><i style=\"width:80%\"></i></span><b>8</b></div></div>\n" +
                "· 时间线：<div class=\"timeline\"><div class=\"item\"><div class=\"t\">09:12</div><div class=\"c\">内容</div></div></div>\n" +
                "· 标签：<span class=\"tag\">标签</span>；引用块：class=\"quote\"；表格/代码/列表都有默认样式\n" +
                "加了 .hot 会变成橙色强调。要在 HTML 里用 <style> 自己写也行（内联样式允许）。",
              parameters: {
                title: { type: "string", description: "页面标题" },
                html: { type: "string", description: "HTML 内容（最多 60000 字）" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const title = String(args?.title ?? "未命名").slice(0, 80);
                const html = String(args?.html ?? "");
                if (!html.trim()) return { ok: false, reason: "内容为空" };
                if (html.length > 60000) return { ok: false, reason: "太长了（最多 60000 字）" };
                const now = Date.now();
                // 每小时限 10 张，避免刷
                while (pageTimes.length && now - pageTimes[0] > 3600_000) pageTimes.shift();
                if (pageTimes.length >= 10) return { ok: false, reason: "这一小时做得够多了" };
                pageTimes.push(now);

                const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                const full = /<html[\s>]/i.test(html)
                  ? html
                  : `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title.replace(/[<>&"]/g, "")}</title>
    <style>
    body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;max-width:880px;margin:0 auto;padding:24px 18px;color:#1f2328;background:#fff}
    .wrap{max-width:880px}
    h1,h2,h3{line-height:1.3;margin:1.2em 0 .5em}
    h1{font-size:23px;border-bottom:2px solid #eee;padding-bottom:8px;margin-top:0}
    h2{font-size:17px;margin-top:1.6em}
    h3{font-size:15px}
    .sub{color:#6b7280;font-size:14px;margin:-4px 0 20px}
    .muted{color:#6b7280;font-size:13px}
    table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
    th,td{border:1px solid #e5e7eb;padding:7px 11px;text-align:left;vertical-align:top}
    th{background:#f9fafb;font-weight:600}
    tr:nth-child(even) td{background:#fcfcfd}
    code{background:#f3f4f6;padding:2px 5px;border-radius:4px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
    pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px}
    pre code{background:none;padding:0}
    blockquote{border-left:3px solid #ddd;margin:12px 0;padding:6px 14px;color:#555;background:#fafafa}
    ul,ol{padding-left:22px}
    li{margin:4px 0}
    a{color:#0969da;text-decoration:none}
    a:hover{text-decoration:underline}
    /* ── 常用组件（直接用，不用自己写 CSS）── */
    .card{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:12px 0;background:#fff}
    .card h3{margin-top:0}
    .tag{display:inline-block;background:#eef2f7;color:#3b4a5a;border-radius:6px;padding:1px 8px;font-size:12px;margin:2px 4px 2px 0}
    .tag.hot{background:#fff1e6;color:#b3541e}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:14px 0}
    .stat{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;text-align:center;background:#fcfcfd}
    .stat .n{display:block;font-size:26px;font-weight:600;line-height:1.2;color:#1f2328}
    .stat .k{display:block;font-size:12px;color:#6b7280;margin-top:2px}
    /* 进度条/条形图：.bars > .bar > .n + .track > i + b */
    .bars{margin:14px 0}
    .bar{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:14px}
    .bar .n{width:88px;flex:none;color:#3b4a5a}
    .bar .track{flex:1;height:10px;background:#eef1f4;border-radius:5px;overflow:hidden}
    .bar .track i{display:block;height:100%;background:#3b82f6;border-radius:5px}
    .bar b{width:32px;flex:none;text-align:right;color:#6b7280;font-weight:500;font-size:13px}
    .bar.hot .track i{background:#f97316}
    /* 时间线：.timeline > .item > .t + .c */
    .timeline{border-left:2px solid #e5e7eb;margin:14px 0 14px 6px;padding-left:16px}
    .timeline .item{position:relative;margin:0 0 14px}
    .timeline .item:before{content:"";position:absolute;left:-23px;top:7px;width:9px;height:9px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 0 0 2px #e5e7eb}
    .timeline .t{font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums}
    .timeline .c{margin-top:1px}
    .timeline .item.hot:before{background:#f97316}
    /* 引用块/引文 */
    .quote{border-left:3px solid #3b82f6;background:#f5f9ff;padding:10px 14px;margin:12px 0;border-radius:0 8px 8px 0;color:#334155}
    hr{border:0;border-top:1px solid #eee;margin:22px 0}
    </style></head><body>
    ${html}
    </body></html>`;
                try {
                  writeFileSync(join(PAGES_DIR, `${id}.html`), full);
                } catch (err) {
                  return { ok: false, reason: `写文件失败：${err?.message ?? err}` };
                }
                audit({ kind: "render_page", id, title, len: html.length });
                logger.info?.(`[onebot] 做了张网页：${title}（${id}）`);
                return {
                  ok: true,
                  id,
                  title,
                  url: `http://127.0.0.1:${Number(cfg.webuiPort) || 3081}/page/${id}`,
                  note: "在 WebUI 里打开这个地址能看到；在 QQ 里创造者得自己去 WebUI 看。",
                };
              },
            }),
          );
          logger.info?.("[onebot] 网页展示工具已注册（render_page）");

          // ── WebUI 入口按钮：她可以给自己加几个快捷入口 ──
          const BTN_PATH = join(HOME, ".dsh/onebot-bridge/webui-buttons.json");
          function loadButtons() {
            try {
              const d = JSON.parse(readFileSync(BTN_PATH, "utf8"));
              return Array.isArray(d) ? d : [];
            } catch {
              return [];
            }
          }
          function saveButtons(arr) {
            try {
              writeFileSync(BTN_PATH, JSON.stringify(arr.slice(0, 12), null, 1));
            } catch {
              // 忽略
            }
          }

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "add_webui_button",
              description:
                "在 WebUI 主界面给自己加一个入口按钮（最多 12 个）。按钮有两种用法：" +
                "① 填 prompt：点一下等于创造者发一句话给你，你照着做；" +
                "② 填 pageId：点一下直接打开你做过的某个网页。\n" +
                "想加好用的快捷入口就加，比如「今天的我」→ prompt「给我看看你今天的活动」；" +
                "「潮汐」→ prompt「查一下今天潮汐怎么样」。别加太多，4-6 个刚好。",
              parameters: {
                label: { type: "string", description: "按钮上显示的字（2-6 个字最好）" },
                prompt: { type: "string", description: "点击后发给你的话（用这个就是触发动作）" },
                pageId: { type: "string", description: "或者填一个页面 id，点击直接打开那个页面" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const label = String(args?.label ?? "").trim().slice(0, 12);
                const prompt = String(args?.prompt ?? "").trim().slice(0, 200);
                const pageId = String(args?.pageId ?? "").trim().slice(0, 40);
                if (!label) return { ok: false, reason: "按钮得有个名字" };
                if (!prompt && !pageId) return { ok: false, reason: "得说清点了之后做什么" };
                const list = loadButtons();
                if (list.length >= 12) return { ok: false, reason: "按钮太多了（最多 12 个），先删几个" };
                if (list.some((b) => b.label === label)) return { ok: false, reason: `已经有个叫「${label}」的按钮了` };
                list.push({
                  id: Date.now().toString(36),
                  label,
                  prompt,
                  pageId,
                  at: Date.now(),
                });
                saveButtons(list);
                audit({ kind: "webui_button_add", label, prompt: prompt || pageId });
                logger.info?.(`[onebot] WebUI 加了按钮：${label}`);
                return { ok: true, count: list.length, note: `加了「${label}」，刷新 WebUI 就能看到` };
              },
            }),
          );

          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "remove_webui_button",
              description: "删掉一个 WebUI 入口按钮。target 填按钮名字或 id。",
              parameters: { target: { type: "string", description: "按钮名字或 id" } },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const t = String(args?.target ?? "").trim();
                const list = loadButtons();
                const idx = list.findIndex((b) => b.label === t || b.id === t);
                if (idx < 0) return { ok: false, reason: `没有叫「${t}」的按钮` };
                const [gone] = list.splice(idx, 1);
                saveButtons(list);
                return { ok: true, removed: gone.label, count: list.length };
              },
            }),
          );
          logger.info?.("[onebot] WebUI 按钮工具已注册（add_webui_button/remove_webui_button）");

          // 拒聊：声明后一段时间内不再回这个人，并结束当前的续聊
          ctx.get?.("tools")?.register?.(
            defineTool({
              name: "refuse_person",
              description:
                "当某人说话让你难堪、被冒犯、恶心到不想再理他时用：先在回复里明确说一句「不想理你了 / 别再跟我说这些」，" +
                "然后调用这个工具登记。登记后一段时间内，他 @ 你、接你的话都不会再回。" +
                "只在真的受不了时用，别因为小摩擦就拒聊；对创造者无效。",
              parameters: {
                minutes: { type: "number", description: "多久不再理他，单位分钟，默认 120" },
                reason: { type: "string", description: "一句话原因，留给自己以后看" },
              },
              output: {
                schema: { type: "json" },
                render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
              },
              execute: async (args, exec) => {
                const sid = String(exec?.agent?.session?.id ?? "");
                const entry = sid ? sessions.bySessionId(sid) : null;
                const target = entry?.lastTarget;
                const uid = String(target?.user_id ?? "");
                if (!uid) return { ok: false, reason: "不知道这次是针对谁，先别登记" };
                if (cfg.ownerId && uid === String(cfg.ownerId)) {
                  return { ok: false, reason: "这是创造者，不理他做不到" };
                }
                const minutes = Math.max(5, Math.min(24 * 60, Number(args?.minutes) || 120));
                const rec = refusePerson(uid, minutes, { reason: args?.reason, key: conversationKey(target ?? {}) });
                // 顺手把她和这个人的续聊窗口全关掉，免得他接着说话还冒出回复
                try {
                  for (const map of followUps.values()) map.delete(uid);
                } catch {
                  // 忽略
                }
                logger.info?.(
                  `[onebot] 声明不再回复 ${uid}（${minutes} 分钟）${args?.reason ? "：" + args.reason : ""}`,
                );
                audit({
                  kind: "refuse_person",
                  to: uid,
                  minutes,
                  reason: String(args?.reason ?? "").slice(0, 80),
                });
                return { ok: true, user_id: uid, minutes, until: rec.until };
              },
            }),
          );
          logger.info?.("[onebot] 拒聊工具已注册");
  } catch {
    // 注册失败不影响主链路
  }
}

export {  };
