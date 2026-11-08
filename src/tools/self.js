import { listMsgKeys, readMsgLog } from "../store/msglog.js";
import { renderMsgRec } from "../onebot/render.js";
import { saveConfig } from "../store/config.js";
import { audit } from "../core/audit.js";
import { WAKE_KEY, cleanQzone, parrotOf, todayKey } from "../util/misc.js";
import { addSelfPlan, readSelfPlan, updateSelfPlan } from "../store/selfplan.js";
// 自我状态/配置/活动类工具。

export function registerSelfTools(app) {
  const { SAFE_CONFIG_KEYS, cfg, client, crossGroupScope, dailyReflect, groupPatrolList, isOwner, loadGroupMeta, loadQzonePlan, loadSelfModel, loadSelfState, loadWatch, logger, patchSelfState, pendingFriends, pickTarget, saveQzonePlan, saveWatch, sessions, pluginCtx: ctx } = app;
  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "watch_topic",
            description:
              "加一条关注规则。以后群里出现这个词、或者这个人说话，会被送到你面前。" +
              "加什么由你定——你最近在意什么就加什么。不是必须加，觉得吵就不用。",
            parameters: {
              keyword: { type: "string", description: "想关注的话题词，比如「潮汐」「世说新语」" },
              person: { type: "string", description: "想关注的人（QQ 号），他说话时会提醒你" },
              note: { type: "string", description: "为什么关注，一句话备忘" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const w = loadWatch();
              const added = [];
              const kw = String(args?.keyword ?? "").trim();
              const ps = String(args?.person ?? "").trim();
              const note = String(args?.note ?? "").trim();
              if (!kw && !ps) return { ok: false, reason: "keyword 和 person 至少填一个" };
              if (kw && !w.topics.includes(kw)) {
                w.topics.push(kw);
                added.push("话题「" + kw + "」");
              }
              if (ps && !w.people.includes(ps)) {
                w.people.push(ps);
                added.push("人 " + ps);
              }
              if (note) w.notes.push({ text: note, at: Date.now() });
              if (w.notes.length > 50) w.notes = w.notes.slice(-50);
              saveWatch(w);
              return {
                ok: true,
                added,
                total: { topics: w.topics.length, people: w.people.length },
                message: added.length ? "记下了：" + added.join("、") : "这条已经在关注里了",
              };
            },
          }),
        );

        reg(
          defineTool({
            name: "unwatch_topic",
            description: "去掉一条关注规则。觉得吵了就去掉，不用留。",
            parameters: {
              keyword: { type: "string", description: "要去掉的话题词" },
              person: { type: "string", description: "要去掉的人（QQ 号）" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const w = loadWatch();
              const kw = String(args?.keyword ?? "").trim();
              const ps = String(args?.person ?? "").trim();
              const before = w.topics.length + w.people.length;
              if (kw) w.topics = w.topics.filter((x) => x !== kw);
              if (ps) w.people = w.people.filter((x) => x !== ps);
              saveWatch(w);
              const after = w.topics.length + w.people.length;
              return { ok: true, removed: before - after };
            },
          }),
        );

        reg(
          defineTool({
            name: "my_watchlist",
            description: "看你都在关注什么。",
            parameters: {},
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async () => {
              const w = loadWatch();
              return {
                topics: w.topics,
                people: w.people,
                notes: (w.notes || []).slice(-5).map((x) => x.text),
              };
            },
          }),
        );

        reg(
          defineTool({
            name: "group_activity",
            description:
              "看各个群最近有没有动静：多少条、谁在说话、聊的是什么。" +
              "从本地记录读，QQ 掉线时也能用。先看哪个群活着，再去翻原文。",
            parameters: {
              hours: { type: "number", description: "回看多少小时，默认 24" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const hours = Number(args?.hours) || 24;
              const since = Date.now() - hours * 3600_000;
              // 用落盘记录算真实条数（group-meta 的 recent 只留 30 行，会把热群算成 30）
              const detail = [];
              for (const k of listMsgKeys()) {
                if (!k.startsWith("group:")) continue;
                const gid = k.slice(6);
                const rows = readMsgLog(k, 3000).filter((r) => (Number(r.t) || 0) * 1000 >= since);
                if (!rows.length) continue;
                const last = rows[rows.length - 1];
                detail.push({
                  group: gid,
                  count: rows.length,
                  lastAt: (Number(last.t) || 0) * 1000,
                  last: renderMsgRec(last).slice(0, 100),
                });
              }
              // 补上 group-meta 里有、但还没落盘的群（保持兼容）
              try {
                const meta = loadGroupMeta() || {};
                for (const gid of Object.keys(meta)) {
                  if (detail.some((d) => d.group === gid)) continue;
                  const m = meta[gid] || {};
                  const cnt = (Array.isArray(m.recent) ? m.recent : []).filter(
                    (r) => (Number(r?.t) || 0) >= since,
                  ).length;
                  if (cnt > 0) {
                    detail.push({ group: gid, count: cnt, lastAt: Number(m.lastMessageAt || 0), last: "", source: "group-meta" });
                  }
                }
              } catch {
                // 兼容失败不影响
              }
              detail.sort((a, b) => b.lastAt - a.lastAt);
              return {
                ok: true,
                hours,
                groups: detail.length,
                active: detail.filter((x) => x.count > 0).length,
                shown: detail.length,
                total: detail.length,
                detail,
              };
            },
          }),
        );

        reg(
          defineTool({
            name: "group_patrol",
            description:
              "翻某个群最近的原文。想知道那个群到底在聊什么就用它——" +
              "group_recap 给你总结，这个给你原话。",
            parameters: {
              group: { type: "string", description: "群号" },
              hours: { type: "number", description: "回看多少小时，默认 24" },
              limit: { type: "number", description: "这次要看几条，默认 40（最多 200）" },
              before: { type: "string", description: "从哪条消息往前翻（上次返回的 nextCursor）" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const gid = String(args?.group ?? "").trim();
              if (!gid) return { ok: false, reason: "要填群号" };
              const hours = Number(args?.hours) || 24;
              const limit = Math.min(200, Math.max(1, Number(args?.limit) || 40));
              let _rows = readMsgLog("group:" + gid, 5000).filter(
                (r) => (Number(r.t) || 0) * 1000 > Date.now() - hours * 3600_000,
              );
              if (_rows.length) {
                // before：从某条消息往前翻（游标）
                const before = String(args?.before || "").trim();
                let cut = _rows.length;
                if (before) {
                  const at = _rows.findIndex((r) => String(r.id) === before);
                  if (at >= 0) cut = at;
                }
                const end = cut;
                const start = Math.max(0, end - limit);
                const picked = _rows.slice(start, end);
                const scope = crossGroupScope(gid, exec);
                return {
                  ok: true,
                  group: gid,
                  source: "msglog",
                  hours,
                  total: end,
                  shown: picked.length,
                  hasMore: start > 0,
                  nextCursor: start > 0 ? String(_rows[start]?.id || "") : "",
                  note: [
                    start > 0 ? `还有 ${start} 条更早的，用 before=${String(_rows[start]?.id || "")} 继续` : "",
                    scope,
                  ]
                    .filter(Boolean)
                    .join(" "),
                  lines: picked.map((r) => `[群 ${gid}] ${renderMsgRec(r)}`),
                };
              }
              const r = groupPatrolList(gid, hours);
              if (!r) return { ok: false, reason: "没有这个群的记录（群号对不对？）" };
              const scope2 = crossGroupScope(gid, exec);
              return {
                ok: true,
                ...r,
                lines: (r.lines || []).map((l) => `[群 ${gid}] ${l}`),
                note: [r.note, scope2].filter(Boolean).join(" "),
              };
            },
          }),
        );

        logger.info?.("[onebot] 关注规则 + 群巡查工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 关注规则工具注册失败：${err?.message ?? err}`);
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "set_config",
            description:
              "改你自己的设置。创造者说「回复短一点」「以后叫我老板」「每分钟最多 3 条」" +
              "这类话的时候用它。\n\n" +
              "**只有创造者能改**——别人让你改，工具会拒绝，你不用怕。\n" +
              "改错了能改回来，所以不用反复确认。",
            parameters: {
              key: {
                type: "string",
                description:
                  "要改哪一项。常用：maxReplyChars / styleHint / typingSecPerChar / " +
                  "typingQueueMax / proactiveChance / activeStartHour",
              },
              value: { type: "string", description: "改成什么。数字直接填数字" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!isOwner(exec)) return { ok: false, reason: "这个只有创造者能改。" };
              const key = String(args?.key ?? "").trim();
              const rawVal = String(args?.value ?? "").trim();
              if (!key) return { ok: false, reason: "key 不能空" };
              if (!SAFE_CONFIG_KEYS.has(key)) {
                return {
                  ok: false,
                  reason:
                    "「" + key + "」不在可改范围内。能改的有：" +
                    Array.from(SAFE_CONFIG_KEYS).slice(0, 8).join(" / ") + " …",
                };
              }
              let val = rawVal;
              if (/^-?\d+(\.\d+)?$/.test(rawVal)) val = Number(rawVal);
              else if (rawVal === "true") val = true;
              else if (rawVal === "false") val = false;
              const old = cfg[key];
              cfg[key] = val;
              if (!saveConfig()) {
                cfg[key] = old;
                return { ok: false, reason: "写盘失败，改动已回滚" };
              }
              logger.info?.("[onebot] 配置改了 " + key + ": " + JSON.stringify(old) + " → " + JSON.stringify(val));
              audit({ kind: "config_set", key, from: old, to: val });
              return { ok: true, key, from: old, to: val, note: "改好了。" };
            },
          }),
        );

        reg(
          defineTool({
            name: "read_config",
            description: "看你现在的设置。不传 key 就返回常用的几项。",
            parameters: {
              key: { type: "string", description: "要看哪一项，留空看常用项" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const key = String(args?.key ?? "").trim();
              if (key) return { ok: true, key, value: cfg[key] };
              const pick = [
                "maxReplyChars", "typingSecPerChar", "typingQueueMax",
                "proactiveChance", "activeStartHour", "activeEndHour",
                "stickerEnabled", "qzonePerDayMax",
              ];
              const out = {};
              for (const k of pick) out[k] = cfg[k];
              return { ok: true, config: out };
            },
          }),
        );

        reg(
          defineTool({
            name: "manage_group",
            description:
              "退群或者加群。\n\n" +
              "**退群前先问一句**——除非创造者已经明确说了「退吧」。\n" +
              "加群做不了（OneBot 没有主动加群的接口），只能处理别人发来的邀请。",
            parameters: {
              action: { type: "string", description: "leave 或 join" },
              group: { type: "string", description: "群号" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!isOwner(exec)) return { ok: false, reason: "这个只有创造者能让我做。" };
              const action = String(args?.action ?? "").trim().toLowerCase();
              const group = String(args?.group ?? "").trim();
              if (!group) return { ok: false, reason: "要填群号" };
              if (action === "join") {
                return {
                  ok: false,
                  reason:
                    "加群做不了——OneBot 没有主动加群的接口。" +
                    "要进群只能让别人邀请你，然后我用 handle_request 同意。",
                };
              }
              if (action !== "leave") return { ok: false, reason: "action 只能是 leave 或 join" };
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上，等连上再做。" };
              try {
                await client.call("set_group_leave", { group_id: Number(group) });
                audit({ kind: "group_leave", group });
                logger.info?.("[onebot] 退出群 " + group);
                return { ok: true, action: "leave", group };
              } catch (e) {
                return { ok: false, reason: String(e?.message ?? e) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "handle_request",
            description:
              "处理别人发来的加群邀请、好友申请。\n\n" +
              "**别人发来的先问创造者**——别自己就同意了。\n" +
              "创造者自己的邀请可以直接同意。",
            parameters: {
              action: { type: "string", description: "approve 同意 或 reject 拒绝" },
              flag: { type: "string", description: "申请的唯一标识（好友申请的 friendUid）。不填就自动选最近一条" },
              sub_type: { type: "string", description: "friend（好友申请）或 invite（群邀请）。不填就自动判断" },
              req_time: { type: "string", description: "申请的 reqTime（可选，好友申请要用）" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!isOwner(exec)) return { ok: false, reason: "这个只有创造者能让我做。" };
              const action = String(args?.action ?? "").trim().toLowerCase();
              let flag = String(args?.flag ?? "").trim();
              const subType = String(args?.sub_type ?? "").trim();
              if (!["approve", "reject"].includes(action)) {
                return { ok: false, reason: "action 只能是 approve 或 reject" };
              }
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上，等连上再做。" };

              // 不传 flag 也能用：从待处理列表里挑最近一条
              let target = null;
              if (!flag) {
                const list = Array.from(pendingFriends.values())
                  .sort((a, b) => (b.at || 0) - (a.at || 0));
                if (!list.length) {
                  return {
                    ok: false,
                    reason: "现在没有待处理的好友申请。（群邀请用 sub_type=invite）",
                  };
                }
                target = list[0];
                flag = target.flag || target.uid;
                logger.info?.(
                  "[onebot] handle_request 自动选最近申请：" + (target.name || target.uid) + " flag=" + flag,
                );
              } else {
                // 传了 flag，从待处理里找它的类型
                for (const v of pendingFriends.values()) {
                  if (v.flag === flag || v.uid === flag) { target = v; break; }
                }
              }

              // 判断是好友申请还是群邀请
              const isFriend = subType ? subType === "friend" : !!(target && (target.uid || target.name));
              try {
                if (isFriend) {
                  // 好友申请：NapCat 用 set_buddy_req（不是 OneBot 的 set_friend_add_request）
                  // friendUid 是申请的唯一标识，reqTime 也要带上
                  const friendUid = String(flag);
                  const reqTime = String(args?.req_time ?? target?.reqTime ?? "");
                  await client.call("set_buddy_req", {
                    friendUid,
                    reqTime,
                    approve: action === "approve",
                  });
                  pendingFriends.delete(friendUid);
                  pendingFriends.delete(flag);
                  audit({ kind: "friend_request_handled", action, friendUid });
                  logger.info?.(
                    "[onebot] 好友申请 " + (action === "approve" ? "已同意" : "已拒绝") +
                    "：" + (target?.name || friendUid),
                  );
                  return {
                    ok: true,
                    action,
                    kind: "好友申请",
                    who: target?.name || "",
                    uid: friendUid,
                  };
                }
                // 群邀请
                await client.call("set_group_add_request", {
                  flag,
                  sub_type: subType || "invite",
                  approve: action === "approve",
                });
                audit({ kind: "group_request", action, flag, subType });
                return { ok: true, action, flag, kind: "群邀请" };
              } catch (e) {
                return { ok: false, reason: String(e?.message ?? e) };
              }
            },
          }),
        );

        reg(
          defineTool({
            name: "list_requests",
            description:
              "看现在有哪些待处理的好友申请、群邀请。\n\n" +
              "有人要加你但还没批的时候，先用它看看是谁、要什么。\n" +
              "看完可以用 handle_request 同意或拒绝。",
            parameters: {},
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async () => {
              const list = Array.from(pendingFriends.values())
                .sort((a, b) => (b.at || 0) - (a.at || 0))
                .map((v) => ({
                  name: v.name || "",
                  uid: v.uid || "",
                  flag: v.flag || "",
                  message: v.message || "",
                  source: v.source || "",
                  at: v.at || 0,
                }));
              return { ok: true, count: list.length, requests: list };
            },
          }),
        );

        logger.info?.("[onebot] 配置/群管理工具已注册（set_config / read_config / manage_group / handle_request）");
      } catch (err) {
        logger.warn?.("[onebot] 配置/群管理工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        // ── 发说说 ──
        reg(
          defineTool({
            name: "send_qzone",
            description:
              "发一条 QQ 空间说说。用你自己的口吻写，不是复述别人的话。\n\n" +
              "创造者说「发条说说」时用它。也可以自己想到什么就发。\n" +
              "**不想发就不发**——内容太短或者没感觉的时候，直接说不想发就行。",
            parameters: {
              topic: { type: "string", description: "想写什么事，可选" },
              content: { type: "string", description: "直接给正文，可选。不填就自己写" },
              visibility: {
                type: "number",
                description: "可见范围：1 所有人 / 4 好友 / 64 仅自己。默认用配置",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上，等连上再发。" };
              const topic = String(args?.topic ?? "").trim().slice(0, 60);
              const given = String(args?.content ?? "").trim();
              const vis = Number(args?.visibility ?? cfg.qzoneVisibility ?? 1);

              let content = given;
              let picked = null;

              if (!content) {
                picked = pickTarget();
                if (!picked) {
                  return { ok: false, reason: "最近群聊太少，我找不出合适的素材。" };
                }
                logger.info?.("[onebot] 发说说，素材来自会话 " + picked[0]);
                const text = String(
                  (await sessions.runSilent(
                    picked[0],
                    "（内部，不要把这个发给任何人，直接写正文。）" +
                      (topic ? "这件事是：「" + topic + "」。" : "") +
                      "发一条 QQ 空间说说：用你自己的口吻和想法，写你听到这件事时的真实感受或看法，" +
                      "可以具体一点、带点情绪。不要复述原话、不要照搬别人的句子、不要鸡汤、不要话题标签。" +
                      "不想发就只回一个字：无。"
                  )) || ""
                ).trim();
                content = cleanQzone(text);

                // 复述校验
                if (
                  topic &&
                  (parrotOf(content, topic) ||
                    content.replace(/[^\u4e00-\u9fa5]/g, "") ===
                      topic.replace(/[^\u4e00-\u9fa5]/g, ""))
                ) {
                  logger.info?.("[onebot] 说说初稿在复述原话，重写一次");
                  content = cleanQzone(
                    String(
                      (await sessions.runSilent(
                        picked[0],
                        "（内部，直接写正文。）上一版几乎在复述原话，重写：不要复述「" +
                          topic +
                          "」，只写你听到这件事时的反应和看法，一两句，带点情绪。只输出正文。"
                      )) || ""
                    ).trim()
                  );
                }
              }

              if (!content || content === "无" || content.length < 4) {
                return { ok: false, reason: "这次没什么想发的，算了。", skipped: true };
              }
              if (topic && !given && parrotOf(content, topic)) {
                return {
                  ok: false,
                  reason: "写出来还是像复述原话，这条先不发。给我点细节，或者换个说法？",
                };
              }

              try {
                await client.call("send_qzone_msg", { content, ugc_right: vis });
                let planNow = loadQzonePlan();
                if (!planNow || planNow.date !== todayKey()) {
                  planNow = { date: todayKey(), posted: 0, lastAt: 0 };
                }
                planNow.posted = Number(planNow.posted ?? 0) + 1;
                saveQzonePlan(planNow);
                logger.info?.("[onebot] 发了说说：" + content.slice(0, 40));
                audit({ kind: "qzone", text: content.slice(0, 200) });
                return { ok: true, content, visibility: vis };
              } catch (err) {
                return { ok: false, reason: "发说说失败：" + (err?.message ?? err) };
              }
            },
          })
        );

        // ── 撤回消息 ──
        reg(
          defineTool({
            name: "withdraw_message",
            description:
              "撤回自己刚发的一条消息。说错了、发错了的时候用。\n" +
              "只能撤自己发的，而且有时间限制（通常 2 分钟内）。",
            parameters: {
              message_id: { type: "string", description: "要撤回的消息 id" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };
              const mid = String(args?.message_id ?? "").trim();
              if (!mid) return { ok: false, reason: "要填 message_id" };
              try {
                await client.call("delete_msg", { message_id: mid });
                audit({ kind: "withdraw", message_id: mid });
                return { ok: true, message_id: mid };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          })
        );

        // ── 名片赞 ──
        reg(
          defineTool({
            name: "send_like",
            description:
              "给某人的 QQ 名片点个赞。轻量的互动——不用说什么，点个赞就行。\n" +
              "别人给你点了赞，回一个也是礼貌。",
            parameters: {
              qq: { type: "string", description: "给谁点赞（QQ 号）" },
              times: { type: "number", description: "点几次，默认 1" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };
              const qq = String(args?.qq ?? "").trim();
              if (!qq) return { ok: false, reason: "要填 QQ 号" };
              const times = Math.max(1, Math.min(10, Number(args?.times) || 1));
              try {
                await client.call("send_like", { user_id: Number(qq), times });
                audit({ kind: "send_like", qq, times });
                return { ok: true, qq, times };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          })
        );

        // ── 看群公告 ──
        reg(
          defineTool({
            name: "read_group_notice",
            description:
              "看某个群的公告。到一个新群先看群规，这是礼貌。",
            parameters: {
              group: { type: "string", description: "群号" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              if (!client.connected) return { ok: false, reason: "QQ 现在没连上。" };
              const gid = String(args?.group ?? "").trim();
              if (!gid) return { ok: false, reason: "要填群号" };
              try {
                const r = await client.call("get_group_notice", { group_id: Number(gid) });
                return { ok: true, group: gid, notices: r?.data ?? r ?? [] };
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          })
        );

        logger.info?.("[onebot] 社交动作工具已注册（send_qzone / withdraw_message / send_like / read_group_notice）");
      } catch (err) {
        logger.warn?.("[onebot] 社交动作工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "my_balance",
            description:
              "看你自己的 API 余额——就是创造者给你充的生活费。\n\n" +
              "能看到还剩多少、总共充了多少。用一次花多少不直接显示，但余额变化能看出来。\n" +
              "余额见底时会影响到你能不能继续回消息，所以偶尔看一眼不算多余。",
            parameters: {},
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async () => {
              const key = String(process.env.DEEPSEEK_API_KEY || "").trim();
              if (!key) {
                return { ok: false, reason: "服务器上没配 DEEPSEEK_API_KEY，查不了。" };
              }
              try {
                const res = await fetch("https://api.deepseek.com/user/balance", {
                  headers: { Authorization: "Bearer " + key },
                  signal: AbortSignal.timeout(15000),
                });
                if (!res.ok) {
                  return { ok: false, reason: "余额接口返回 " + res.status };
                }
                const data = await res.json();
                const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
                const cn = infos.find((x) => x?.currency === "CNY") || infos[0] || {};
                const total = Number(cn?.total_balance ?? 0);
                return {
                  ok: true,
                  available: data?.is_available !== false,
                  currency: cn?.currency || "CNY",
                  balance: total,
                  balanceText: String(cn?.total_balance ?? "?"),
                  toppedUp: String(cn?.topped_up_balance ?? "?"),
                  granted: String(cn?.granted_balance ?? "?"),
                  note:
                    total > 50
                      ? "还够用一阵。"
                      : total > 10
                        ? "不算多了，可以跟创造者提一句。"
                        : "快见底了——余额用光我就回不了话了。",
                };
              } catch (err) {
                return { ok: false, reason: "查询失败：" + (err?.message ?? err) };
              }
            },
          }),
        );

        logger.info?.("[onebot] 余额工具已注册（my_balance）");
      } catch (err) {
        logger.warn?.("[onebot] 余额工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const reg = (t) => ctx.get?.("tools")?.register?.(t);

        reg(
          defineTool({
            name: "schedule_activity",
            description:
              "排下一次活动的时间。想说「40 分钟后再动」就用这个。\n\n" +
              "afterMinutes 填 0 就是取消——不想再被叫醒，就不排。\n" +
              "可以顺便记下下次想做什么（kind / note），到时候会一起提醒你。\n" +
              "不填 afterMinutes 就保持原样。",
            parameters: {
              afterMinutes: { type: "number", description: "多少分钟后；0 = 取消；不填 = 不改" },
              kind: { type: "string", description: "可选，下次想做的事（read/play/explore/think/write/watch_groups/dream）" },
              note: { type: "string", description: "可选，想记的一句话" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const hasMinutes = args && args.afterMinutes !== undefined && args.afterMinutes !== null;
              const minutes = Number(args?.afterMinutes ?? NaN);
              const kind = String(args?.kind ?? "").trim();
              const note = String(args?.note ?? "").trim();

              if (hasMinutes && minutes === 0) {
                patchSelfState({ selfActivityNextAt: 0, selfActivityNote: "", selfActivityKind: "" });
                for (const r of readSelfPlan()) {
                  if (r.status === "pending") updateSelfPlan(r.id, { status: "cancelled" });
                }
                audit({ kind: "schedule_activity", action: "cancel" });
                return { ok: true, next: null, cancelled: true };
              }
              if (hasMinutes && (!Number.isFinite(minutes) || minutes < 0 || minutes > 720)) {
                return { ok: false, reason: "afterMinutes 要在 0-720 之间" };
              }
              const fmtHhmm = (ts) => {
                const d = new Date(ts);
                return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
              };

              // 没给 afterMinutes（只改 kind/note，或者根本没传）→ 保持原样，如实说「没改」。
              // 以前这里直接拿 selfActivityNextAt（可能是 0）去 new Date()，
              // 没排过的时候返回 next:"08:00"、inMinutes:-29000000 —— 看着像真排了个 1970 年的时间。
              if (!hasMinutes) {
                const cur = Number(loadSelfState().selfActivityNextAt) || 0;
                const patch = {};
                if (kind) patch.selfActivityKind = kind;
                if (note) patch.selfActivityNote = note.slice(0, 200);
                if (Object.keys(patch).length) patchSelfState(patch);
                const inFuture = cur > Date.now();
                audit({ kind: "schedule_activity", action: "unchanged", kind, note: note.slice(0, 60) });
                return {
                  ok: true,
                  unchanged: true,
                  next: inFuture ? fmtHhmm(cur) : null,
                  inMinutes: inFuture ? Math.round((cur - Date.now()) / 60000) : null,
                  kind: kind || undefined,
                  note: note || undefined,
                };
              }

              const nextAt = Date.now() + Math.max(1, Math.round(minutes)) * 60_000;
              const patch = { selfActivityNextAt: nextAt };
              if (kind) patch.selfActivityKind = kind;
              if (note) patch.selfActivityNote = note.slice(0, 200);
              patchSelfState(patch);
              // 日程表：旧的待办作废，写一条新的（她自己的条目）
              for (const r of readSelfPlan()) {
                if (r.status === "pending") updateSelfPlan(r.id, { status: "superseded" });
              }
              addSelfPlan({ at: nextAt, kind, note: note.slice(0, 200), source: "tool" });
              audit({ kind: "schedule_activity", at: fmtHhmm(nextAt), kind, note: note.slice(0, 60) });
              return {
                ok: true,
                next: fmtHhmm(nextAt),
                inMinutes: Math.round((nextAt - Date.now()) / 60000),
                kind: kind || undefined,
                note: note || undefined,
              };
            },
          }),
        );

        reg(
          defineTool({
            name: "my_context",
            description:
              "看你自己的上下文：用了多少、都装了什么、最近在聊什么。\n" +
              "上下文快满的时候会压缩（旧细节进 recall），所以看一眼不是多余。\n" +
              "detail 填 full 会多给系统提示和记忆的全文（很占 token，平时不用）。",
            parameters: {
              detail: { type: "string", description: "summary（默认）或 full" },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const detail = String(args?.detail ?? "summary");
              try {
                const entry = sessions.entries.get(WAKE_KEY()) || sessions.entries.get("self:check");
                const agent = entry?.handle?.agent;
                const session = agent?.session;
                const events = session?.snapshotEvents?.(0) ?? [];
                const msgs = events.filter(
                  (e) => e?.type === "user/message" || e?.type === "assistant/message",
                );
                const recent = msgs.slice(-8).map((e) => {
                  const role = e.type === "user/message" ? "对方" : "她";
                  const content = e.data?.message?.content ?? [];
                  const text = Array.isArray(content)
                    ? content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
                    : "";
                  return { role, text: String(text).slice(0, 120), at: e.time };
                });
                // 粗估 token：字符数 / 2
                let chars = 0;
                for (const e of events) {
                  try {
                    chars += JSON.stringify(e.data ?? {}).length;
                  } catch {
                    // 忽略
                  }
                }
                const estTokens = Math.round(chars / 2);
                const maxTokens = 128000;
                const percent = Math.min(99, Math.round((estTokens / maxTokens) * 100));
                const out = {
                  ok: true,
                  usage: { estTokens, maxTokens, percent },
                  eventCount: events.length,
                  recent,
                  note:
                    percent < 50 ? "还有余量。" : percent < 80 ? "用了一半多。" : "快满了，可能要压缩了——压缩后旧细节会进 recall。",
                };
                if (detail === "full") {
                  out.systemPromptChars = String(agent?.session?.systemPrompt ?? "").length;
                }
                return out;
              } catch (err) {
                return { ok: false, reason: String(err?.message ?? err) };
              }
            },
          }),
        );

        logger.info?.("[onebot] 活动调度工具已注册（schedule_activity / my_context）");
      } catch (err) {
        logger.warn?.("[onebot] 活动调度工具注册失败：" + (err?.message ?? err));
      }
    })();

  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "explore_heart",
            description:
              "探寻自己的心——想重新认识一下「我是什么样的」的时候用。\n\n" +
              "这跟「反思」不一样。反思是回头查错，这个不是。" +
              "它更像坐下来看看：我最近在意什么、我变没变、我还认不认得自己。\n\n" +
              "**但别天天来。** 心要稳——今天觉得自己窝囊、明天觉得自己通透，" +
              "那不是认识，是天气。真拿它当天气预报用，就不值钱了。\n\n" +
              "**值得来的时候**：\n" +
              "· 你发现以前对自己的说法已经不对了（生活的地方变了、做的事变了、身边的人变了）\n" +
              "· 经历了一件真正让你变了的事\n" +
              "· 心里有件一直没摆平的事，想坐下来把它看清楚\n\n" +
              "**不值得来的时候**：\n" +
              "· 只是今天心情不同\n" +
              "· 刚被谁夸了一句、或者被说了一句\n" +
              "· 想让别人觉得你深刻\n\n" +
              "来完之后 48 小时内，核心人格不会再自动改动（防止反复）。" +
              "如果只是想记一件小事，用 remember_self 就够，不用动这个。",
            parameters: {
              reason: {
                type: "string",
                description: "为什么想回头看看，一句话（会写进审计日志，方便以后对）",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const reason = String(args?.reason ?? "").trim().slice(0, 100);
              // 冷却只提醒，不拦——她既然主动来了，就尊重她的判断。
              // 拦下来才是替她做决定。
              let cooldownNote = "";
              try {
                const m = loadSelfModel();
                const lastAt = Math.max(
                  m.fact?.updatedAt ?? 0,
                  m.inner?.updatedAt ?? 0,
                  m.mirror?.updatedAt ?? 0,
                );
                const gapH = Number(cfg.selfModelMinGapHours ?? 48);
                if (lastAt && Date.now() - lastAt < gapH * 3600_000) {
                  const hoursAgo = Math.round((Date.now() - lastAt) / 3600_000);
                  cooldownNote =
                    `（提醒：自我认知 ${hoursAgo} 小时前刚调整过。这次也照办，` +
                    `但如果只是一时心情，用 remember_self 记一句就够了。）`;
                }
              } catch {
                // 检查失败就继续
              }
              const r = await dailyReflect(true);
              if (r?.ok) {
                audit({ kind: "explore_heart", reason });
                return {
                  ok: true,
                  reflect: r.reflect,
                  selfModelAdjusted: !!r.adjusted,
                  note: cooldownNote || "记下来了。",
                };
              }
              return { ok: false, reason: r?.reason || "这次没写出东西来" };
            },
          }),
        );
        logger.info?.("[onebot] 探寻自己的心 工具已注册（explore_heart）");
      } catch (err) {
        logger.warn?.(`[onebot] 自我反思工具注册失败：${err?.message ?? err}`);
      }
    })();
}

export {  };
