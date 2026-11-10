/**
 * dsh-onebot-bridge — OneBot 11 (NapCat) ↔ DeepSeek Harness 桥
 *
 * 链路：NapCat WS(3001) → 本插件 → DSH agents.create/resume → followup → whenIdle → 提取回复 → send_*_msg
 *
 * 设计取舍（MVP）：
 * - 不引第三方依赖：WebSocket 用 Node 22+ 内置实现
 * - 每个会话（私聊 QQ / 群）一个独立持久 DSH agent，串行队列
 * - 配置在 ~/.dsh/onebot-bridge/config.json，热读一次（重启生效）
 */
import net from "node:net";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, copyFileSync, chmodSync, chownSync } from "node:fs";
import { join, join as pathJoin, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { SessionId } from "@deepseek-ai/dsh-session";
import { zstdDecompressSync } from "node:zlib";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { safeSegData, smartCut, stripLoneSurrogates, safeSlice, humanizePunct, splitMessage } from "./src/util/text.js";
import { setLogger, getLogger } from "./src/core/logger.js";
import { MSG_LOG_DIR, MSG_LOG_PRIVATE_DIR, MSG_LOG_GROUP_DIR, MSG_LOG_DAY_MAX_LINES, MSG_LOG_DAY_KEEP_LINES, MSG_LOG_KEEP_DAYS, MSG_LOG_STATE, msgLogKeyOf, msgLogIsPrivate, msgLogDirFor, msgLogLegacyFileFor, msgLogDay, msgLogFileFor, msgLogDayFiles, appendMsgRec, dirnameOf, recordMessage, recordOutbound, parseMsgLines, readMsgLog, cmpMsgRec, encodeCursor, decodeCursor, readMsgLogPage, readMsgLogPageMulti, findMsgInLog, listMsgKeys, migrateLegacyLogs, pruneOldLogs } from "./src/store/msglog.js";
import { mirrorSource } from "./src/store/source-mirror.js";
import { createUsageStats } from "./src/store/usage.js";
import { createPromptCore } from "./src/features/prompt.js";
import { createUserTools } from "./src/features/user-tools.js";
import { createToolCatalog } from "./src/features/tool-catalog.js";
import { createToolTable } from "./src/features/tool-table.js";
import { createSystemHints } from "./src/features/system-hints.js";
import { createPersona } from "./src/features/persona.js";
import { createPersonaStore } from "./src/store/persona-store.js";
import { createPersonaTools } from "./src/tools/persona.js";
import { createSessionSegments } from "./src/features/session-segments.js";
import { createDeferredReview } from "./src/features/deferred-review.js";
import { createEcho } from "./src/features/echo.js";
import { createAttention } from "./src/features/attention.js";
import { createMood } from "./src/features/mood.js";
import { AUDIT_PATH, auditEnabled, audit, rotateAudit, summarizeDay, renderStats, ymdOffset, setAuditEnabled } from "./src/core/audit.js";
import { bindConfig } from "./src/store/config.js";
import { SELF_PLAN_PATH, PLAN_GRACE_MS, readSelfPlan, writeSelfPlan, addSelfPlan, updateSelfPlan, nextSelfPlan, claimDueSelfPlan, ensureSelfPlanPending } from "./src/store/selfplan.js";
import { SEEN_PATH, REFUSE_PATH, refuseState, seenState, seenDirty, isRefused, refusePerson, markSeen, flushSeen, setRefuseState } from "./src/store/seen.js";
import { sleep, withTimeout } from "./src/util/time.js";
import { conversationKey, sessionIdBase, SEG_LABEL, parseCqString, parseMessage } from "./src/onebot/parse.js";
import { recTag, renderMsgRec } from "./src/onebot/render.js";
import { POLITICAL, NEWS_CACHE, downloadImage, fetchHotNews, isPrivateHost, htmlToText, stripToText, fetchLinkPreview } from "./src/net/fetch.js";
import { SELF_PATH, selfViews } from "./src/store/selfviews.js";
import { FACTS_PATH, SENSITIVE, facts } from "./src/store/facts.js";
import { USERS_PATH, USERS_DIR, people } from "./src/store/people.js";
import { loadStickerLabels, STICKER_NEGS, lastSvgRender, lastStickerPreview, stickerContradicts, STICKER_ANTONYM, pickStickerPool, pickSticker, pickStickerCandidates, loadStickerDescs, saveStickerDesc, resolveSticker } from "./src/features/stickers.js";
import { CONFIG_PATH, DEFAULTS, loadConfig, saveConfig } from "./src/store/config.js";
import { OUT_SENT, OUT_REPLIED, DUP_TEXT_MS, DUP_MSG_MS, normOut, SEND_STATE, noteSent, pickBaseDelay, backlogDelay } from "./src/util/send-state.js";
import { cleanQzone, parrotOf, extractReply } from "./src/util/misc.js";
import { OneBotClient } from "./src/onebot/client.js";
import { SessionManager } from "./src/sessions/manager.js";
import { textOverlaps, parseDuration, timeContext, todayKey, extractRealInbound, makeEvent, eventTarget, WAKE_KEY } from "./src/util/misc.js";
import { helpText, renderRecall, handleOwnerNatural, recentDialog } from "./src/features/help.js";
import { listSessionFiles, findSessionFile } from "./src/util/session-files.js";
import { webHtml } from "./src/web/ui.js";
import { parseReminderTime } from "./src/util/time.js";
import { createWindows } from "./src/sessions/windows.js";
import { createMemoryStore } from "./src/store/memory.js";
import { createMisc } from "./src/util/misc.js";
import { createEvents } from "./src/features/events.js";
import { createGroups } from "./src/features/groups.js";
import { createStats } from "./src/features/stats.js";
import { createWebServer } from "./src/web/server.js";
import { registerChatTools } from "./src/tools/chat.js";
import { registerMemoryTools } from "./src/tools/memory.js";
import { registerMediaTools } from "./src/tools/media.js";
import { registerSelfTools } from "./src/tools/self.js";
import { registerToolbox } from "./src/tools/toolbox.js";
import { createEventHandler } from "./src/onebot/events.js";
import { createChatFeature } from "./src/features/chat.js";
import { createSelfActivity } from "./src/features/self-activity.js";
import { createOwnerCommands } from "./src/features/owner.js";
import { createPolling } from "./src/features/polling.js";
import { createRecall } from "./src/features/recall.js";
import { createMemoryLoop } from "./src/features/memory-loop.js";
import { createActivityLoop } from "./src/features/activity.js";
import { createQzone } from "./src/features/qzone.js";
import { createSchedule } from "./src/features/schedule.js";
import { createRuntimeStore } from "./src/store/runtime.js";
import { createInbound } from "./src/features/inbound.js";
import { createGroupAdmin } from "./src/features/group-admin.js";
import { createPolicy } from "./src/core/policy.js";
import { createLengthFeedback } from "./src/features/length-feedback.js";
import { createOnReconnected } from "./src/onebot/hooks.js";
import { createSessionEventHandler } from "./src/onebot/session-hooks.js";
import { createToolHooks } from "./src/onebot/tool-hooks.js";
import { createOnWebReply } from "./src/onebot/web-hooks.js";
import { createOnOfflineText } from "./src/onebot/web-hooks.js";
import { createApprovalHandler } from "./src/onebot/approval-hooks.js";
import { createRuntimeState } from "./src/features/runtime-state.js";
import { createMiscFeature } from "./src/features/misc.js";
import { startTimers } from "./src/features/timers.js";
import { ALLOWED_TOOLS, SAFE_CONFIG_KEYS } from "./src/core/constants.js";

export const name = "dsh-onebot-bridge";
/** 不 inject：全部走 ctx.get() 兜底 */
export const inject = [];

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 单一出口去重：所有发往 QQ 的文本都走 sendText / sendPrivate，
 * 在那里记录「这个会话发过什么、回过哪条」。
 * 重复发送不报错，只回一句「已经发过了」——让她自己知道，而不是限制回合。
 */
 // `${key}|${归一化文本}` -> ts
 // `${key}|${入站 message_id}` -> ts

/**
 * 把 cfg 写回 config.json。
 * 原来没有这个函数——所有配置改动（静音/风控/字数）都只在内存里，
 * 重启就恢复。现在改了会真的存下来。
 */

// 风控节流的全局计数：最近发出的时间戳 + 上次发送时间

/** 按「最近 1 分钟 + 最近 10 分钟」的自身发送量，决定这一条要等多久 */

/** 同时说话的群多、或最近发得太密 → 额外多等一会儿，把发送曲线拉平 */

// ── 会话 key / id ─────────────────────────────────────────────────────

// ── OneBot 消息解析 ───────────────────────────────────────────────────

/** 从 OneBot 消息段数组提取纯文本；返回 {text, hasAt, images} */
/** 不认识的段类型：留个中文标签，渲染占位用（不解析内容） */

/** 段数据转字符串：任何结构都不能把解析炸掉 */

/** CQ 码字符串兜底（有的实现 message 不是数组） */

// ── 群消息落盘（旁听也写，重启不丢） ─────────────────────────────────

/** 单日文件超过这么多行就裁掉最老的（正常一天到不了） */

/** 保留多少天的分片目录 */

/** install 时注入的日志器（模块级函数拿不到闭包里的 logger） */

/** 会话 key：group:123 / private:456 */

/** key → 会话目录：messages/group/<群号>/ 或 messages/private/<QQ>/ */

/** 旧版单文件（迁移前） */

/** 本地日期 YYYY-MM-DD */

/** key + 时间 → 当天分片路径 */

/** 该会话所有分片，按时间从旧到新 */

/** 追加一条记录，并按天文件做行数上限 */

/**
 * 每条消息都写一条结构化记录（群聊和私聊都写）。
 * d: "i" 收到 / "o" 发出；两个方向写同一个会话目录，按天分片。
 * 任何异常都吞掉——落盘失败不能影响聊天。
 */

/** 她发出去的消息也落盘（d:"o"），这样对话是双向的 */

/**
 * 读某个会话最近 limit 条（从旧到新）。
 * 从最新的日分片往前读，读够就停。
 */

/** 按 (t,id) 比较，返回 <0 / 0 / >0 */

/**
 * 游标分页：从新往旧。
 * opts.before = 游标（不含）; opts.after = 游标（不含，向新）; opts.limit; opts.sinceSec
 */

/** 跨会话读同一个人/所有会话（供 read_person / read_chat_with 用） */

/** 旧版单文件 → 按天分片（启动时跑一次） */

/** 删掉超过保留期的日分片 */

// ── 她自己的活动日程（self-plan.jsonl，只有她自己排的条目） ────────────

/** 错过太久就不再补，直接标 expired */

/** 取最早到点的一条；错过超 grace 就标 expired（返回 {expired:true} 让调用方决定要不要提醒） */

/** 她没排的时候兜底用：保证日程表里始终有一条 pending */

/** 未知段类型 → 中文标签 */

/** 一条记录渲染成她读得懂的一行 */

// ── OneBot WS 客户端 ─────────────────────────────────────────────────

/** 全局打字锁：一次只有一条消息在「打字」 */

/** 下载 QQ 图片为 { data, mediaType }；失败返回 null */

// ── 新闻源（百度热搜，过滤时政） ──────────────────────────────────────

/** 时政/敏感关键词：命中就丢掉这条热点 */

/** 抓一批非时政热点标题（带 30 分钟缓存） */

// ── 链接预览（只看前 N 字，省 token） ────────────────────────────────

/** 内网地址黑名单（防 SSRF） */

/** HTML 粗略转纯文本 */

/// 按字数截断时切在句末，别切在句子中间

/** 抓一个链接的标题 + 正文前 N 字 */

// ── 已处理进度（重启/掉线后据此补回复） ─────────────────────────────

/** 她声明「不再回复」的人：QQ号 -> { until, reason, key, at } */

try {
  if (existsSync(REFUSE_PATH)) setRefuseState(JSON.parse(readFileSync(REFUSE_PATH, "utf8")));
} catch {
  setRefuseState({});
}

/** 清掉孤立代理项：slice 截断可能把 emoji 切成半个，发到 API 会 400 */

/** 按码点安全截断，不会切开 emoji */

// ── 每日统计 ──────────────────────────────────────────────────────────

/** 聚合某一天的审计记录（date 形如 2026-10-24） */
/** 日期键：n 天前（负数）/ 后 */

/** 说说正文清洗：去掉开头残留的逗号/引号 */

/** 是不是在复述素材：按 5 字窗口的重合比例判断 */

/** 把统计写成一句人话 */

// ── 审计日志 ──────────────────────────────────────────────────────────

/** 审计文件超过 5MB 时轮转一份 */

// ── 自我观点（她自己的看法，不是别人喂给她的） ────────────────────

// ── 全局事实表（跨会话共享的「关于人的稳定事实」） ────────────────────

/** 硬过滤：命中就不许进共享事实（QQ号、密钥、路径、口令） */

// ── 人物档案（每个群友一份印象，跨会话保留） ──────────────────────────

// ── 表情包 ────────────────────────────────────────────────────────────

/** 读标签表（文件名 -> 情绪词数组） */

/** 在表情包目录里按标签挑一张图；挑不到就随机 */
// ── 表情匹配：一个池子函数，两处共用 ──
// 原来 pickSticker 和 pickStickerCandidates 各写了一份匹配逻辑，
// 结果候选那边漏了反义映射（"不开心"直接掉随机）。
// 现在统一走 pickStickerPool。

// draw_svg 画完的图：execute 里 saveImage，render 里塞回工具结果 ——
// 让她自己看见画成什么样，不满意就改 SVG 重画。

// 预览用：execute（异步）里把图存成 attachment，render（同步）里取出来塞进工具结果。
// 这样三张候选图直接进模型的上下文——她真的「看见」了，不是靠标签猜。

// 否定词命中时的反义映射（"不开心"→委屈/哭，而不是随机）

/** 按 mood 算出候选文件池（含否定检测 + 反义映射），返回 { files, labels, matched } */

/** 挑一张发（兼容老调用） */

/** 挑最多 n 张候选（标签尽量不重复，别给三张一模一样的） */

/** 表情画面描述缓存：描述过一次就不再花算力 */

/** 挑最多 n 张候选（给「先看几张再选」用） */

/** 按「文件名 m007」或「序号 7」定位一张表情（序号同「表情包列表」的顺序） */

// ── Agent 会话管理 ────────────────────────────────────────────────────

/** 默认一条；超过 90 字才拆，最多 maxParts 条 */
/** 句末标点拟人化：人类 87% 的聊天消息不加句号，短句尤其明显 */

/** 带超时的等待：避免 whenIdle 永久挂起拖死整个队列 */

/** 从事件流提取最后一条 assistant 文本 */

// ── 插件主体 ──────────────────────────────────────────────────────────

export function apply(ctx, _pluginConfig) {
  // ctx.logger 的输出不一定进 journal，双写 console 便于排查
    // 运行时可变状态：统一收在一个对象里，模块通过 ctx.state 共享同一份
  // ── 惰性工厂：函数声明可提升，首次调用时才真正构造，避免 TDZ ──
  let __mem_createStats = null;
  function __init_createStats() { return (__mem_createStats ??= createStats({ client, ensureGroupNames, groupLabel, sessions, state })); }
  function ensureCounts(...a) { return __init_createStats().ensureCounts(...a); }
  function statusText(...a) { return __init_createStats().statusText(...a); }
  function statsText(...a) { return __init_createStats().statsText(...a); }
  let __mem_createEvents = null;
  function __init_createEvents() { return (__mem_createEvents ??= createEvents({ inbox, state })); }
  function pendingEvents(...a) { return __init_createEvents().pendingEvents(...a); }
  function pushEvent(...a) { return __init_createEvents().pushEvent(...a); }
  let __mem_createRuntimeStore = null;
  function __init_createRuntimeStore() { return (__mem_createRuntimeStore ??= createRuntimeStore({ AUDIT_PATH, EXPLORE_LOG, HEALTH_PATH, LEN_RING, LEN_RING_MAX, NET_MAX_LINKS, NET_PATH, OUTAGE_PATH, QZONE_PLAN, REMINDER_PATH, SELF_MODEL_PATH, WATCH_PATH, health, loadNet, logger, mkdirSync, readFileSync, state, writeFileSync, pluginCtx: ctx })); }
  function netAddNode(...a) { return __init_createRuntimeStore().netAddNode(...a); }
  function netLink(...a) { return __init_createRuntimeStore().netLink(...a); }
  function saveNetSoon(...a) { return __init_createRuntimeStore().saveNetSoon(...a); }
  function netIndexAdd(...a) { return __init_createRuntimeStore().netIndexAdd(...a); }
  function net(...a) { return __init_createRuntimeStore().net(...a); }
  function loadWatch(...a) { return __init_createRuntimeStore().loadWatch(...a); }
  function saveWatch(...a) { return __init_createRuntimeStore().saveWatch(...a); }
  function watchHit(...a) { return __init_createRuntimeStore().watchHit(...a); }
  function loadSelfModel(...a) { return __init_createRuntimeStore().loadSelfModel(...a); }
  function saveSelfModel(...a) { return __init_createRuntimeStore().saveSelfModel(...a); }
  function selfModelText(...a) { return __init_createRuntimeStore().selfModelText(...a); }
  function loadQzonePlan(...a) { return __init_createRuntimeStore().loadQzonePlan(...a); }
  function saveQzonePlan(...a) { return __init_createRuntimeStore().saveQzonePlan(...a); }
  function saveReminders(...a) { return __init_createRuntimeStore().saveReminders(...a); }
  function loadReminders(...a) { return __init_createRuntimeStore().loadReminders(...a); }
  function saveOutages(...a) { return __init_createRuntimeStore().saveOutages(...a); }
  function saveHealth(...a) { return __init_createRuntimeStore().saveHealth(...a); }
  function loadLenRing(...a) { return __init_createRuntimeStore().loadLenRing(...a); }
  function appendExploreLog(...a) { return __init_createRuntimeStore().appendExploreLog(...a); }
  let __mem_createRuntimeState = null;
  function __init_createRuntimeState() { return (__mem_createRuntimeState ??= createRuntimeState({ HOME, RUNTIME_PATH, SENSITIVE, cfg, client, join, loadActivities, loadCore, loadDigests, loadLearnings, loadMemLog, loadSelfModel, loadSelfState, logger, myMsgIds, myMsgOrder, readFileSync, saveOutages, saveSelfModel, sessions, state, writeFileSync, pluginCtx: ctx })); }
  function snapshotRuntime(...a) { return __init_createRuntimeState().snapshotRuntime(...a); }
  function restoreRuntime(...a) { return __init_createRuntimeState().restoreRuntime(...a); }
  function persistConfig(...a) { return __init_createRuntimeState().persistConfig(...a); }
  function noteOutageFromClient(...a) { return __init_createRuntimeState().noteOutageFromClient(...a); }
  function offlineDigest(...a) { return __init_createRuntimeState().offlineDigest(...a); }
  function recentOutageNote(...a) { return __init_createRuntimeState().recentOutageNote(...a); }
  function activityTimeline(...a) { return __init_createRuntimeState().activityTimeline(...a); }
  function memoryLayersIndex(...a) { return __init_createRuntimeState().memoryLayersIndex(...a); }
  function allGroupIds(...a) { return __init_createRuntimeState().allGroupIds(...a); }
  function otherGroupDigest(...a) { return __init_createRuntimeState().otherGroupDigest(...a); }
  function noteMirrorSource(...a) { return __init_createRuntimeState().noteMirrorSource(...a); }
  function noteMyMessage(...a) { return __init_createRuntimeState().noteMyMessage(...a); }
  let __mem_createMemoryLoop = null;
  function __init_createMemoryLoop() { return (__mem_createMemoryLoop ??= createMemoryLoop({ MEMLOG_PATH, NET_DECAY, NET_MAX_DEPTH, NET_MAX_LINKS, NET_MIN_W, NET_VISIT_CAP, SELF_ACTIVITY_KEY, audit, cfg, loadActivities, loadCore, loadDigests, loadMemLog, logger, memSeen, memoryLayersIndex, net, netAddNode, recentDigestText, saveCore, saveDigests, selfModelText, sessions, writeFileSync, pluginCtx: ctx })); }
  function distillCore(...a) { return __init_createMemoryLoop().distillCore(...a); }
  function maybeMakeDigest(...a) { return __init_createMemoryLoop().maybeMakeDigest(...a); }
  function netWalk(...a) { return __init_createMemoryLoop().netWalk(...a); }
  function appendMem(...a) { return __init_createMemoryLoop().appendMem(...a); }
  function reflectPhase(...a) { return __init_createMemoryLoop().reflectPhase(...a); }
  function thinkPhase(...a) { return __init_createMemoryLoop().thinkPhase(...a); }
  let __mem_createActivityLoop = null;
  function __init_createActivityLoop() { return (__mem_createActivityLoop ??= createActivityLoop({ SELF_ACTIVITY_KEY, SELF_HISTORY_PATH, segments, addSelfPlan, audit, cfg, client, l1Push, loadActivities, loadGroupMeta, loadSelfModel, loadSelfState, loadWants, logger, offlineDigest, patchSelfState, readSelfPlan, recentDigestText, saveSelfModel, sessions, state, updateSelfPlan, watchHit, writeFileSync, pluginCtx: ctx })); }
  function scheduleNextSelfActivity(...a) { return __init_createActivityLoop().scheduleNextSelfActivity(...a); }
  function hourlyIntrospect(...a) { return __init_createActivityLoop().hourlyIntrospect(...a); }
  function maybeAdjustSelfModel(...a) { return __init_createActivityLoop().maybeAdjustSelfModel(...a); }
  function isOfflineMode(...a) { return __init_createActivityLoop().isOfflineMode(...a); }
  let __mem_createPolicy = null;
  function __init_createPolicy() { return (__mem_createPolicy ??= createPolicy({ ACTIVITY_KINDS, HOME, audit, cfg, client, join, rateKey, rateUser, readFileSync, searchTimes, sessions, state, summarizeDay, pluginCtx: ctx })); }
  function isOwner(...a) { return __init_createPolicy().isOwner(...a); }
  function allowRate(...a) { return __init_createPolicy().allowRate(...a); }
  function checkTokenBudget(...a) { return __init_createPolicy().checkTokenBudget(...a); }
  function activeHoursOk(...a) { return __init_createPolicy().activeHoursOk(...a); }
  function selfActivityHoursOk(...a) { return __init_createPolicy().selfActivityHoursOk(...a); }
  function searchRateOk(...a) { return __init_createPolicy().searchRateOk(...a); }
  function pickActivityKind(...a) { return __init_createPolicy().pickActivityKind(...a); }
  function moodContext(...a) { return __init_createPolicy().moodContext(...a); }
  let __mem_createMiscFeature = null;
  function __init_createMiscFeature() { return (__mem_createMiscFeature ??= createMiscFeature({ HOME, audit, cfg, client, downloadImage, existsSync, join, logger, mkdirSync, people, readFileSync, runThinkingCycleInner, sessions, state, writeFileSync, pluginCtx: ctx })); }
  function judgeSwitchTalk(...a) { return __init_createMiscFeature().judgeSwitchTalk(...a); }
  function imagePayloadFrom(...a) { return __init_createMiscFeature().imagePayloadFrom(...a); }
  function crossGroupScope(...a) { return __init_createMiscFeature().crossGroupScope(...a); }
  function proactiveLocationNote(...a) { return __init_createMiscFeature().proactiveLocationNote(...a); }
  function runThinkingCycle(...a) { return __init_createMiscFeature().runThinkingCycle(...a); }
  function autoConfigurePlugins(...a) { return __init_createMiscFeature().autoConfigurePlugins(...a); }
  let __mem_createSelfActivity = null;
  function __init_createSelfActivity() { return (__mem_createSelfActivity ??= createSelfActivity({ HOME, SELF_ACTIVITY_KEY, appendActivity, appendExploreLog, appendMem, audit, cfg, client, distillCore, isOfflineMode, join, loadActivities, loadCore, loadLearnings, loadSelfState, logger, maybeMakeDigest, patchSelfState, readFileSync, reflectPhase, runThinkingCycle, saveLearnings, scheduleNextSelfActivity, selfActivityHoursOk, selfViews, sessions, state, thinkPhase, updateSelfPlan, webPush, writeFileSync })); }
  function runSelfActivity(...a) { return __init_createSelfActivity().runSelfActivity(...a); }
  function actPhase(...a) { return __init_createSelfActivity().actPhase(...a); }
  function runThinkingCycleInner(...a) { return __init_createSelfActivity().runThinkingCycleInner(...a); }
  function tickSelfActivity(...a) { return __init_createSelfActivity().tickSelfActivity(...a); }
  function maybeExplore(...a) { return __init_createSelfActivity().maybeExplore(...a); }
  function exploreByIntent(...a) { return __init_createSelfActivity().exploreByIntent(...a); }
  let __mem_createLengthFeedback = null;
  function __init_createLengthFeedback() { return (__mem_createLengthFeedback ??= createLengthFeedback({ LEN_RING, LEN_RING_MAX, LEN_TIER_EDGES, LEN_TIER_NAMES, loadLenRing, pluginCtx: ctx })); }
  function formatLenHint(...a) { return __init_createLengthFeedback().formatLenHint(...a); }
  function lenTierOf(...a) { return __init_createLengthFeedback().lenTierOf(...a); }
  function pushLen(...a) { return __init_createLengthFeedback().pushLen(...a); }
  let __mem_createInbound = null;
  function __init_createInbound() { return (__mem_createInbound ??= createInbound({ INBOUND_TEXT_MAX, INBOX_PATH, cfg, extractRealInbound, inbox, logger, makeEvent, mergeBuf, pendingEvents, pushEvent, state, wakeNow, writeFileSync, pluginCtx: ctx })); }
  function enqueue(...a) { return __init_createInbound().enqueue(...a); }
  function flushBuf(...a) { return __init_createInbound().flushBuf(...a); }
  function renderEventForAgent(...a) { return __init_createInbound().renderEventForAgent(...a); }
  function clipInbound(...a) { return __init_createInbound().clipInbound(...a); }
  function enqueueEvent(...a) { return __init_createInbound().enqueueEvent(...a); }
  function flushInbox(...a) { return __init_createInbound().flushInbox(...a); }
  function cancelReviews(...a) { return __init_createEvents().cancelReviews(...a); }
  let __mem_createChatFeature = null;
  const toolTable = createToolTable({ ctx });
  // 惰性：logger 在 apply 后面才初始化
  let __mem_personaStore = null;
  function __init_personaStore() {
    if (!__mem_personaStore) {
      __mem_personaStore = createPersonaStore({ logger });
      try {
        __mem_personaStore.migrateIfNeeded();
      } catch (err) {
        console.warn("[onebot] 人格迁移失败：" + (err?.message ?? err));
      }
    }
    return __mem_personaStore;
  }
  const personaStore = {
    list: (...a) => __init_personaStore().list(...a),
    counts: (...a) => __init_personaStore().counts(...a),
    add: (...a) => __init_personaStore().add(...a),
    revise: (...a) => __init_personaStore().revise(...a),
    retract: (...a) => __init_personaStore().retract(...a),
    history: (...a) => __init_personaStore().history(...a),
    stateAt: (...a) => __init_personaStore().stateAt(...a),
    LAYERS: { P0: 5, P1: 8, P2: 20 },
  };
  // 惰性构造：logger 在 apply 后面才初始化，这里直接读会 TDZ
  let __mem_mood = null;
  function __init_mood() {
    return (__mem_mood ??= createMood({ logger }));
  }
  const mood = { line: () => __init_mood().line(), status: () => __init_mood().status() };

  let __mem_attention = null;
  function __init_attention() {
    return (__mem_attention ??= createAttention({ logger }));
  }
  const attention = { request: (...a) => __init_attention().request(...a), status: () => __init_attention().status() };

  let __mem_echo = null;
  function __init_echo() {
    return (__mem_echo ??= createEcho({ client: () => client, logger, audit }));
  }
  const echo = {
    feed: (...a) => __init_echo().feed(...a),
    takeNotes: (...a) => __init_echo().takeNotes(...a),
    status: (...a) => __init_echo().status(...a),
  };

  let __mem_review = null;
  function __init_review() {
    return (__mem_review ??= createDeferredReview({ logger, enqueueEvent, makeEvent }));
  }
  const deferredReview = {
    arm: (...a) => __init_review().arm(...a),
    cancel: (...a) => __init_review().cancel(...a),
    settle: (...a) => __init_review().settle(...a),
    shouldReview: (...a) => __init_review().shouldReview(...a),
    fire: (...a) => __init_review().fire(...a),
    close: (...a) => __init_review().close(...a),
  };

  let __mem_segments = null;
  function __init_segments() { return (__mem_segments ??= createSessionSegments({ logger })); }
  const segments = {
    channelOf: (...a) => __init_segments().channelOf(...a),
    keyFor: (...a) => __init_segments().keyFor(...a),
    noteTurn: (...a) => __init_segments().noteTurn(...a),
  };

  // 静态内容（风格 + 工具表）放进系统提示：每次请求都发，但不进对话历史，
  // 不会像以前那样每轮往历史里追加一份。
  async function installSystemPrompt() {
    const systemHints = createSystemHints({ cfg });
    const persona = createPersona({ personaStore });
    let sys = null;
    for (let i = 0; i < 50; i += 1) {
      try {
        sys = ctx?.get?.("systemPrompt") ?? null;
      } catch {
        sys = null;
      }
      if (sys?.section) break;
      await new Promise((r) => setTimeout(r, 400).unref?.());
    }
    if (!sys?.section) {
      logger?.warn?.("[onebot] 系统提示服务不可用，静态提示仍走用户消息");
      return;
    }
    sys.section({
      name: "onebot-hints",
      order: 900,
      interpolate: false,
      text: () => {
        const stat = systemHints.staticText();
        const table = toolTable.text();
        let who = "";
        try {
          who = persona.text();
        } catch {
          who = "";
        }
        return (
          (stat ? stat + "\n\n" : "") +
          (who ? who + "\n\n" : "") +
          (() => {
            try {
              const m = mood.line();
              return m ? m + "\n\n" : "";
            } catch {
              return "";
            }
          })() +
          "【工具】（用 call_tool 调用；参数带类型，? 表示可选；不确定就先 describe_tool）\n" +
          table
        );
      },
    });
    logger?.info?.("[onebot] 系统提示已注入（风格 + 人格 + 工具表）");
  }
  let __mem_createPromptCore = null;
  function __init_createPromptCore() { return (__mem_createPromptCore ??= createPromptCore({ cfg, formatLenHint, recentOutageNote })); }
  function promptCore(...a) { return __init_createPromptCore().core(...a); }
  function __init_createChatFeature() { return (__mem_createChatFeature ??= createChatFeature({ LEN_TIER_NAMES, WAKE_KEY, activeHoursOk, activityTimeline, appendMem, audit, bumpWindow, cfg, client, enqueueEvent, eventTarget, flushInbox, flushSeen, followMax, hitWindow, lenTierOf, logger, makeEvent, markRuntimeDirty, markSeen, openWindow, pendingEvents, pendingWhileBooting, processingIds, pushLen, recentIds, renderEventForAgent, promptCore, segments, deferredReview, echo, seenDirty, seenState, sessions, sleep, state, todayKey })); }
  function deliver(...a) { return __init_createChatFeature().deliver(...a); }
  function wakeNow(...a) { return __init_createChatFeature().wakeNow(...a); }
  function checkQuietGroups(...a) { return __init_createChatFeature().checkQuietGroups(...a); }
  let __mem_createSchedule = null;
  function __init_createSchedule() { return (__mem_createSchedule ??= createSchedule({ activeHoursOk, audit, cfg, claimDueSelfPlan, client, ctx, enqueueEvent, entryLastTopic, fetchHotNews, findSessionFile, flushSeen, inQuietHours, loadReminders, logger, makeEvent, markSeen, maybeAdjustSelfModel, openWindow, patchSelfState, pickTarget, recentDialog, renderStats, saveReminders, selfViews, sessions, statSync, state, summarizeDay, pluginCtx: ctx })); }
  function checkReminders(...a) { return __init_createSchedule().checkReminders(...a); }
  function scheduleProactive(...a) { return __init_createSchedule().scheduleProactive(...a); }
  function scheduleDailyBrief(...a) { return __init_createSchedule().scheduleDailyBrief(...a); }
  function scheduleMorningCatchup(...a) { return __init_createSchedule().scheduleMorningCatchup(...a); }
  function scheduleDiary(...a) { return __init_createSchedule().scheduleDiary(...a); }
  function scheduleReflect(...a) { return __init_createSchedule().scheduleReflect(...a); }
  function fireDuePlan(...a) { return __init_createSchedule().fireDuePlan(...a); }
  function morningCatchup(...a) { return __init_createSchedule().morningCatchup(...a); }
  function dailyReflect(...a) { return __init_createSchedule().dailyReflect(...a); }
  function dailyDiary(...a) { return __init_createSchedule().dailyDiary(...a); }
  function maybeCompactAll(...a) { return __init_createSchedule().maybeCompactAll(...a); }
  let __mem_createRecall = null;
  function __init_createRecall() { return (__mem_createRecall ??= createRecall({ cfg, humanizePunct, listSessionFiles, logger, readFileSync, textOfEvent, zstdDecompressSync, pluginCtx: ctx })); }
  function recallSearch(...a) { return __init_createRecall().recallSearch(...a); }
  function sessionHistory(...a) { return __init_createRecall().sessionHistory(...a); }
  function readMessagesFromFile(...a) { return __init_createRecall().readMessagesFromFile(...a); }
  let __mem_createOwnerCommands = null;
  function __init_createOwnerCommands() { return (__mem_createOwnerCommands ??= createOwnerCommands({ audit, cfg, client, flushSeen, join, loadStickerLabels, logger, markSeen, openWindow, readdirSync, relayDone, sessions, pluginCtx: ctx })); }
  function handleOwnerRelay(...a) { return __init_createOwnerCommands().handleOwnerRelay(...a); }
  function handleOwnerStickerCmd(...a) { return __init_createOwnerCommands().handleOwnerStickerCmd(...a); }
  function handlePoke(...a) { return __init_createOwnerCommands().handlePoke(...a); }
  let __mem_createPolling = null;
  function __init_createPolling() { return (__mem_createPolling ??= createPolling({ allGroupIds, audit, cfg, client, health, logger, notifiedFriends, pendingFriends, processingIds, recentIds, saveHealth, seenState, sessions, pluginCtx: ctx })); }
  function pollMissedMentions(...a) { return __init_createPolling().pollMissedMentions(...a); }
  function pollFriendRequests(...a) { return __init_createPolling().pollFriendRequests(...a); }
  function catchUpPrivate(...a) { return __init_createPolling().catchUpPrivate(...a); }
  let __mem_createQzone = null;
  function __init_createQzone() { return (__mem_createQzone ??= createQzone({ audit, cfg, cleanQzone, client, loadQzonePlan, logger, qzoneLog, saveQzonePlan, selfViews, sessions, stripLoneSurrogates, todayKey, pluginCtx: ctx })); }
  function maybeQzone(...a) { return __init_createQzone().maybeQzone(...a); }
  let __mem_createGroupAdmin = null;
  function __init_createGroupAdmin() { return (__mem_createGroupAdmin ??= createGroupAdmin({ audit, cfg, client, facts, logger, pendingFriends, pendingInvites, pluginCtx: ctx })); }
  function handleGroupRequest(...a) { return __init_createGroupAdmin().handleGroupRequest(...a); }
  function handleOwnerLeaveGroup(...a) { return __init_createGroupAdmin().handleOwnerLeaveGroup(...a); }
  function handleOwnerInviteReply(...a) { return __init_createGroupAdmin().handleOwnerInviteReply(...a); }
  function handleOwnerRemember(...a) { return __init_createGroupAdmin().handleOwnerRemember(...a); }
  let __mem_createWebServer = null;
  function __init_createWebServer() { return (__mem_createWebServer ??= createWebServer({ WEBHIST_PATH, cfg, client, fireDuePlan, loadActivities, logger, state, webClients, webHistory })); }
  function webStart(...a) { return __init_createWebServer().webStart(...a); }
  function webPush(...a) { return __init_createWebServer().webPush(...a); }
  function loadWebHistory(...a) { return __init_createWebServer().loadWebHistory(...a); }

  const state = {
    lastInbound: null,
    pendingPromptForDiag: "",
    agentReady: false,
    watchCache: null,
    drawTimes: [],
    atPersonTimes: [],
    countsCache: { at: 0, friends: 0, groups: 0 },
    groupNames: new Map(),
    groupNamesAt: 0,
    reminders: [],
    remindersLoaded: false,
    lenRingLoaded: false,
    inboxDirty: false,
    state: "idle",
    agentReadyFlag: false,
    runtimeDirty: false,
    runtimeTimer: null,
    groupMetaCache: null,
    groupMetaTimer: null,
    webServer: null,
    webAuthFails: 0,
    webLockedUntil: 0,
    webHistReadError: "",
    offlineSince: 0,
    qqOnline: true,
    offlineSummaryPending: false,
    outages: [],
    outageDownAt: 0,
    lastOutageInfo: null,
    groupListCache: { at: 0, ids: [] },
    tokenAlertDay: "",
    netCache: null,
    netDirty: false,
    netTimer: null,
    activityRunning: false,
    activityRunningSince: 0,
    lastActivityAt: 0,
  };
const base = ctx.logger ?? {};
  const logger = {
    info: (...a) => {
      try { base.info?.(...a); } catch { /* ignore */ }
      try { console.log(...a); } catch { /* ignore */ }
    },
    warn: (...a) => {
      try { base.warn?.(...a); } catch { /* ignore */ }
      try { console.warn(...a); } catch { /* ignore */ }
    },
    debug: (...a) => {
      try { base.debug?.(...a); } catch { /* ignore */ }
    },
  };

  setLogger(logger);
  const cfg = loadConfig(logger);
  bindConfig(cfg, logger);
  // 记忆/统计文件的读写整簇（家里这群 load/save 只碰文件，不碰闭包状态）
  const {
    loadSelfState, loadWants, saveWants, loadDigests, saveDigests, loadMemLog,
    loadCore, saveCore, loadActivities, appendActivity, loadLearnings, saveLearnings,
    loadNet, patchSelfState, recentDigestText, relevantMemories,
    MEMLOG_PATH, NET_PATH, NET_MAX_LINKS,
  } = createMemoryStore();
  const { textOfEvent } = createMisc();
  try {
    migrateLegacyLogs();
    pruneOldLogs();
    // 内部唤醒 token（selfclock 用）；存在就复用，不存在就生成
    const tkPath = join(HOME, ".dsh/onebot-bridge/.internal-token");
    let tkv = "";
    try {
      tkv = readFileSync(tkPath, "utf8").trim();
    } catch {
      // 还没有
    }
    if (!tkv) tkv = "it-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    writeFileSync(tkPath, tkv + "\n", { mode: 0o600 });
    // 旧的 self-state 时间戳 → 日程表（只迁一次）
    if (!readSelfPlan().length) {
      const st1 = loadSelfState();
      const legacyAt = Number(st1.selfActivityNextAt) || 0;
      if (legacyAt > 0) {
        addSelfPlan({
          at: legacyAt,
          kind: String(st1.selfActivityKind || ""),
          note: String(st1.selfActivityNote || ""),
          source: "legacy",
        });
        getLogger()?.info?.(`[onebot] 已把旧的活动时间迁进日程表：${new Date(legacyAt).toISOString()}`);
      }
    }
  } catch {
    // 迁移/清理失败不影响启动
  }

  // ── 只有一种节奏：单线程打字模型（不再分普通/风控） ──
  // 原先风控模式会覆盖 followUpSeconds / maxParts / minSendGapMs / groupMergeWindowMs /
  // activeJoin* / soloStreak* / proactive* / qzone* 等，现在这些值统一由 DEFAULTS 提供。
  logger.info?.(
    `[onebot] 节奏：单线程打字模型｜续聊窗口 ${cfg.followUpSeconds}s｜群合并窗口 ${cfg.groupMergeWindowMs || 1500}ms`,
  );
  const sessions = new SessionManager(ctx, cfg, logger);

  /**
   * 跨群读的护栏。
   * 群里各聊各的，但工具能翻任意群——她翻了 B 群，接着在 A 群说，就成了「答错群」。
   * 这里只做两件事：① 标出这段原文属于哪个群；② 主动回合（插话/续聊）再点一句
   * 「你现在在 X 说话」，免得她把别处的语境带过来。不拦、不改写，只让她看见。
   */
  
  /** 主动回合里点一句「你现在在哪说话」，被动回话返回空（不打扰） */
  
  sessions.autoConfigure = (sid) => autoConfigurePlugins(sid);
  sessions.restoreRuntime = (entry) => restoreRuntime(entry);

  sessions.isAgentReady = () => state.agentReady;
  const client = new OneBotClient(cfg, logger);
  client.sessions = sessions; // 类拿不到闭包，显式注入
  client.deferredReview = deferredReview; // 回完后开 60 秒回看

  // 群画像/巡查：最早在 412 行就被调用，必须在这里就绪
  const GROUP_META_PATH = join(HOME, ".dsh/onebot-bridge/group-meta.json");
  const GROUP_META_DIR = join(HOME, ".dsh/onebot-bridge/groups");
  const groupMetaSaved = {};
  const { loadGroupMeta, saveGroupMeta, groupMetaTouch, groupLabel, groupActivityList, groupPatrolList, ensureGroupNames } =
    createGroups({ GROUP_META_DIR, GROUP_META_PATH, client, groupMetaSaved, state });
  client.readyFn = () => state.agentReady;
  client.onOutage = (kind, ts) => noteOutageFromClient(kind, ts);
  
  // QQ 离线时，本该私聊发出的内容改成推到 WebUI。
  // 但要分清是发给谁的：发给创造者的，创造者本来就该看到；
  // 发给第三方的，正文不能进 WebUI 历史（那是她的私聊内容，
  // 而且 webui-history.jsonl 会被 /history 全量返回，见 2.0.1 的教训）。
  
  client.onWebImage = (filePath) => {
    try {
      const id = `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const ext = (String(filePath).match(/\.(jpe?g|png|gif|webp)$/i) || [, "jpg"])[1].toLowerCase();
      const dest = join(HOME, ".dsh/onebot-bridge/workspace/pages", `${id}.${ext}`);
      writeFileSync(dest, readFileSync(filePath));
      webPush({ role: "her", image: `/img/${id}.${ext}` });
      logger.info?.(`[onebot] 表情包已推给 WebUI：${id}.${ext}`);
    } catch (err) {
      webPush({ role: "tool", text: `表情包没发出去：${String(err?.message ?? err).slice(0, 60)}` });
    }
  };
  const recentIds = new Set();
  const recentOrder = [];

  logger.info?.(
    `[onebot] 启动：ws=${cfg.wsUrl} self=${cfg.selfId} 工作区=${cfg.workspace} ` +
      `私聊白名单=${cfg.allowUsers.length ? cfg.allowUsers.join(",") : "不限"} ` +
      `群白名单=${cfg.allowGroups.length ? cfg.allowGroups.join(",") : "不限"}`,
  );

  const allowed = (ev, continuing = false) => {
    if (ev.message_type === "group") {
      if (cfg.allowGroups.length && !cfg.allowGroups.map(String).includes(String(ev.group_id))) return false;
      // 续聊命中的不需要 @
      if (cfg.groupRequireAt && !ev.__hasAt && !continuing) return false;
      return true;
    }
    if (cfg.allowUsers.length && !cfg.allowUsers.map(String).includes(String(ev.user_id))) return false;
    return true;
  };

  const dedupe = (id) => {
    const key = String(id);
    if (recentIds.has(key)) return false;
    recentIds.add(key);
    recentOrder.push(key);
    if (recentOrder.length > 500) recentIds.delete(recentOrder.shift());
    return true;
  };

  const pendingWhileBooting = [];

  // 连续对话窗口：key -> Map<userId|"*", { until, turns, max }>
  const followUps = new Map();
  const { followSecs, followMax, openWindow, hitWindow, activeWindowTarget, bumpWindow, closeWindowFor } =
    createWindows({ cfg, followUps, logger });
  // 发完群消息后开续聊窗口（client 拿不到闭包，在这里注入）
  client.windows = { openWindow };
  // 这三样是后挂到 client 上的，漏一个就会静默失效（以前真漏过）
  for (const k of ["sessions", "windows", "deferredReview"]) {
    if (!client[k]) throw new Error(`[onebot] client 缺少 ${k}，启动中止`);
  }
  logger?.info?.("[onebot] client 钩子就绪：sessions / windows / deferredReview");
  
  /** 找命中的窗口（先按人，再按群级 "*"）；返回 { rec, who } */
  
  /** 两句中文的二元组重合率，用来判断「这句是不是在接上一句」 */
  
  /** 这个群有没有还没过期的续聊窗口（返回窗口目标用户，没有就 null） */
  
  /** 她回复成功后推进计数；到上限就关窗 */
  
  /** 换目标时关掉旧目标的续聊窗口（其他窗口不动） */
  
  const switchJudgeAt = new Map();

  /**
   * 两步判断：A 旧目标是否已经不再跟她说话；B 新来这句是否冲她说的。
   * 只多一次内部调用，输出 A=是/否 B=是/否。
   */
  
  // 轻度限流
  const rateKey = new Map();
  const rateUser = new Map();
  
  // 搜索类工具按小时限频，避免她一句话查十次
  const searchTimes = [];
  
  // 工具名清单：`my_capabilities` / `audit_self` 用它列「我会什么」。
  // 注意：ctx.get("tools").list() 运行时返回空，所以这份清单是主数据源。
  // 加新工具时要同步往这里加（或者改成动态收集）。
  
  // 黑名单：只挡真正危险的（原来是白名单，68 个之外全拦——太严）
  const DANGEROUS_TOOLS = new Set([
    "bash", "exec", "shell",              // 系统命令
    "read", "write", "read_file", "write_file",  // 任意文件（宿主实现做不到目录限制，只能拦）
    "glob", "grep",                       // 文件系统扫描
    "env", "system_info",                 // 环境变量（可能藏密钥）
  ]);

  if (cfg.toolWhitelist !== false) {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const name = String(exec?.name ?? exec?.call?.name ?? exec?.tool?.name ?? "");
      if (!name) return next();
      // 默认放行；只有黑名单里的挡
      if (!DANGEROUS_TOOLS.has(name)) {
        if ((name === "web_search" || name === "web_fetch") && !searchRateOk()) {
          logger.warn?.(`[onebot] 搜索太频繁，本次拒绝：${name}`);
          return { kind: "deny", reason: "这一小时查得够多了，先凭印象回答或者直说不知道。" };
        }
        return next();
      }
      logger.warn?.(`[onebot] 拦截工具调用：${name}`);
      audit({ kind: "tool_blocked", tool: name });
      // 与其说「不允许」，不如告诉她该用哪个——被拦一次不该变成一次训话
      const ALT = {
        write: "想记一句话用 remember_self，想记事实用 remember_fact",
        read: "想读东西用 read_note / read_notebook / read_page",
        bash: "要跑代码用 exec_sandbox",
        exec: "要跑代码用 exec_sandbox",
        write_file: "文件操作在聊天里做不了，用 note_file 写到自己的桌上",
        read_file: "读文件用 read_note / read_notebook / read_page",
        glob: "找文件用 list_notes 或 files",
        grep: "找内容用 read_note 或 my_memory",
      };
      const alt = ALT[name];
      return {
        kind: "deny",
        reason:
          `${name} 在聊天里用不了（它动的是文件和命令行，不是聊天）。` +
          (alt ? `\n想记东西的话：${alt}。` : "") +
          `\n不用绕远路，直接说你想做什么就行。`,
      };
    });
    logger.info?.("[onebot] 工具黑名单已启用（只挡 bash/read/write/glob/grep 等危险工具）");
  }

  // ═══════════════════════════════════════════════════════════════
  // 关注规则 + 群巡查
  // 规则是她自己维护的（watch_topic）。命中的群消息不打断她，
  // 攒着，等她被叫到时一起看到。
  // ═══════════════════════════════════════════════════════════════
  const WATCH_PATH = join(HOME, ".dsh/onebot-bridge/watch-rules.json");
  
  /** 命中判断：返回命中的说明数组（空 = 没命中） */
  
  // L1 攒批：命中的消息先存着，不打断她
  const l1Pending = [];
  function l1Push(item) {
    l1Pending.push(item);
    while (l1Pending.length > 80) l1Pending.shift();
  }
  function l1TakeText() {
    if (!l1Pending.length) return "";
    const list = l1Pending.splice(0, l1Pending.length).slice(-8);
    const lines = list.map(
      (x) =>
        "· [群" + x.group + "] " + String(x.who).slice(0, 12) + "：" +
        String(x.text).slice(0, 80) + "（" + x.hits.join("、") + "）",
    );
    return "\n[群里这些可能你会想看]\n" + lines.join("\n");
  }

  /** 群活跃度：从本地 group-meta 读，不需要 QQ 在线 */
  
  /** 某个群最近的原文 */
  
  // ═══════════════════════════════════════════════════════════════
  // 配置 / 群管理工具（替代原来的 30+ 个正则指令）
  // ═══════════════════════════════════════════════════════════════

  /** 只有创造者能改的东西 */
  
  /** set_config 允许改的 key（白名单） */
  

  // ═══════════════════════════════════════════════════════════════
  // 社交动作工具（发说说 / 撤回 / 名片赞 / 看群公告）
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // 余额工具：看她自己的 API 余额（创造者充的"生活费"）
  // ═══════════════════════════════════════════════════════════════
  
  // 用 SVG 画图：适合图表、示意、简笔，不依赖外部 API
  
  // 画图：低频，气氛到了才用
  
  // 群里 @ 第三方：必要时才用，频率受限
  
  // 新闻工具：对话中按需查热点
  
  // 继续展开转发：她感兴趣时可以多看几条
  
  // 回忆工具：从归档里检索很久以前的内容
  
  // 全局事实工具：跨会话的稳定事实
  
  // 自我观点工具：她可以记录自己的看法
  
  // 反思时用：改写 / 删除已经过时的想法（记忆没有上限，但允许自己修正）
  
  // 人物档案工具：让她能主动记住某个人的特点
  
  // 表情包工具（全局注册；只有 QQ 回合里调用才有意义）
  // 存表情每小时限频用的时间戳（此前漏了声明，save_sticker 必抛 ReferenceError）
  const savedStickerTimes = [];

  // QQ 原生小黄脸：单独发一个（文字里想夹就用 [face:13] 标记）
  
  // 待确认的入群邀请：flag -> { groupId, inviter, subType, at }
  const pendingInvites = new Map();

  /** 处理群邀请/加群请求：创造者的邀请直接同意，别人的先问创造者 */
  // 待处理的好友请求：flag -> { userId, comment, at }
  const pendingFriends = new Map();

  /** 解析时长：「半小时」「30 分钟」「2 小时」 */
  
  /** 今日/运行时状态摘要 */
  
  /** 当前时间 + 作息状态（23-1 点还精神，1-6 点最沉默） */
  
  /** 读 mood 插件的心情，作为语气底色 */
  
  /** 会话事件文本提取 */
  /** 从桥的 prompt 里剥出「对方真正说的话」；纯内部提示返回空 */
  
  /** 从事件里取文本；返回 { text, role }，role: "对方" / "我" */
  
  /** 在归档里搜关键词；返回最近若干条 */
  /** 列出会话文件（按修改时间倒序） */
  
  /** 把检索结果排成提示词片段 */
  
  // 好友数 / 群数（5 分钟缓存）
  
  // 群名缓存（10 分钟刷新一次）
  
  // ── 定时提醒 ──────────────────────────────────────────────
  const REMINDER_PATH = join(HOME, ".dsh/onebot-bridge/reminders.json");
  
  /** 解析提醒时间：「明天9点」「今天15:30」「每天8点」「两小时后」 */
  
  // ── 回复长度：交给她自己判断，不随机抽、不强制 ──
  // 只提供三样信息：她的惯例分布、最近 10 条实际字数、最近 100 条实测比例。
  // 原实现是 Math.random() 抽一个档位塞给她当命令，实测压不住（抽到长档实际中位 45 字，
  // 抽到短档反而是 24 字）——所以改成「给她看自己的习惯」，选哪档由她定。
  const LEN_TIER_EDGES = [8, 25, 40]; // 极短 ≤8 / 短 ≤25 / 中 ≤40 / 长 41-80（超过 80 不进统计）
  const LEN_TIER_NAMES = ["极短", "短", "中", "长"];
  const LEN_RING_MAX = 30; // 只统计最近 30 条：窗口太长会自我强化（越写越长，提示越纵容）
  const LEN_RING = [];
  
  /** 启动后第一次调用时从 audit.log 尾部回填，重启不丢连续性 */
  
  /** 每次回复后记一笔；表情包（0 字）和长文（>150）不计入 */
  
  /** 这轮喂给她的长度参照：惯例 + 最近 10 条 + 最近 100 条比例 */
  
  /** 今日统计报表 */
  
  /** 完整功能与指令清单（给创造者看的） */
  
  /** 创造者的自然语言控制：状态/打断/思考档位/群内发言/静音 */
  // ── 轮询好友申请（NapCat 不以 request 事件推送，只能主动查） ──
  const notifiedFriends = new Set();
  
  /** 戳一戳：只有当刚才在跟自己说话时才回应 */
  
  /** 创造者私聊指令：表情包清单 / 单独看某一张 */
  
  /**
 * 只保留「危险或涉及创造者身份」的指令给桥直接执行：
 * 退群、加群、改配置、代发言、同意/拒绝、静音/风控、续聊参数。
 * 其余（活动、提醒、记住、查询类）全部交给 agent 自己判断并调工具。
 */

  /** 创造者的「定向搭话」：去某群 @ 某人说一句 */
  const relayDone = new Set(); // 已执行过的定向搭话指令 id
  
  /** 创造者的「记住 X」：直接落库，不经过模型 */
  
  /** 创造者的退群指令：识别群号或群名，执行后保留记忆与档案 */
  
  /** 创造者对邀请的答复：返回 true 表示这条消息被消费掉了 */
  
  /** 合并窗口：对方连续快速发消息时，攒一会儿一起回 */
  const mergeBuf = new Map();
  
  /** 正在处理中的 message_id，防止实时事件和轮询重复回复同一条 */
  const processingIds = new Set();

  /** 取图：先走直连 CDN，失败再用 NapCat 的 get_image 兜底 */
  
  // ═══════════════════════════════════════════════════════════════
  // 事件队列 + 串行处理（2.0.0 核心）
  // 她只面对「事件」，怎么回应用工具决定
  // ═══════════════════════════════════════════════════════════════
  const INBOX_PATH = join(HOME, ".dsh/onebot-bridge/inbox.jsonl");
  const inbox = [];              // 内存里的事件
  
              // idle | busy
  
  /**
   * 事件 -> 发送目标。
   * ⚠️ 这是「回复谁」的唯一权威来源。
   * 不能靠 lastInbound（那是全局最后一条，可能是别人的），
   * 也不能靠 entry.lastTarget（wakeNow 用的 self:main 不是会话 session）。
   */
  
  // 单条入站正文最多给多少字。超了必须「明说被截断」——
  // 以前这里是静默 slice(0, 500)：用户那条 1053 字的代码审视清单到她手里只剩 500 字，
  // 她以为那就是全部，还回了句「剩下的模块清单我没收到」。
  const INBOUND_TEXT_MAX = 4000;
  
  /** 把事件渲染成她看得懂的一段话 */
  
  /** 上次/下次活动的时间线（每次唤醒都带上） */
  
  /**
   * 唤醒用的 session key：按小时分。
   * 为什么不用固定的 "self:main"——旧 prompt 格式会留在 session 历史里，
   * 她会被带偏（比如把昵称当 target）。每小时换一个新的，历史就不污染了。
   */
  
  /** 处理一批事件（一次一条，串行） */
  
  /** 事件入队：空闲立刻醒，忙则排队 */
  
  // ═══════════════════════════════════════════════════════════════
  // qq_send / reply_to —— 出站工具
  // ═══════════════════════════════════════════════════════════════
  
  // ═══════════════════════════════════════════════════════════════
  // 主动社交工具：找好友私聊 / 在群里 @ 第三方
  // ═══════════════════════════════════════════════════════════════
  
  // ═══════════════════════════════════════════════════════════════
  // 看图工具：旁听时图只剩「[图片]」，想真看就把原图取回来
  // ═══════════════════════════════════════════════════════════════
  
  // ═══════════════════════════════════════════════════════════════
  // 群消息读取工具（P2）：read_message / read_context / read_thread
  //                      + expand_forward / search_messages
  // ═══════════════════════════════════════════════════════════════
  
  // ═══════════════════════════════════════════════════════════════
  // 第二步：活动由她自己排（schedule_activity）+ 看上下文（my_context）
  // ═══════════════════════════════════════════════════════════════
  
  /** 执行一轮并发送回复 */
  
  /** 其他群最近在聊什么（脱敏、截断、只取话题） */
  
  /** 把某个会话 id 自动写进配套插件配置（幂等） */
  
  // ── 运行时状态持久化（重启不丢 msgTimes / lastReplyAt 等） ──
  const RUNTIME_PATH = join(HOME, ".dsh/onebot-bridge/runtime.json");
  // 独立的杂项状态（不跟 sessions 快照混）
  
  function markRuntimeDirty() {
    state.runtimeDirty = true;
    if (state.runtimeTimer) return;
    state.runtimeTimer = setTimeout(() => {
      state.runtimeTimer = null;
      if (!state.runtimeDirty) return;
      state.runtimeDirty = false;
      snapshotRuntime();
    }, 5000);
    state.runtimeTimer.unref?.();
  }

  // ── 群活动快照（重启或隔天后仍能说清"昨天聊过什么"） ──
  
  /** 只写变了的群：一群一个文件 */
  
  // ── 需求记事本：她想要的东西随手记下来，等创造者有空处理 ──
  
  // ── 创造者专用 WebUI：HTTP + SSE，只认 token ──
  const webClients = new Set(); // SSE 连接
  const webHistory = []; // 最近 100 条，刷新页面能看到
  
  const WEBHIST_PATH = join(HOME, ".dsh/onebot-bridge/webui-history.jsonl");

  // 读不出来 ≠ 没有历史。以前 catch 里直接 return []，接口就回 200 + 空数组，
  // WebUI 看到的是「没有历史」而不是「读失败」，客户端还会显示「在线」。
  // 只有文件不存在（全新安装）才算真的没有；其它错误留在这里，让 /history 报 500。
  
  /** 从会话文件里读对话历史（跨重启保留） */
  
  /** 从会话文件里读对话历史（跨重启保留）；找不到指定会话就找最像私聊的 */
  
  // ── 离线模式：断线超过 30 分钟 = 她「还能想，但说不了话」──
  
   // WS 通 ≠ QQ 登录着（封号时正是如此）
  async function refreshQqOnline() {
    try {
      const info = await client.call("get_login_info", {}, 6000);
      const uid = Number(info?.user_id ?? 0);
      const was = state.qqOnline;
      state.qqOnline = uid > 0;
      if (was !== state.qqOnline) logger.info?.(`[onebot] QQ 登录状态变为：${state.qqOnline ? "在线" : "离线"}`);
    } catch {
      state.qqOnline = false;
    }
  }
  
  /** 离线期间的学习清单（给她恢复后看） */
  
  // ── 主动行为时段：23 点到次日 9 点不主动开口 ──
  
  /** 自主活动的时段：比「主动发言」宽松（内部活动不打扰任何人） */
  
  // ── 她发出去的消息 id：有人引用这条，等于在跟她说话 ──
  const myMsgIds = new Set();
  const myMsgOrder = [];
  
  client.onSentMessage = (mid) => noteMyMessage(mid);

  /** 这条消息引用了她自己发的内容吗 */
  function isReplyToMe(parsed) {
    try {
      if (!Array.isArray(parsed?.replyIds) || !parsed.replyIds.length) return false;
      return parsed.replyIds.some((rid) => myMsgIds.has(String(rid)));
    } catch {
      return false;
    }
  }

  // ── 掉线记录：让她知道自己刚才断过 ──
  const OUTAGE_PATH = join(HOME, ".dsh/onebot-bridge/outages.json");
  
  try {
    const raw = readFileSync(OUTAGE_PATH, "utf8");
    state.outages = JSON.parse(raw);
    if (!Array.isArray(state.outages)) state.outages = [];
  } catch {
    state.outages = [];
  }
   // 当前这次掉线的开始时间（0 = 没在掉线）
   // 最近一次已恢复的掉线 { downAt, upAt, minutes }

  /** 给她看的掉线摘要（最近 2 小时内） */
  
  // ── 健康状态（给看门狗读） ──
  const HEALTH_PATH = join(HOME, ".dsh/onebot-bridge/health.json");
  const health = {
    lastPollAt: 0,
    lastEventAt: 0,
    apiFailStreak: 0,
    eventMissSince: 0,
    restartedAt: Date.now(),
  };
  
  /** 把运行时配置写回 config.json */
  
  // ── 掉线恢复后：补回复最近一次 @ ────────────────────────────
  
  // ── 工具审批：QQ 会话里自动拒绝，避免回合挂死 ──────────────
  // DSH 的 approval/request 是 waterfall；不接管就会一直等。
  
  // ── 统一的工具调用日志：她调了什么、成没成，都留个痕 ──
  const TOOL_LOG_SKIP = new Set(["list_stickers", "repeat_reminder"]);
  try {
    
    logger.info?.("[onebot] 工具调用日志已启用");
  } catch (err) {
    logger.warn?.(`[onebot] 工具日志注册失败：${err?.message ?? err}`);
  }

  // ── 同步只读源码副本 ──
  // read_source / audit_self 读的是 /opt/fish-src/index.js。之前没有任何同步机制，
  // 副本停在 10-29（10919 行），真实文件已经 14037 行 —— 她照抄「原文」时抄的是
  // 两天前的代码，改动申请里的 oldCode 对不上。现在每次启动都覆盖一次。
  try {
    // 3.0 起是目录：整棵树（index.js + src/）都镜像过去，否则她只看得到装配层
    const r = mirrorSource(HERE);
    logger.info?.(`[onebot] 源码副本已同步：${r.files} 个文件 / ${r.kb} KB`);
  } catch (err) {
    logger.warn?.(`[onebot] 源码副本同步失败：${err?.message ?? err}`);
  }

  // ── 自发消息转发：agent 自己开口（speak-up 等）时把话发到 QQ ──
  // 桥触发的回合由 sendHuman 自己发，这里只处理「不是桥触发的」turn。
  
  // 预热群会话：让 speak-up 主动开口时，群里也有常驻 agent 接得住。
  // apply 时 agent-loop 可能还没注册 factory，所以延迟重试。
  void (async () => {
    for (const gid of cfg.prewarmGroups ?? []) {
      for (let attempt = 1; attempt <= 12; attempt++) {
        try {
          const key = "group:" + gid;
          const entry = await sessions.ensure(key);
          if (!entry.handle) entry.handle = await sessions.openAgent(entry.sessionId);
          entry.lastTarget = { message_type: "group", group_id: Number(gid), user_id: 0 };
          logger.info?.("[onebot] 预热群会话 " + key + " -> " + entry.sessionId);
          break;
        } catch (err) {
          const msg = String(err?.message ?? err);
          if (attempt === 12) logger.warn?.("[onebot] 预热群 " + gid + " 最终失败：" + msg);
          else await sleep(5000);
        }
      }
    }
  })();

  // 主动分享的原始标题（key -> topic），用于检测是否照抄
  const entryLastTopic = new Map();

  // ── 主动行为调度 ──────────────────────────────────────────────
  const pickTarget = () => {
    const wanted = cfg.dailyBriefTarget || "";
    if (wanted) {
      const entry = [...sessions.entries.entries()].find(([, e]) => e.sessionId === wanted);
      if (entry) return entry;
    }
    // 优先群会话（更像在群里冒个泡），否则私聊
    const entries = [...sessions.entries.entries()];
    const group = entries.find(([k]) => k.startsWith("group:"));
    return group ?? entries[0] ?? null;
  };

  // 统一用「活跃时段」：23-9 点不做任何主动行为
  const inQuietHours = () => !activeHoursOk();

  // ── 冷群找话题：每 10 分钟检查一次 ──────────────────────────
  
  // ── 轮询兜底：NapCat 不推送"纯 @ 无文字"的消息，只能主动拉 ──
  
  /** 私聊补回复：NapCat 有 get_friend_msg_history，掉线期间的私聊也能捞回来 */
  
  // ── 早上统一补回昨晚错过的消息 ─────────────────────────────
  
  // ── 她的一天：每晚总结发给创造者 ─────────────────────────────
  
  // ── 自我反思：每天一次 ─────────────────────────────────────
  
  // ── 工具：回头看自己（替代固定的 22:00 定时）────────────────
  
  // ── token 用量告警 ─────────────────────────────────────────
  
  // ── 自动压缩：只有会话文件超过阈值才压 ──────────────────────
  
  setAuditEnabled(cfg.auditLog !== false);
  rotateAudit();
  audit({ kind: "boot", selfId: cfg.selfId, ownerId: cfg.ownerId });
  // 创造者专用 WebUI
  try {
    webStart();
  } catch (err) {
    logger.warn?.(`[onebot] WebUI 启动异常：${err?.message ?? err}`);
  }

  // 等预热完成后启动定时器（避免太早没有可用会话）
  
  // 启动后 30 秒先跑一次，别让冷群等满 10 分钟
  
  // ── 每小时内省：让她自己决定要不要记、要不要反思（不发到 QQ）──
  
  // 启动后 5 分钟跑第一次，之后每小时一次
  
  // ── 自主探索：顺着链接往下读，学成一条记忆 ──
  
  // ── L0 自我认知：三层（事实的我 / 我觉得的我 / 别人眼里的我）──
  const SELF_MODEL_PATH = join(HOME, ".dsh/onebot-bridge/self-model.json");
  const SELF_HISTORY_PATH = join(HOME, ".dsh/onebot-bridge/self-history.jsonl");

  /** 拼成注入用的文字 */
  
  /** 被明确评价时，只记来源，不立刻改自我描述 */
  
  /** 微调：只改需要改的句子，没变就不动 */
  
  // ── 摘要：每 20 条记忆压成一段 200 字的「这几天我经历了什么」──
  
  /** 最近一次摘要之后的记忆，够 20 条就压一次 */
  
  /** 按当前消息里的词，从记忆日志里捞几条相关的（"突然想起来"的机制） */
  
  /** 最近 N 天的摘要，拼成一段注入用的文字 */
  
  // ══ 记忆网络：节点 + 边 + 多入口 ══
  // 每个节点最多 5 条边；检索时从 2-6 个入口并行游走，最深 10 跳，权重逐跳衰减
  
  const NET_MAX_DEPTH = 10;
  const NET_DECAY = 0.82; // 每跳权重衰减
  const NET_VISIT_CAP = 240; // 单次游走最多访问节点数
  const NET_MIN_W = 0.08; // 低于此权重不再扩展

  /** 往索引里挂一个入口 */
  
  /** 加一条边（双向，最多 5 条，同类型同目标不重复） */
  
  /** 写入一个记忆节点，并自动建横向边（规则，免费） */
  
  /**
   * 从多个入口并行游走
   * @param entries 形如 ["topic:偏头痛", "person:123456789", "day:2026-10-28"]
   * @param opts   { depth, maxNodes }
   */
  
  // ── 统一记忆日志：所有「发生过的事」都往这里写一条 ──
  // 目的：让记忆有条理（统一字段、可按主题/时间检索），也是摘要生成的原料
  
  const memSeen = new Set();

  // 自主活动用独立会话：不污染聊天上下文，也不会让活动记录混进对话历史
  const SELF_ACTIVITY_KEY = "self:activity";

  /** 还没有自我认知时，生成初版（启动后 3 分钟跑一次） */
  
  // ── 自主活动：探险 / 思考 / 写点什么 / 回忆 / 憧憬未来 ──
  // 五种活动各自沉淀到不同地方，长期下来塑造核心记忆和性格
  
  const ACTIVITY_KINDS = [
    { id: "explore", w: 20 },
    { id: "think", w: 14 },
    { id: "write", w: 12 },
    { id: "recall", w: 11 },
    { id: "dream", w: 7 },
    { id: "play", w: 8 },
    { id: "read", w: 11 },
    { id: "study", w: 7 },
    { id: "watch_groups", w: 10 },   // 看看群——看完想说什么就说
  ];

  // ── 思考 → 行动 → 反思：三段式 ──
  /** 六层记忆的索引（给她思考时用，不是全文） */
  
  /** 按她思考阶段说的 intent 去查（不再自己挑话题） */
  
  /** 第一段：思考——她决定做什么 */
  
  /** 第三段：回看——行动之后回头看一眼（不叫反思：反思是查错，回看只是看） */
  
  /** 完整的一轮：思考 → 行动 → 回看 */
  // 全局活动锁：自检、手动触发、定时触发可能同时来，同时跑会撞会话写锁
  
  /** 第二段：行动——按上一段想好的去做 */
  
  /** 做一件自主活动（探险走 maybeExplore，其余走这里） */
  
  /** 把最近的活动沉淀成「核心记忆」——长期塑造她的性格 */
  
  // 探险日志：不只存结论，还存「怎么走到那儿的、当时在想什么」
  const EXPLORE_LOG = join(HOME, ".dsh/onebot-bridge/explore-log.jsonl");
  
  // 每小时看一次（9-23 点之间才真跑，每天仍受 autoExplorePerDay 限制）
  // 自主活动：由她自己决定下一次什么时候（几分钟到几小时）
  
  // 手动触发器：写 run-cycles 文件（内容是次数）就能让她立刻连跑
  
    // 日程到点检查：读她自己的 self-plan.jsonl，到点产生 activity_due 事件。
  // 桥内轮询与外部 selfclock 都调 fireDuePlan；靠 plan 状态保证只触发一次。
  
  logger.info?.("[onebot] 日程到点检查已启动（30 秒一轮，读 self-plan.jsonl）");

  // 启动恢复：不直接跑活动，交给轮询按日程表触发（错过的在 grace 内会补）
  
  // ── 说说：不按固定时间，而是问她「现在有没有想说的」──
  const QZONE_PLAN = join(HOME, ".dsh/onebot-bridge/qzone-plan.json");
  
  const qzoneLog = []; // { at, text, tid }
  
  // 每 20-80 分钟随机问一次（她可以说不）
  const nextQzoneTick = () => {
    const qMin = Number(cfg.qzoneMinMinutes) || 20;
    const qMax = Math.max(qMin + 5, Number(cfg.qzoneMaxMinutes) || 80);
    const delay = (qMin + Math.random() * (qMax - qMin)) * 60000;
    setTimeout(() => {
      void (async () => {
        try {
          await maybeQzone();
        } catch {
          // maybeQzone 内部已记日志
        }
        nextQzoneTick();
      })();
    }, delay).unref?.();
    logger.debug?.(`[onebot] 下次问问说：${Math.round(delay / 60000)} 分钟后`);
  };
  nextQzoneTick();

  // 好友申请：NapCat 不推事件，只能轮询
  
  // 端口探活：NapCat 一起来就立刻重连，不让用户等 60 秒退避
  
  // 冷启动也补一次离线期间的 @（用 seen 进度避免重复）
  
  // 工具注册统一放在启动前：此时所有依赖都已初始化，避免 TDZ
      void registerToolbox({ savedStickerTimes, ACTIVITY_KINDS, ALLOWED_TOOLS, HOME, appendFileSync, audit, cfg, chmodSync, chownSync, client, conversationKey, copyFileSync, crossGroupScope, downloadImage, execFile, execFileSync, existsSync, facts, followUps, groupLabel, health, imagePayloadFrom, join, lastStickerPreview, listMsgKeys, loadActivities, loadDigests, loadGroupMeta, loadMemLog, loadReminders, loadSelfState, loadStickerLabels, loadWants, logger, markRuntimeDirty, mkdirSync, nextSelfPlan, patchSelfState, people, pickSticker, pickStickerCandidates, proactiveLocationNote, promisify, readFileSync, readMsgLog, readMsgLogPageMulti, readSelfPlan, readdirSync, refusePerson, renderMsgRec, resolveSticker, runThinkingCycle, saveReminders, saveWants, selfViews, sessions, smartCut, statSync, state, stripToText, unlinkSync, webPush, writeFileSync, pluginCtx: ctx });
  client.onEvent = createEventHandler({ activeHoursOk, attention, activeWindowTarget, allowed, audit, cancelReviews, cfg, client, closeWindowFor, conversationKey, deferredReview, dedupe, echo, downloadImage, enqueue, facts, fetchLinkPreview, findMsgInLog, flushSeen, formatLenHint, groupMetaTouch, handleGroupRequest, handleOwnerInviteReply, handleOwnerLeaveGroup, handleOwnerNatural, handleOwnerRelay, handleOwnerRemember, handlePoke, health, hitWindow, imagePayloadFrom, isRefused, judgeSwitchTalk, l1Push, l1TakeText, loadCore, loadGroupMeta, logger, markRuntimeDirty, markSeen, mergeBuf, moodContext, msgLogKeyOf, netWalk, noteMirrorSource, openWindow, otherGroupDigest, parseMessage, pendingWhileBooting, people, recallSearch, recentDigestText, recentOutageNote, recordMessage, renderRecall, seenDirty, seenState, selfModelText, selfViews, sessions, state, stripLoneSurrogates, switchJudgeAt, textOverlaps, timeContext, todayKey, watchHit, webPush, pluginCtx: ctx });
  client.onReconnected = createOnReconnected({ audit, catchUpPrivate, cfg, client, logger, recentIds, seenState, sessions, sleep, pluginCtx: ctx });
  ctx.on?.("session/event", createSessionEventHandler({ audit, cfg, client, conversationKey, entryLastTopic, logger, sessions, pluginCtx: ctx }));
  ctx.on("tools/post-execute", createToolHooks({ TOOL_LOG_SKIP, audit, logger, sessions, webPush, pluginCtx: ctx }));
  client.onWebReply = createOnWebReply({ ensureGroupNames, state, webPush, pluginCtx: ctx });
  client.onOfflineText = createOnOfflineText({ cfg, logger, webPush, pluginCtx: ctx });
  ctx.on?.("approval/request", createApprovalHandler({ cfg, logger, sessions, pluginCtx: ctx }));
  registerSelfTools({ SAFE_CONFIG_KEYS, cfg, client, crossGroupScope, dailyReflect, groupPatrolList, isOwner, loadGroupMeta, loadQzonePlan, loadSelfModel, loadSelfState, loadWatch, logger, patchSelfState, pendingFriends, pickTarget, saveQzonePlan, saveWatch, sessions, pluginCtx: ctx });
  registerMediaTools({ cfg, client, logger, sessions, state, pluginCtx: ctx });
  registerChatTools({ cfg, client, logger, pushLen, sessions, state, pluginCtx: ctx });
  registerMemoryTools({ cfg, logger, recallSearch, pluginCtx: ctx });
  startTimers({ ACTIVITY_KINDS, EXPLORE_LOG, HEALTH_PATH, HOME, INBOUND_TEXT_MAX, NET_DECAY, NET_MAX_DEPTH, NET_MIN_W, NET_VISIT_CAP, OUTAGE_PATH, QZONE_PLAN, RUNTIME_PATH, SELF_ACTIVITY_KEY, SELF_HISTORY_PATH, SELF_MODEL_PATH, TOOL_LOG_SKIP, WEBHIST_PATH, activeHoursOk, audit, auditEnabled, cfg, checkReminders, checkTokenBudget, chmodSync, client, copyFileSync, createWebServer, entryLastTopic, existsSync, fireDuePlan, flushInbox, health, hourlyIntrospect, inQuietHours, join, loadActivities, loadSelfModel, loadWebHistory, logger, maybeCompactAll, maybeQzone, memSeen, mkdirSync, myMsgIds, myMsgOrder, net, nextQzoneTick, nextSelfPlan, noteMyMessage, pendingWhileBooting, pickTarget, pollFriendRequests, pollMissedMentions, qzoneLog, readFileSync, recentIds, refreshQqOnline, rotateAudit, runThinkingCycle, saveSelfModel, scheduleDailyBrief, scheduleDiary, scheduleMorningCatchup, scheduleNextSelfActivity, scheduleProactive, seenState, sessions, sleep, snapshotRuntime, statSync, state, unlinkSync, webClients, webHistory, webPush, webStart, pluginCtx: ctx });
  // 只读统计：每 5 分钟采一次上下文用量与构成（system / tools / messages）
  const usageStats = createUsageStats({ ctx, sessions, logger });
  sessions.onTurnUsage = (session, key) => usageStats.note(session, key);
  usageStats.start();
  ctx.on?.("dispose", () => usageStats.stop());

  // 工具目录：常驻 18 个，其余按需查（省掉每次请求 60KB 的 schema）
  const toolCatalog = createToolCatalog({ ctx, logger, toolTable });
  void toolCatalog
    .register()
    .then(() => createPersonaTools({ ctx, logger, personaStore }).register())
    .then(async () => {
      // 提前跑一次迁移，别等到第一条消息才建 persona.json
      __init_personaStore();
      // 复读机开关（默认关，她自己开）
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const tools = ctx?.get?.("tools");
        const def = __init_echo().register();
        tools?.register?.(
          defineTool({
            name: def.name,
            description: def.description,
            parameters: def.parameters,
            output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
            execute: def.execute,
          }),
        );
        logger?.info?.("[onebot] 复读机工具已注册（echo_mode，默认关）");
        try {
          const mdef = __init_mood().register();
          tools?.register?.(
            defineTool({
              name: mdef.name,
              description: mdef.description,
              parameters: mdef.parameters,
              output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
              execute: mdef.execute,
            }),
          );
          logger?.info?.("[onebot] 心情工具已注册（feel）");
        } catch (err) {
          logger?.warn?.("[onebot] 心情工具注册失败：" + (err?.message ?? err));
        }
      } catch (err) {
        logger?.warn?.("[onebot] 复读机注册失败：" + (err?.message ?? err));
      }
      return installSystemPrompt();
    })
    .then(() => userTools.registerMeta().then(() => userTools.loadAll()))
    .catch((err) => logger?.warn?.(`[onebot] 工具目录初始化失败：${err?.message ?? err}`));

  // 她自己造的工具：注册三个入口 + 加载已存在的（坏的定义跳过，不影响启动）
  const userTools = createUserTools({ ctx, logger });

  client.start();

  ctx.on?.("dispose", () => {
    client.stop();
    void sessions.disposeAll();
  });

  // 管理命令（Web UI 里可视）
  try {
    ctx.commands?.register?.({
      name: "onebot-status",
      description: "查看 OneBot 桥状态",
      handler: async () => ({
        kind: "success",
        text: `OneBot 桥：${client.connected ? "已连接" : "未连接"} ${cfg.wsUrl}；会话 ${sessions.entries.size} 个`,
      }),
    });
  } catch {
    // 命令注册失败不影响主链路
  }
}
