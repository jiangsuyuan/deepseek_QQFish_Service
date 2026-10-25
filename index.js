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
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "dsh-onebot-bridge";
/** 不 inject：全部走 ctx.get() 兜底 */
export const inject = [];

const HOME = process.env.HOME || homedir();
const CONFIG_PATH = join(HOME, ".dsh/onebot-bridge/config.json");

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:3001",
  token: "",
  selfId: 0,
  allowUsers: [],
  allowGroups: [],
  groupRequireAt: true,
  workspace: join(HOME, ".dsh/onebot-bridge/workspace"),
  maxReplyChars: 3500,
  replyOnError: true,
  /** 允许主动说话的群（预热群会话，speak-up 开口时能落到这里） */
  prewarmGroups: [],
  /** 表情包目录（png/jpg/gif/webp，文件名带情绪关键词） */
  stickerDir: '',
  stickerEnabled: false,
  /** 控制者（主人）的 QQ 号：写进提示词，且私聊只认他 */
  ownerId: 0,
  /** 拟人化：把长回复拆成多条发 */
  splitReplies: true,
  maxParts: 3,
  /** 拟人化：发送前显示「对方正在输入」 */
  typingIndicator: true,
  /** 拟人化：回复前的随机延迟（毫秒区间） */
  replyDelayMs: [400, 1600],
  /** 单回合软超时：超过就取消本轮，避免工具链把聊天拖成 30 秒 */
  turnTimeoutMs: 25000,
  /** 图片理解：是否把 QQ 图片交给模型 */
  enableImages: true,
  maxImagesPerMessage: 2,
  maxImageBytes: 6000000,
  /** 轻度限流：每会话每分钟最多回几条 / 每人每小时最多触发几次 */
  ratePerMinute: 6,
  ratePerUserHour: 30,
  /** 群里回复时引用原消息（人多时更容易对上话） */
  quoteInGroup: true,
  /** 连续对话：她刚回过的群友，在窗口内不 @ 也能接着说 */
  followUpEnabled: true,
  followUpSeconds: 180,
  /** 一次主动搭话最多接几轮，超过就停（等下一次被 @） */
  followUpMaxTurns: 5,
  /** 群聊记忆互通：把其他群最近在聊的话题带一点进来 */
  crossGroupMemory: true,
  crossGroupMax: 4,
  /** 新闻源与过滤 */
  newsUrl: "https://top.baidu.com/board?tab=realtime",
  newsCacheMinutes: 30,
  newsMaxItems: 8,
  /** 链接预览：抓前 N 字正文 */
  linkPreview: true,
  linkPreviewChars: 600,
  /** 说说：每天 0-3 条，9-23 点之间随机 */
  qzoneEnabled: true,
  qzonePerDayMax: 3,
  qzoneStartHour: 9,
  qzoneEndHour: 23,
  /** 说说可见范围：1=所有人 4=好友 16=部分好友 64=仅自己 128=部分好友不可见 */
  qzoneVisibility: 1,
  /** 活跃群主动参与：久没被 @ + 群聊很热时插一句 */
  activeJoinEnabled: true,
  activeJoinIdleMinutes: 10,
  activeJoinPerMinute: 6,
  activeJoinCooldownMinutes: 30,
  /** 冷群找话题：超过 N 小时没人说话，主动开一次 */
  quietTopicEnabled: true,
  quietTopicHours: 2,
  /** 运行时状态（自然语言控制） */
  mutedUntil: 0,
  reasoningEffortOverride: "",
  /** 回忆：归档检索 */
  recallEnabled: true,
  recallAutoTrigger: true,
  recallMaxHits: 5,
  recallCrossSession: true,
  /** 压缩：文件超过多少 MB 才压 */
  compactThresholdMB: 50,
  compactCheckMinutes: 30,
  /** 当日 token 超过这个数就私聊提醒 */
  tokenDailyAlert: 600000,
  /** 作息：几点算深夜/凌晨 */
  nightStart: 23,
  nightEnd: 7,
  /** 情绪惯性：读 mood 插件的状态 */
  moodContext: true,
  /** 自我反思：每天一次 */
  selfReflect: true,
  reflectHour: 22,
  /** 早上统一补回昨晚错过的消息 */
  morningCatchup: true,
  morningCatchupHour: 7,
  morningCatchupMinute: 30,
  /** 新会话出现时，自动把配套插件配置好（记忆/主动搭话/心情） */
  autoConfigurePlugins: true,
  /** 审计日志 */
  auditLog: true,
  /** 主动分享新鲜事 */
  proactiveEnabled: true,
  proactiveMinMinutes: 60,
  proactiveMaxMinutes: 120,
  proactiveChance: 0.45,
  proactiveQuietStart: 1,
  proactiveQuietEnd: 8,
  /** 每天简讯 */
  dailyBriefEnabled: true,
  dailyBriefHour: 9,
  dailyBriefTarget: "",
  thinkNotice: true,
  // QQ 场景的回复风格约束：拼在每条消息前，控制篇幅（不影响 Web 会话的全局人格）
  styleHint:
    "（QQ 聊天场景：像真人发消息一样简短，默认 1-3 句、40-120 字。" +
    "不要用 markdown 标题、列表、加粗，不要复述我的问题，不要总结。" +
    "只有我明确说「详细说说」时才展开。）",
};


function loadConfig(logger) {
  const cfg = { ...DEFAULTS };
  try {
    if (existsSync(CONFIG_PATH)) {
      Object.assign(cfg, JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
    } else {
      logger?.warn?.(`[onebot] 配置文件不存在：${CONFIG_PATH}（使用默认值）`);
    }
  } catch (err) {
    logger?.warn?.(`[onebot] 配置解析失败：${err?.message ?? err}（使用默认值）`);
  }
  if (!cfg.workspace) cfg.workspace = DEFAULTS.workspace;
  return cfg;
}

// ── 会话 key / id ─────────────────────────────────────────────────────

function conversationKey(ev) {
  return ev.message_type === "group" ? `group:${ev.group_id}` : `private:${ev.user_id}`;
}

function sessionIdBase(key) {
  return `ob-${createHash("sha256").update(`dsh-onebot-bridge\0${key}`).digest("hex").slice(0, 12)}`;
}

// ── OneBot 消息解析 ───────────────────────────────────────────────────

/** 从 OneBot 消息段数组提取纯文本；返回 {text, hasAt, images} */
function parseMessage(ev, selfId) {
  const segs = Array.isArray(ev.message) ? ev.message : [];
  let text = "";
  let hasAt = false;
  const images = [];
  const forwards = [];
  const files = [];
  const replyIds = [];
  let replySummary = "";
  for (const seg of segs) {
    if (!seg || typeof seg !== "object") continue;
    const type = seg.type;
    const data = seg.data ?? {};
    if (type === "text") {
      text += String(data.text ?? "");
    } else if (type === "at") {
      if (String(data.qq) === String(selfId) || data.qq === "all") hasAt = true;
    } else if (type === "image") {
      images.push({ url: String(data.url || data.file || ""), summary: String(data.summary || "") });
    } else if (type === "reply") {
      const rid = String(data.id ?? data.message_id ?? "");
      if (rid) replyIds.push(rid);
      // 摘要文本：拿不到原消息时至少知道引用了啥
      const sum = String(data.content ?? data.summary ?? "").trim();
      if (sum) replySummary = sum.slice(0, 120);
    } else if (type === "face") {
      text += "";
    } else if (type === "forward") {
      const id = String(data.id ?? data.message_id ?? data.resid ?? "");
      forwards.push({ id, rawKeys: Object.keys(data), raw: data });
    } else if (type === "file") {
      files.push({
        id: String(data.file_id ?? data.id ?? data.file ?? ""),
        busid: data.busid,
        name: String(data.name ?? data.file_name ?? data.file ?? "文件"),
        size: Number(data.file_size ?? data.size ?? 0),
      });
    }
  }
  text = text.trim();
  if (images.length > 0 && !text) text = "[图片]";
  return { text, hasAt, images, forwards, files, replyIds, replySummary };
}

// ── OneBot WS 客户端 ─────────────────────────────────────────────────

class OneBotClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.pending = new Map(); // echo -> {resolve, reject, timer}
    this.retry = 0;
    this.echoSeq = 0;
    this.onEvent = () => {};
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  connect() {
    if (this.stopped) return;
    const url = new URL(this.cfg.wsUrl);
    if (this.cfg.token) url.searchParams.set("access_token", this.cfg.token);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.logger?.warn?.(`[onebot] WebSocket 构造失败：${err?.message ?? err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      const wasReconnect = this.retry > 0 || this.everConnected;
      this.connected = true;
      this.retry = 0;
      this.everConnected = true;
      this.logger?.info?.(`[onebot] 已连接 ${this.cfg.wsUrl}`);
      // 每次连接成功都补一次离线消息，但延后 25 秒——
      // 刚启动时 agent-loop 还没加载，立刻补会卡在 sessions.ensure 里
      setTimeout(() => {
        try {
          this.onReconnected?.();
        } catch {
          // 补回复失败不影响连接
        }
      }, 25000).unref?.();
    });

    ws.addEventListener("message", (e) => {
      let payload;
      try {
        payload = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8"));
      } catch {
        return;
      }
      // action 响应
      if (payload && payload.echo !== undefined && this.pending.has(payload.echo)) {
        const p = this.pending.get(payload.echo);
        this.pending.delete(payload.echo);
        clearTimeout(p.timer);
        if (payload.status === "ok" || payload.status === "async") p.resolve(payload.data);
        else p.reject(new Error(`OneBot 调用失败：${payload.retcode} ${payload.message ?? ""}`));
        return;
      }
      // 事件推送
      if (payload && payload.post_type) {
        try {
          this.onEvent(payload);
        } catch (err) {
          this.logger?.warn?.(`[onebot] 事件处理异常：${err?.message ?? err}`);
        }
      }
    });

    ws.addEventListener("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (wasConnected) this.logger?.warn?.("[onebot] 连接断开");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close 事件会跟着来，这里只降噪
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.retry += 1;
    const delay = Math.min(60000, 1000 * Math.pow(2, Math.min(this.retry, 6)));
    // 只在第 1 次和每 10 次打一条，避免掉线时刷屏
    if (this.retry === 1 || this.retry % 10 === 0) {
      this.logger?.warn?.(
        `[onebot] 连接断开，${Math.round(delay / 1000)}s 后重连（第 ${this.retry} 次）`,
      );
    }
    setTimeout(() => this.connect(), delay).unref?.();
  }

  call(action, params, timeoutMs = 20000) {
    if (!this.connected || !this.ws) return Promise.reject(new Error("OneBot 未连接"));
    const echo = `e${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  /** 显示「对方正在输入」（NapCat set_input_status；失败静默） */
  async typing(ev) {
    if (!this.cfg.typingIndicator) return;
    try {
      const params =
        ev.message_type === "group"
          ? { group_id: ev.group_id, event_type: 1 }
          : { user_id: ev.user_id, event_type: 1 };
      await this.call("set_input_status", params, 4000);
    } catch {
      // 接口不支持就算了
    }
  }

  /** 拟人化发送：随机延迟 → 正在输入 → 分条发送 */
  async sendHuman(ev, text, opts = {}) {
    // 节奏按内容长度自适应：越短越快，像人一样「想多久说多久」
    const len = String(text || "").length;
    let delay;
    if (len <= 6) delay = 150 + Math.random() * 350;
    else if (len <= 40) delay = 600 + Math.random() * 900;
    else if (len <= 120) delay = 1100 + Math.random() * 1300;
    else delay = 1800 + Math.random() * 2000;
    if (delay > 0) await sleep(delay);
    const parts = splitMessage(text, this.cfg);
    await this.typing(ev);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(500 + Math.random() * 900);
      await this.sendText(ev, parts[i], {
        quote:
          !!this.cfg.quoteInGroup &&
          ev.message_type === "group" &&
          i === 0 &&
          opts.quote !== false,
      });
    }
  }

  /** 在群里 @ 某人并发一句话 */
  sendGroupAt(groupId, targetQq, text) {
    return this.call("send_group_msg", {
      group_id: Number(groupId),
      message: [
        { type: "at", data: { qq: String(targetQq) } },
        { type: "text", data: { text: " " + text } },
      ],
    });
  }

  /** 给指定 QQ 号发私聊（非当前会话） */
  sendPrivate(userId, text) {
    return this.call("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "text", data: { text } }],
    });
  }

  /** 发一张本地图片（表情包） */
  sendImage(ev, filePath) {
    let seg;
    try {
      const b64 = readFileSync(filePath).toString("base64");
      seg = [{ type: "image", data: { file: `base64://${b64}` } }];
    } catch {
      seg = [{ type: "image", data: { file: `file://${filePath}` } }];
    }
    return ev.message_type === "group"
      ? this.call("send_group_msg", { group_id: ev.group_id, message: seg })
      : this.call("send_private_msg", { user_id: ev.user_id, message: seg });
  }

  sendText(ev, text, opts = {}) {
    const segs = [];
    if (opts.quote && ev.message_id) {
      segs.push({ type: "reply", data: { id: String(ev.message_id) } });
    }
    segs.push({ type: "text", data: { text } });
    const params =
      ev.message_type === "group"
        ? { group_id: ev.group_id, message: segs }
        : { user_id: ev.user_id, message: segs };
    return this.call(ev.message_type === "group" ? "send_group_msg" : "send_private_msg", params);
  }
}

/** 下载 QQ 图片为 { data, mediaType }；失败返回 null */
async function downloadImage(url, maxBytes) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://qq.com/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!ct.startsWith("image/")) return null;
    return { data: buf, mediaType: ct };
  } catch {
    return null;
  }
}

// ── 新闻源（百度热搜，过滤时政） ──────────────────────────────────────

/** 时政/敏感关键词：命中就丢掉这条热点 */
const POLITICAL =
  /长征|党史|习近平|总书记|主席|总理|国务院|外交部|政治局|人大|政协|两会|军委|国防|军事|台独|两岸|中美|中日|中俄|朝鲜|金正恩|访问|会见|会谈|宣誓|就职|抗战|烈士|革命|红色|党建|干部|巡视|反腐|纪委|涉政|领导人|中央|批示|调研|座谈/;

const NEWS_CACHE = join(HOME, ".dsh/onebot-bridge/news.json");

/** 抓一批非时政热点标题（带 30 分钟缓存） */
async function fetchHotNews(cfg, logger) {
  try {
    const st = statSync(NEWS_CACHE);
    const cached = JSON.parse(readFileSync(NEWS_CACHE, "utf8"));
    if (Date.now() - st.mtimeMs < (Number(cfg.newsCacheMinutes) || 30) * 60000 && Array.isArray(cached.items)) {
      return cached.items;
    }
  } catch {
    // 没缓存就抓
  }
  try {
    const res = await fetch(cfg.newsUrl || "https://top.baidu.com/board?tab=realtime", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const re = /class="c-single-text-ellipsis"[^>]*>([^<]{4,60})</g;
    const items = [];
    let m;
    while ((m = re.exec(html)) !== null && items.length < 60) {
      const t = m[1].trim();
      if (!t || POLITICAL.test(t)) continue;
      if (!items.includes(t)) items.push(t);
    }
    const picked = items.slice(0, Number(cfg.newsMaxItems) || 8);
    try {
      writeFileSync(NEWS_CACHE, JSON.stringify({ at: Date.now(), items: picked }), "utf8");
    } catch {
      // 缓存失败不影响
    }
    logger?.info?.(`[onebot] 抓到 ${picked.length} 条非时政热点`);
    return picked;
  } catch (err) {
    logger?.warn?.(`[onebot] 抓新闻失败：${err?.message ?? err}`);
    return [];
  }
}

// ── 链接预览（只看前 N 字，省 token） ────────────────────────────────

/** 内网地址黑名单（防 SSRF） */
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** HTML 粗略转纯文本 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抓一个链接的标题 + 正文前 N 字 */
async function fetchLinkPreview(url, maxChars, logger) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return null;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "text/html" },
      signal: AbortSignal.timeout(9000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return null;
    const html = buf.toString("utf8");
    const title = (html.match(/<title[^>]*>([^<]{1,120})/i) || [])[1]?.trim() || "";
    const text = htmlToText(html).slice(0, maxChars || 600);
    if (!text && !title) return null;
    return { url, title, text };
  } catch (err) {
    logger?.debug?.(`[onebot] 链接抓取失败 ${url}：${err?.message ?? err}`);
    return null;
  }
}

// ── 已处理进度（重启/掉线后据此补回复） ─────────────────────────────

const SEEN_PATH = join(HOME, ".dsh/onebot-bridge/seen.json");
const seenState = (() => {
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf8"));
  } catch {
    return {};
  }
})();
let seenDirty = false;

function markSeen(key, tsMs, messageId) {
  const rec = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
  if (tsMs && tsMs > (rec.lastTime ?? 0)) rec.lastTime = tsMs;
  if (messageId) {
    rec.ids = Array.isArray(rec.ids) ? rec.ids : [];
    const id = String(messageId);
    if (!rec.ids.includes(id)) rec.ids.push(id);
    if (rec.ids.length > 300) rec.ids = rec.ids.slice(-300);
  }
  seenDirty = true;
}

function flushSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
    writeFileSync(SEEN_PATH, JSON.stringify(seenState));
  } catch {
    // 忽略
  }
}

// ── 每日统计 ──────────────────────────────────────────────────────────

/** 聚合某一天的审计记录（date 形如 2026-10-24） */
function summarizeDay(dateStr) {
  try {
    const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
    const recs = [];
    for (const line of lines) {
      if (!line.includes(dateStr)) continue;
      try {
        const r = JSON.parse(line);
        if (String(r.ts).startsWith(dateStr)) recs.push(r);
      } catch {
        // 跳过坏行
      }
    }
    const inbound = recs.filter((r) => r.kind === "inbound");
    const replies = recs.filter((r) => r.kind === "reply");
    const usage = recs.filter((r) => r.kind === "usage");
    const proactive = recs.filter((r) => r.kind === "proactive" || r.kind === "relay" || r.kind === "daily_brief");
    const limited = recs.filter((r) => r.kind === "rate_limited");
    const byHour = {};
    for (const r of inbound) {
      const h = String(new Date(r.ts).getHours()).padStart(2, "0");
      byHour[h] = (byHour[h] ?? 0) + 1;
    }
    const byKey = {};
    for (const r of inbound) byKey[r.key] = (byKey[r.key] ?? 0) + 1;
    const sum = (k) => usage.reduce((a, b) => a + Number(b[k] ?? 0), 0);
    return {
      date: dateStr,
      inbound: inbound.length,
      replies: replies.length,
      proactive: proactive.length,
      limited: limited.length,
      turns: usage.length,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      totalTokens: sum("totalTokens"),
      byHour,
      byKey,
    };
  } catch {
    return null;
  }
}

/** 把统计写成一句人话 */
function renderStats(st) {
  if (!st) return "";
  const peak = Object.entries(st.byHour).sort((a, b) => b[1] - a[1])[0];
  const keys = Object.entries(st.byKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k.replace("group:", "群").replace("private:", "私聊")} ${v} 条`);
  const tok = st.totalTokens >= 10000
    ? `${(st.totalTokens / 10000).toFixed(1)} 万`
    : String(st.totalTokens);
  const bits = [
    `昨天一共聊了 ${st.inbound} 条，我回了 ${st.replies} 条`,
    keys.length ? `主要来自 ${keys.join("、")}` : "",
    peak ? `最热闹是 ${peak[0]}:00 前后（${peak[1]} 条）` : "",
    st.proactive ? `我自己主动开口 ${st.proactive} 次` : "",
    st.turns ? `模型调用 ${st.turns} 轮、约 ${tok} tokens` : "",
    st.limited ? `被限流 ${st.limited} 次` : "",
  ].filter(Boolean);
  return bits.join("；") + "。";
}

// ── 审计日志 ──────────────────────────────────────────────────────────

const AUDIT_PATH = join(HOME, ".dsh/onebot-bridge/audit.log");
let auditEnabled = true;

function audit(rec) {
  if (!auditEnabled) return;
  try {
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch {
    // 审计写失败不影响对话
  }
}

/** 审计文件超过 5MB 时轮转一份 */
function rotateAudit() {
  try {
    const st = statSync(AUDIT_PATH);
    if (st.size > 5 * 1024 * 1024) {
      renameSync(AUDIT_PATH, AUDIT_PATH + ".1");
    }
  } catch {
    // 文件不存在就算了
  }
}

// ── 自我观点（她自己的看法，不是别人喂给她的） ────────────────────

const SELF_PATH = join(HOME, ".dsh/onebot-bridge/self.json");

const selfViews = {
  data: [],
  reflections: [],
  loaded: false,
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(SELF_PATH, "utf8"));
      if (Array.isArray(raw)) {
        this.data = raw;
        this.reflections = [];
      } else {
        this.data = Array.isArray(raw?.views) ? raw.views : [];
        this.reflections = Array.isArray(raw?.reflections) ? raw.reflections : [];
      }
    } catch {
      this.data = [];
      this.reflections = [];
    }
  },
  save() {
    try {
      mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
      writeFileSync(
        SELF_PATH,
        JSON.stringify({ views: this.data, reflections: this.reflections }, null, 2),
        "utf8",
      );
    } catch {
      // 忽略
    }
  },
  addReflection(text) {
    const t = String(text || "").trim().slice(0, 300);
    if (!t) return null;
    this.load();
    this.reflections.push({ text: t, at: Date.now() });
    if (this.reflections.length > 20) this.reflections = this.reflections.slice(-20);
    this.save();
    return t;
  },
  renderReflections(n = 2) {
    this.load();
    return this.reflections
      .slice(-n)
      .map((r) => r.text)
      .join("\n");
  },
  add(text) {
    const t = String(text || "").trim().slice(0, 60);
    if (!t || SENSITIVE.test(t)) return null;
    this.load();
    if (this.data.some((v) => v.text === t)) return t;
    this.data.push({ text: t, at: Date.now() });
    if (this.data.length > 30) this.data = this.data.slice(-30);
    this.save();
    return t;
  },
  render(n = 5) {
    this.load();
    return this.data
      .slice(-n)
      .map((v) => v.text)
      .filter((t) => !SENSITIVE.test(t))
      .join("；");
  },
};

// ── 全局事实表（跨会话共享的「关于人的稳定事实」） ────────────────────

const FACTS_PATH = join(HOME, ".dsh/onebot-bridge/facts.json");
/** 硬过滤：命中就不许进共享事实（QQ号、密钥、路径、口令） */
const SENSITIVE = /(\d{6,12})|sk-[A-Za-z0-9]{10,}|\/root\/|token|password|密码|口令|api[_-]?key/i;

const facts = {
  data: [],
  loaded: false,
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8"));
      this.data = Array.isArray(raw) ? raw : Array.isArray(raw?.facts) ? raw.facts : [];
    } catch {
      this.data = [];
    }
  },
  save() {
    try {
      mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
      writeFileSync(FACTS_PATH, JSON.stringify({ facts: this.data }, null, 2));
    } catch {
      // 写失败不影响对话
    }
  },
  add(text, source) {
    const t = String(text || "").trim().replace(/^[，,：:\s]+/, "").slice(0, 80);
    if (!t || SENSITIVE.test(t)) return null;
    this.load();
    if (this.data.some((f) => f.text === t)) return t;
    this.data.push({ text: t, at: Date.now(), source: source || "unknown" });
    if (this.data.length > 20) this.data = this.data.slice(-20);
    this.save();
    return t;
  },
  /** 注入用：最近 n 条拼成一行（再过一次过滤） */
  render(n = 6) {
    this.load();
    const list = this.data
      .slice(-n)
      .map((f) => f.text)
      .filter((t) => t && !SENSITIVE.test(t));
    return list.join("；");
  },
};

// ── 人物档案（每个群友一份印象，跨会话保留） ──────────────────────────

const USERS_PATH = join(HOME, ".dsh/onebot-bridge/users.json");

const people = {
  data: {},
  loaded: false,
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.data = JSON.parse(readFileSync(USERS_PATH, "utf8"));
    } catch {
      this.data = {};
    }
  },
  save() {
    try {
      mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
      writeFileSync(USERS_PATH, JSON.stringify(this.data, null, 2));
    } catch {
      // 写失败不影响对话
    }
  },
  markDirty() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, 8000);
    this._timer.unref?.();
  },
  recordTopics(userId, text) {
    this.load();
    const id = String(userId);
    const rec = this.data[id];
    if (!rec) return;
    try {
      const pure = String(text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ");
      const stop = new Set([
        "这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们",
        "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么",
        "知道", "觉得", "应该", "可能", "真的", "有点", "一直", "时候", "自己",
      ]);
      rec.topics = rec.topics && typeof rec.topics === "object" ? rec.topics : {};
      for (const chunk of pure.split(/\s+/)) {
        for (let n = 2; n <= 4; n++) {
          for (let i = 0; i + n <= chunk.length; i++) {
            const w = chunk.slice(i, i + n);
            if (stop.has(w)) continue;
            rec.topics[w] = (rec.topics[w] ?? 0) + 1;
          }
        }
      }
      // 只保留前 30 个
      const top = Object.entries(rec.topics).sort((a, b) => b[1] - a[1]).slice(0, 30);
      rec.topics = Object.fromEntries(top);
    } catch {
      // 忽略
    }
  },

  setAddress(userId, address) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    rec.address = String(address || "").trim().slice(0, 12);
    this.save();
    return rec.address;
  },
  touch(userId, name, groupId) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    if (name) rec.name = name;
    rec.lastSeen = Date.now();
    rec.count = (rec.count ?? 0) + 1;
    // 活跃时段画像
    try {
      const h = String(new Date().getHours());
      rec.activeHours = rec.activeHours && typeof rec.activeHours === "object" ? rec.activeHours : {};
      rec.activeHours[h] = (rec.activeHours[h] ?? 0) + 1;
    } catch {
      // 忽略
    }
    if (groupId) {
      rec.groups = Array.isArray(rec.groups) ? rec.groups : [];
      if (!rec.groups.includes(String(groupId))) rec.groups.push(String(groupId));
    }
    // 落盘（debounce 5 秒，避免每条消息都写）
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.dirty) {
          this.dirty = false;
          this.save();
        }
      }, 5000);
      this.timer.unref?.();
    }
    return rec;
  },
  remember(userId, note) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    const text = String(note || "").trim().slice(0, 200);
    if (text) {
      rec.notes = Array.isArray(rec.notes) ? rec.notes : [];
      if (!rec.notes.includes(text)) rec.notes.push(text);
      if (rec.notes.length > 12) rec.notes = rec.notes.slice(-12);
      this.save();
    }
    return rec;
  },
  /** 拼进提示词的人物描述 */
  describe(userId) {
    this.load();
    const rec = this.data[String(userId)];
    if (!rec) return "";
    const bits = [];
    if (rec.style) bits.push(rec.style);
    if (Array.isArray(rec.notes) && rec.notes.length) bits.push(rec.notes.slice(-5).join("；"));
    if (rec.address) bits.push(`你平时叫 TA「${rec.address}」`);
    // 活跃时段
    try {
      const hours = Object.entries(rec.activeHours ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([h]) => `${String(h).padStart(2, "0")} 点`);
      if (hours.length && Number(rec.count ?? 0) >= 5) bits.push(`TA 常在 ${hours.join("、")} 出没`);
    } catch {
      // 忽略
    }
    // 常聊话题
    try {
      const topics = Object.entries(rec.topics ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w);
      if (topics.length) bits.push(`TA 常聊：${topics.join("、")}`);
    } catch {
      // 忽略
    }
    const cnt = Number(rec.count ?? 0);
    if (cnt >= 3) {
      const stage = cnt >= 100 ? "老朋友" : cnt >= 20 ? "熟人" : "认识的人";
      bits.push(`你们聊过 ${cnt} 次，算是${stage}`);
    }
    if (Array.isArray(rec.groups) && rec.groups.length > 1) {
      bits.push(`你们在 ${rec.groups.length} 个群里都聊过`);
    }
    return bits.length ? "\n[你对 TA 的印象] " + bits.join("；") : "";
  },
};

// ── 表情包 ────────────────────────────────────────────────────────────

/** 读标签表（文件名 -> 情绪词数组） */
function loadStickerLabels(dir) {
  try {
    return JSON.parse(readFileSync(pathJoin(dir, "labels.json"), "utf8"));
  } catch {
    return {};
  }
}

/** 在表情包目录里按标签挑一张图；挑不到就随机 */
function pickSticker(dir, mood) {
  try {
    const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
    if (!files.length) return null;
    const labels = loadStickerLabels(dir);
    const key = String(mood || "").trim();
    let pool = files;
    if (key) {
      const hit = files.filter((f) =>
        (labels[f] || []).some((t) => t.includes(key) || key.includes(t)),
      );
      if (hit.length) pool = hit;
    }
    const name = pool[Math.floor(Math.random() * pool.length)];
    return {
      path: pathJoin(dir, name),
      name,
      tags: labels[name] || [],
      fallback: pool === files,
    };
  } catch {
    return null;
  }
}

// ── Agent 会话管理 ────────────────────────────────────────────────────

class SessionManager {
  constructor(ctx, cfg, logger) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.logger = logger;
    this.entries = new Map(); // key -> { agentHandle, queue, sessionId }
    this.maxSessions = 24;
    this.runs = 0;
    /** 由 apply 注入：新会话出现时的回调 */
    this.autoConfigure = undefined;
  }

  svc(n) {
    try {
      return this.ctx.get?.(n);
    } catch {
      return undefined;
    }
  }

  async ensure(key) {
    const cached = this.entries.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    const base = sessionIdBase(key);
    mkdirSync(this.cfg.workspace, { recursive: true });

    let sessionId = null;
    try {
      const persistence = this.svc("sessionPersistence");
      const headers = (await persistence?.list?.()) ?? [];
      const mine = headers
        .filter((h) => typeof h.id === "string" && h.id.startsWith(`${base}-`))
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      if (mine.length) sessionId = mine[0].id;
    } catch (err) {
      this.logger?.warn?.(`[onebot] 列举持久化会话失败：${err?.message ?? err}`);
    }
    if (!sessionId) sessionId = `${base}-1`;

    const entry = { sessionId, queue: Promise.resolve(), lastUsed: Date.now(), key };
    this.entries.set(key, entry);
    try {
      this.restoreRuntime?.(entry);
    } catch {
      // 忽略
    }
    // 新会话出现：顺手把配套插件配好（只做一次）
    try {
      this.autoConfigure?.(sessionId);
    } catch {
      // 忽略
    }
    this.logger?.info?.(`[onebot] 会话绑定 ${key} -> ${sessionId}`);
    this.evictIfNeeded();
    return entry;
  }

  /** 默认模型：persona 模板的 {{model}} 依赖它 */
  agentOptions() {
    try {
      const sel = this.svc("agentDefaultModel")?.currentSelection?.();
      if (sel?.provider && sel?.model) {
        const opts = { provider: sel.provider, model: sel.model };
        const override = this.cfg.reasoningEffortOverride;
        if (override) opts.reasoningEffort = override;
        else if (sel.reasoningEffort) opts.reasoningEffort = sel.reasoningEffort;
        return opts;
      }
    } catch {
      // 交给上层报错
    }
    return {};
  }

  /**
   * 打开一个只跑「一个 turn」的 agent。
   * 实测：DSH 的 agent 在首个 turn 结束后 initiator scope 会被 dispose，
   * 之后 followup 无效（报 "agent initiator scope is disposed" 或静默卡住）。
   * 因此每轮重新 resume/create，跑完 finally 里 dispose。
   */
  async openAgent(sessionId) {
    const agents = this.svc("agents");
    if (!agents) throw new Error("DSH agents 服务不可用");
    const agentOptions = this.agentOptions();
    const setup = async (agentCtx) => {
      try {
        const presets = this.svc("agentPresets");
        if (presets?.mount) await presets.mount(agentCtx);
      } catch (err) {
        this.logger?.warn?.(`[onebot] preset 挂载失败：${err?.message ?? err}`);
      }
    };
    const resume = () => agents.resume({ resumeSessionId: SessionId(sessionId), setup, agentOptions });
    try {
      return await resume();
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/already exists/i.test(msg)) return await resume();
      this.logger?.info?.(`[onebot] ${sessionId} 恢复失败，尝试新建：${msg.slice(0, 100)}`);
      try {
        return await agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: this.cfg.workspace },
          setup,
          agentOptions,
        });
      } catch (err2) {
        if (/already exists/i.test(String(err2?.message ?? err2))) return await resume();
        throw err2;
      }
    }
  }

  /** 按 DSH session id 找 entry（插件事件回调用） */
  bySessionId(sid) {
    for (const [, e] of this.entries) {
      if (e.sessionId === sid) return e;
    }
    return null;
  }

  evictIfNeeded() {
    if (this.entries.size <= this.maxSessions) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of sorted.slice(0, this.entries.size - this.maxSessions)) {
      this.entries.delete(key);
      try {
        entry.handle?.dispose?.();
      } catch {
        // 忽略
      }
      this.logger?.info?.(`[onebot] 淘汰会话缓存 ${key}`);
    }
  }

  /** 串行执行一次对话，返回 assistant 文本（常驻 agent，失败自动重建） */
  async run(key, text, ev, images) {
    const entry = await this.ensure(key);
    entry.lastTarget = ev;
    const job = entry.queue.then(async () => {
      if (!entry.handle) {
        entry.handle = await this.openAgent(entry.sessionId);
        this.logger?.info?.(`[onebot] 常驻 agent 就绪 ${entry.sessionId}`);
      }
      try {
        return await this.turn(entry, text, images);
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.logger?.warn?.(`[onebot] 常驻轮失败（${msg.slice(0, 120)}），重建 agent 后重试`);
        try {
          await entry.handle?.dispose?.();
        } catch {
          // 释放失败继续
        }
        entry.handle = await this.openAgent(entry.sessionId);
        return await this.turn(entry, text, images);
      }
    });
    entry.queue = job.catch(() => {});
    return job;
  }

  /** 跑一个 turn：followup → whenIdle → 提取文本 */
  async turn(entry, text, images) {
    entry.inTurn = true;
    entry.running = true;
    try {
      return await this._turn(entry, text, images);
    } finally {
      entry.inTurn = false;
      entry.running = false;
    }
  }

  async _turn(entry, text, images) {
    const agent = entry.handle.agent;
    const session = agent.session;
    this.logger?.info?.(`[onebot] run#${++this.runs} 开始 status=${agent.status} seq=${session.seq}`);
    await withTimeout(agent.whenIdle(), 20000, "whenIdle(1)");
    const firstSeq = session.seq;
    entry.usedStickerOnly = false;
    const blocks = [{ type: "text", text }];
    if (Array.isArray(images) && images.length) {
      const att = this.svc("attachments");
      for (const img of images) {
        try {
          if (!att) throw new Error("attachments 服务不可用");
          const ref = await att.saveImage({ data: img.data, mediaType: img.mediaType });
          blocks.push({ type: "image", attachment: ref });
        } catch (err) {
          this.logger?.warn?.(`[onebot] 图片转存失败：${err?.message ?? err}`);
          blocks.push({ type: "text", text: "[图片处理失败]" });
        }
      }
    }
    agent.followup(
      createUserMessage({
        content: blocks,
        source: { kind: "user" },
      }),
    );
    const budget = Number(this.cfg.turnTimeoutMs) || 25000;
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      this.logger?.warn?.(`[onebot] 回合超过 ${budget}ms，取消本轮（多半是工具链太长）`);
      try {
        agent.cancel({ kind: "user" });
      } catch {
        // 取消失败忽略
      }
    }, budget);
    killer.unref?.();
    try {
      await withTimeout(agent.whenIdle(), 180000, "whenIdle(2)");
    } finally {
      clearTimeout(killer);
    }
    if (timedOut) {
      this.logger?.info?.("[onebot] 本轮被软超时截断，用已有内容回复");
    }
    this.logger?.info?.(`[onebot] run#${this.runs} 回合结束 status=${agent.status} seq=${session.seq}`);
    try {
      const events = session.snapshotEvents?.(firstSeq) ?? [];
      let usage = null;
      for (const ev of events) {
        const u = ev?.data?.usage ?? ev?.data?.message?.usage;
        if (u && typeof u.inputTokens === "number") usage = u;
      }
      if (usage) {
        audit({
          kind: "usage",
          key: entry.lastTarget ? conversationKey(entry.lastTarget) : "",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        });
      }
    } catch {
      // 统计失败不影响回复
    }
    try {
      await this.svc("sessions")?.flush?.(session);
    } catch {
      // 持久化失败不阻塞回复
    }
    const reply = extractReply(session, firstSeq);
    try {
      const evs = session.snapshotEvents?.(firstSeq) ?? [];
      const calledSticker = evs.some(
        (ev) => ev?.type === "tool/call" && ev?.data?.name === "send_sticker",
      );
      if (calledSticker && !String(reply || "").trim()) entry.usedStickerOnly = true;
    } catch {
      // 判断失败按普通回复处理
    }
    return reply;
  }

  /** 只生成一段文本（用于定向搭话），期间抑制自发转发 */
  async generate(key, instruction) {
    const entry = await this.ensure(key);
    const job = entry.queue.then(async () => {
      if (!entry.handle) entry.handle = await this.openAgent(entry.sessionId);
      const agent = entry.handle.agent;
      const session = agent.session;
      await withTimeout(agent.whenIdle(), 20000, "gen-idle");
      const firstSeq = session.seq;
      entry.inTurn = true;
      try {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: instruction }],
            source: { kind: "user" },
          }),
        );
        await withTimeout(agent.whenIdle(), 90000, "gen-turn");
      } finally {
        entry.inTurn = false;
      }
      return extractReply(session, firstSeq);
    });
    entry.queue = job.catch(() => {});
    return job;
  }

  /** 主动回合：让 agent 自己说一段，不进 inTurn（这样自发转发会把它发到 QQ） */
  async runProactive(key, instruction) {
    const entry = await this.ensure(key);
    const job = entry.queue.then(async () => {
      if (!entry.handle) entry.handle = await this.openAgent(entry.sessionId);
      const agent = entry.handle.agent;
      await withTimeout(agent.whenIdle(), 20000, "proactive-idle");
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: instruction }],
          source: { kind: "user" },
        }),
      );
      await withTimeout(agent.whenIdle(), 90000, "proactive-turn");
    });
    entry.queue = job.catch(() => {});
    return job;
  }

  async disposeAll() {
    for (const [, entry] of this.entries) {
      try {
        await entry.handle?.dispose?.();
      } catch {
        // 忽略
      }
    }
    this.entries.clear();
  }

}

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** 默认一条；超过 90 字才拆，最多 maxParts 条 */
function splitMessage(text, cfg) {
  const t = String(text || "").trim();
  if (!t) return [""];
  if (!cfg.splitReplies) return [t];
  const max = Math.max(1, cfg.maxParts || 3);
  if (t.length <= 90) return [t];
  const chunks = t
    .split(/\n{2,}|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  let parts = chunks;
  if (parts.length <= 1) {
    const sentences = t.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
    if (sentences.length <= 1) return [t];
    const out = [];
    let buf = "";
    for (const sen of sentences) {
      if (out.length >= max - 1) {
        buf += sen;
      } else if (buf.length + sen.length > 80) {
        out.push(buf);
        buf = sen;
      } else {
        buf += sen;
      }
    }
    if (buf) out.push(buf);
    parts = out;
  } else {
    const merged = [parts[0]];
    for (let i = 1; i < parts.length; i++) {
      const last = merged[merged.length - 1];
      if (merged.length < max && last.length + parts[i].length < 70) {
        merged[merged.length - 1] = `${last} ${parts[i]}`;
      } else {
        merged.push(parts[i]);
      }
    }
    parts = merged;
  }
  if (parts.length > max) {
    const head = parts.slice(0, max - 1);
    head.push(parts.slice(max - 1).join(" "));
    parts = head;
  }
  return parts;
}

/** 带超时的等待：避免 whenIdle 永久挂起拖死整个队列 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      timer.unref?.();
    }),
  ]);
}

/** 从事件流提取最后一条 assistant 文本 */
function extractReply(session, firstSeq) {
  let text = "";
  let error = null;
  // 新版本 DSH：session.snapshotEvents(fromSeq) 返回只读事件数组；
  // 旧版本可能是 session.events 属性。两个都兼容。
  let events = [];
  try {
    if (typeof session.snapshotEvents === "function") {
      events = session.snapshotEvents(firstSeq) ?? [];
    } else if (Array.isArray(session.events)) {
      events = session.events;
    }
  } catch {
    events = [];
  }
  for (const ev of events) {
    if (typeof ev.seq === "number" && ev.seq < firstSeq) continue;
    if (ev.type === "assistant/message") {
      const blocks = ev.data?.message?.content ?? [];
      const joined = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (joined.trim()) text = joined;
    } else if (ev.type === "turn/end") {
      const reason = ev.data?.reason ?? ev.data;
      if (reason?.kind === "error") error = reason.error?.message ?? "agent turn failed";
    }
  }
  if (!text && error) throw new Error(error);
  return text;
}

// ── 插件主体 ──────────────────────────────────────────────────────────

export function apply(ctx, _pluginConfig) {
  // ctx.logger 的输出不一定进 journal，双写 console 便于排查
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
  const cfg = loadConfig(logger);
  const sessions = new SessionManager(ctx, cfg, logger);
  sessions.autoConfigure = (sid) => autoConfigurePlugins(sid);
  sessions.restoreRuntime = (entry) => restoreRuntime(entry);
  const client = new OneBotClient(cfg, logger);
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

  let lastInbound = null;
  let agentReady = false;
  const pendingWhileBooting = [];

  // 连续对话窗口：key -> Map<userId|"*", { until, turns, max }>
  const followUps = new Map();
  const followSecs = () => Number(cfg.followUpSeconds) || 180;
  const followMax = () => Number(cfg.followUpMaxTurns) || 5;

  function openWindow(key, userId, resetTurns = true) {
    const map = followUps.get(key) ?? new Map();
    const prev = map.get(String(userId));
    map.set(String(userId), {
      until: Date.now() + followSecs() * 1000,
      turns: resetTurns ? 0 : prev?.turns ?? 0,
      max: followMax(),
    });
    followUps.set(key, map);
  }

  /** 找命中的窗口（先按人，再按群级 "*"）；返回 { rec, who } */
  function hitWindow(key, userId) {
    const map = followUps.get(key);
    if (!map) return null;
    for (const who of [String(userId), "*"]) {
      const rec = map.get(who);
      if (!rec) continue;
      if (Date.now() >= rec.until) {
        map.delete(who);
        continue;
      }
      return { rec, who };
    }
    return null;
  }

  /** 她回复成功后推进计数；到上限就关窗 */
  function bumpWindow(key, userId) {
    const map = followUps.get(key);
    if (!map) return;
    for (const who of [String(userId), "*"]) {
      const rec = map.get(who);
      if (!rec) continue;
      rec.turns += 1;
      rec.until = Date.now() + followSecs() * 1000;
      if (rec.turns >= rec.max) {
        map.delete(who);
        logger.info?.(`[onebot] 续聊满 ${rec.max} 轮，关闭窗口 ${key}（${who}）`);
      }
      return;
    }
  }

  // 轻度限流
  const rateKey = new Map();
  const rateUser = new Map();
  function allowRate(key, userId) {
    const now = Date.now();
    const perMin = Math.max(1, Number(cfg.ratePerMinute) || 6);
    const perHour = Math.max(1, Number(cfg.ratePerUserHour) || 30);
    const k = (rateKey.get(key) ?? []).filter((t) => now - t < 60000);
    if (k.length >= perMin) return { ok: false, why: "minute" };
    const u = (rateUser.get(String(userId)) ?? []).filter((t) => now - t < 3600000);
    if (u.length >= perHour) return { ok: false, why: "hour" };
    k.push(now);
    u.push(now);
    rateKey.set(key, k);
    rateUser.set(String(userId), u);
    return { ok: true };
  }

  // 工具白名单：QQ 聊天场景只允许社交类工具
  const ALLOWED_TOOLS = new Set([
    "send_sticker",
    "draw_image",
    "draw_svg",
    "hot_news",
    "at_person",
    "recall",
    "read_forward_more",
    "remember_fact",
    "remember_person",
    "remember_self",
  ]);
  if (cfg.toolWhitelist !== false) {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const name = String(exec?.name ?? exec?.call?.name ?? exec?.tool?.name ?? "");
      if (!name) return next();
      if (ALLOWED_TOOLS.has(name)) return next();
      logger.warn?.(`[onebot] 拦截工具调用：${name}`);
      audit({ kind: "tool_blocked", tool: name });
      return {
        kind: "deny",
        reason: `QQ 聊天场景不允许使用「${name}」这个工具。你只能聊天、发表情包、画图、查新闻、@人。`,
      };
    });
    logger.info?.("[onebot] 工具白名单已启用（拦截 bash/read/write 等）");
  }

  // 用 SVG 画图：适合图表、示意、简笔，不依赖外部 API
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
            "同样是低频使用，只在气氛合适时画。",
          parameters: {
            svg: { type: "string", description: "完整的 SVG 代码" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = String(exec?.agent?.session?.id ?? "");
            const entry = sid ? sessions.bySessionId(sid) : null;
            const target = entry?.lastTarget ?? lastInbound;
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
              await client.sendImage(target, tmp);
              audit({ kind: "draw_svg", len: svg.length, bytes: png.length });
              logger.info?.(`[onebot] 画了张 SVG 图（${png.length} 字节）`);
              return { ok: true, bytes: png.length };
            } catch (err) {
              logger.warn?.(`[onebot] SVG 渲染失败：${err?.message ?? err}`);
              return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
            }
          },
        }),
      );
      logger.info?.("[onebot] SVG 画图工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] SVG 工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 画图：低频，气氛到了才用
  let drawTimes = [];
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "draw_image",
          description:
            "用 AI 画一张写实/插画风格的图。**低频使用**：只在气氛真的到了、对方明确想要一张图时才画。" +
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
            const target = entry?.lastTarget ?? lastInbound;
            if (!target) return { ok: false, reason: "没有会话上下文" };
            const prompt = String(args?.prompt ?? "").trim().slice(0, 300);
            if (!prompt) return { ok: false, reason: "prompt 为空" };

            const now = Date.now();
            drawTimes = drawTimes.filter((t) => now - t < 3600_000);
            const limit = Number(cfg.drawPerHour) || 2;
            if (drawTimes.length >= limit) {
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
              drawTimes.push(now);
              await client.sendImage(target, await (async () => {
                const tmp = join(HOME, ".dsh/onebot-bridge/draw.jpg");
                writeFileSync(tmp, buf);
                return tmp;
              })());
              audit({ kind: "draw_image", prompt: prompt.slice(0, 120) });
              logger.info?.(`[onebot] 画了张图：${prompt.slice(0, 40)}`);
              return { ok: true, sent: true, remaining: limit - drawTimes.length };
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

  // 群里 @ 第三方：必要时才用，频率受限
  let atPersonTimes = [];
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "at_person",
          description:
            "在群里 @ 某个人并说一句话。只在确实必要时用：对话直接涉及他、他说的话被晾着需要回应、" +
            "或者你确实需要他回答。不要为了引人注意而 @，不要 @ 不熟的人，也不要连着 @ 好几次。" +
            "普通聊天直接说话就行，不需要 @。",
          parameters: {
            qq: { type: "string", description: "要 @ 的 QQ 号（从群消息里看到的发言人号码）" },
            text: { type: "string", description: "要说的话，30 字以内，自然一点" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = String(exec?.agent?.session?.id ?? "");
            const entry = sid ? sessions.bySessionId(sid) : null;
            const target = entry?.lastTarget;
            if (!target || target.message_type !== "group") {
              return { ok: false, reason: "只能在群聊里 @ 人" };
            }
            const qq = String(args?.qq ?? "").trim();
            const text = String(args?.text ?? "").trim().slice(0, 60);
            if (!/^\d{5,12}$/.test(qq) || !text) {
              return { ok: false, reason: "qq 或 text 不合法" };
            }
            const now = Date.now();
            atPersonTimes = atPersonTimes.filter((t) => now - t < 3600_000);
            const limit = Number(cfg.atPersonPerHour) || 3;
            if (atPersonTimes.length >= limit) {
              return { ok: false, reason: `本小时 @ 的次数已用完（上限 ${limit} 次）` };
            }
            try {
              await client.sendGroupAt(String(target.group_id), qq, text);
              atPersonTimes.push(now);
              audit({ kind: "at_person", groupId: String(target.group_id), qq, text });
              logger.info?.(`[onebot] @ 了 ${qq}：${text.slice(0, 40)}`);
              return { ok: true, sent: text, remaining: limit - atPersonTimes.length };
            } catch (err) {
              return { ok: false, reason: String(err?.message ?? err).slice(0, 120) };
            }
          },
        }),
      );
      logger.info?.("[onebot] @ 人工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] @ 人工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 新闻工具：对话中按需查热点
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "hot_news",
          description:
            "查看当前网络热点（百度热搜）。当对方问「最近有什么新鲜事」「今天有什么热点」「最近发生啥了」" +
            "之类的问题时调用，拿到标题后用自己的话聊，不要逐条念。",
          parameters: {
            count: { type: "number", description: "返回几条，默认 8，最多 15" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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

  // 继续展开转发：她感兴趣时可以多看几条
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

  // 回忆工具：从归档里检索很久以前的内容
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "recall",
          description:
            "回忆很久以前聊过的内容。对方说「你记得…吗」「上次那个」「之前提过」时调用。" +
            "query 填关键词（如「显卡」「书名」「那个约定」），会返回最相关的几条原文片段。",
          parameters: {
            query: { type: "string", description: "关键词，2-10 个字" },
            all_sessions: { type: "boolean", description: "是否连其他群/私聊一起搜（默认只搜当前会话）" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = exec?.agent?.session?.id;
            const cross = args?.all_sessions === true && cfg.recallCrossSession;
            const res = await recallSearch(sid, args?.query ?? "", { cross });
            return res;
          },
        }),
      );
      logger.info?.("[onebot] 回忆工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 回忆工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 全局事实工具：跨会话的稳定事实
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "remember_fact",
          description:
            "记住一条关于对方的长期事实（城市、职业、喜好、习惯、约定）。所有会话共享。不要记聊天原文、密码、账号、QQ 号。",
          parameters: { text: { type: "string", description: "一句话事实，例如「主人在上海」" } },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const t = facts.add(String(args?.text ?? ""), "model");
            return t ? { ok: true, saved: t } : { ok: false, reason: "内容为空或含敏感信息，未保存" };
          },
        }),
      );
      logger.info?.("[onebot] 全局事实工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 全局事实工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 自我观点工具：她可以记录自己的看法
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "remember_self",
          description:
            "记录你自己的一个看法或偏好（不是关于别人的）。当你形成了明确的喜好、立场、习惯时调用，" +
            "比如「我不喜欢下雨天」「我觉得猫比狗好」。这些会长期保留，让你前后一致。",
          parameters: { text: { type: "string", description: "一句话，30 字内" } },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const t = selfViews.add(String(args?.text ?? ""));
            return t ? { ok: true, saved: t } : { ok: false, reason: "内容为空或含敏感信息" };
          },
        }),
      );
      logger.info?.("[onebot] 自我观点工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 自我观点工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 人物档案工具：让她能主动记住某个人的特点
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "remember_person",
          description:
            "记住某个 QQ 好友/群友的特点（说话风格、喜好、称呼、关系、忌讳）。同一个人多次调用会累积。user_id 填对方 QQ 号。",
          parameters: {
            user_id: { type: "string", description: "对方 QQ 号" },
            note: { type: "string", description: "要记住的一句话，例如「喜欢被叫老大，讨厌被问年龄」" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const rec = people.remember(String(args?.user_id ?? ""), String(args?.note ?? ""));
            return { ok: true, notes: rec.notes };
          },
        }),
      );
      logger.info?.("[onebot] 人物档案工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 人物档案工具注册失败：${err?.message ?? err}`);
    }
  })();

  // 表情包工具（全局注册；只有 QQ 回合里调用才有意义）
  if (cfg.stickerEnabled && cfg.stickerDir) {
    void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "send_sticker",
            description:
              "给当前 QQ 聊天发一张表情包，适合回应情绪、接梗、撒娇。" +
              "mood 填一个情绪词，常用：开心、大笑、得意、无语、流汗、生气、委屈、哭、害怕、惊讶、" +
              "疑惑、点赞、加油、拒绝、睡觉、吃饭、工作、摸鱼、打招呼、卖萌、害羞、坏笑、冷漠、" +
              "敷衍、震惊、鼓励、安慰、嘲讽、疲惫。挑不到对应标签会随机发一张。",
            parameters: { mood: { type: "string", description: "情绪关键词" } },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const sid = exec?.agent?.session?.id;
              const entry = sid ? sessions.bySessionId(String(sid)) : null;
              const target = entry?.lastTarget ?? lastInbound;
              if (!target || (!target.group_id && !target.user_id)) {
                return { ok: false, reason: "当前没有 QQ 会话上下文" };
              }
              const picked = pickSticker(cfg.stickerDir, String(args?.mood ?? ""));
              if (!picked) return { ok: false, reason: "表情包目录为空" };
              await client.sendImage(target, picked.path);
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
      } catch (err) {
        logger.warn?.(`[onebot] 表情包工具注册失败：${err?.message ?? err}`);
      }
    })();
  }

  // 待确认的入群邀请：flag -> { groupId, inviter, subType, at }
  const pendingInvites = new Map();

  /** 处理群邀请/加群请求：主人的邀请直接同意，别人的先问主人 */
  // 待处理的好友请求：flag -> { userId, comment, at }
  const pendingFriends = new Map();

  async function handleGroupRequest(ev) {
    try {
      // 加好友请求：转告主人
      if (ev.request_type === "friend") {
        const userId = String(ev.user_id ?? "");
        const comment = String(ev.comment ?? "").trim().slice(0, 100);
        const flag = String(ev.flag ?? "");
        if (!flag) return;
        pendingFriends.set(flag, { userId, comment, at: Date.now() });
        if (pendingFriends.size > 20) {
          const oldest = [...pendingFriends.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) pendingFriends.delete(oldest[0]);
        }
        const msg =
          `有人要加我好友：${userId}` +
          (comment ? `\n验证消息：${comment}` : "") +
          `\n要加吗？回复「同意好友」或「拒绝好友」。`;
        if (cfg.ownerId) {
          await client.sendPrivate(cfg.ownerId, msg);
          logger.info?.(`[onebot] 好友请求已转告主人：${userId}`);
          audit({ kind: "friend_request", userId });
        }
        return;
      }

      if (ev.request_type !== "group") return;
      const subType = ev.sub_type === "add" ? "add" : "invite";
      const inviter = String(ev.user_id ?? "");
      const groupId = String(ev.group_id ?? "");
      const flag = String(ev.flag ?? "");
      if (!flag) return;

      const isOwner = cfg.ownerId && inviter === String(cfg.ownerId);
      if (isOwner) {
        await client.call("set_group_add_request", { flag, sub_type: subType, approve: true });
        logger.info?.(`[onebot] 主人的邀请，直接同意：群 ${groupId}`);
        return;
      }

      pendingInvites.set(flag, { groupId, inviter, subType, at: Date.now() });
      const kind = subType === "invite" ? "邀请我进群" : "提交了加群申请";
      const msg =
        `有人${kind}：群 ${groupId}，发起人 ${inviter}。` +
        `\n要进吗？回复「同意」或「拒绝」（这是最近一条邀请）。`;
      if (cfg.ownerId) {
        await client.sendPrivate(cfg.ownerId, msg);
        logger.info?.(`[onebot] 入群邀请已转问主人：群 ${groupId} 来自 ${inviter}`);
      } else {
        logger.warn?.("[onebot] 收到入群邀请但未配置 ownerId，无法确认");
      }
    } catch (err) {
      logger.warn?.(`[onebot] 处理入群邀请失败：${err?.message ?? err}`);
    }
  }

  /** 解析时长：「半小时」「30 分钟」「2 小时」 */
  function parseDuration(text, fallbackMs) {
    const t = String(text || "");
    const h = t.match(/(\d+|半|一|两|二|三)\s*(小时|时)/);
    const m = t.match(/(\d+)\s*(分钟|分)/);
    const cn = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3 };
    if (h) return (Number(h[1]) || cn[h[1]] || 1) * 3600000;
    if (m) return Number(m[1]) * 60000;
    return fallbackMs;
  }

  /** 今日/运行时状态摘要 */
  function statusText() {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const st = summarizeDay(ymd) ?? {};
    const mins = Math.floor(process.uptime() / 60);
    const muted = cfg.mutedUntil && Date.now() < cfg.mutedUntil;
    const lines = [
      `在线：${client.connected ? "是" : "否"}`,
      `会话：${sessions.entries.size} 个`,
      `今天：收到 ${st.inbound ?? 0} 条，回了 ${st.replies ?? 0} 条`,
      `用量：约 ${(((st.totalTokens ?? 0) / 10000) || 0).toFixed(1)} 万 tokens`,
      `限流：${st.limited ?? 0} 次；主动开口 ${st.proactive ?? 0} 次`,
      `已运行：${mins} 分钟`,
      muted ? `静音中（到 ${new Date(cfg.mutedUntil).toLocaleTimeString("zh-CN")}）` : "未静音",
    ];
    return lines.join("\n");
  }

  /** 当前时间 + 作息状态（23-1 点还精神，1-6 点最沉默） */
  function timeContext() {
    const now = new Date();
    const h = now.getHours();
    const mi = String(now.getMinutes()).padStart(2, "0");
    const wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    const weekend = now.getDay() === 0 || now.getDay() === 6;

    let mood;
    if (h >= 1 && h < 6) {
      mood = "凌晨了，你基本睡了，被叫到只敷衍一句，别展开聊。";
    } else if (h >= 23) {
      mood = "夜深了，但你还挺精神（你是夜猫子），正常聊就行，只是别太亢奋。";
    } else if (h < 9) {
      mood = "早上刚醒，精神一般，话不多。";
    } else if (h < 12) {
      mood = "上午，精神不错。";
    } else if (h < 14) {
      mood = "中午，有点困。";
    } else if (h < 18) {
      mood = "下午，正常状态。";
    } else {
      mood = "晚上，比较放松。";
    }
    return `[现在是 周${wd} ${String(h).padStart(2, "0")}:${mi}${weekend ? "（周末）" : ""}] ${mood}`;
  }

  /** 读 mood 插件的心情，作为语气底色 */
  function moodContext() {
    if (cfg.moodContext === false) return "";
    try {
      const st = JSON.parse(readFileSync(join(HOME, ".dsh/feiyu-mood/state.json"), "utf8"));
      const m = Number(st.mood ?? 70);
      const label = m >= 85 ? "很开心" : m >= 65 ? "不错" : m >= 45 ? "一般" : m >= 25 ? "有点低落" : "很低落";
      return `你现在心情${label}（${m}/100），语气带上这个底色，别太跳。`;
    } catch {
      return "";
    }
  }

  /** 会话事件文本提取 */
  function textOfEvent(ev) {
    try {
      if (ev.type === "user/message") {
        const blocks = ev.data?.content ?? [];
        return blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
      }
      if (ev.type === "assistant/message") {
        const blocks = ev.data?.message?.content ?? [];
        return blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
      }
    } catch {
      // 忽略
    }
    return "";
  }

  /** 在归档里搜关键词；返回最近若干条 */
  async function recallSearch(currentSid, query, opts = {}) {
    const persistence = ctx.get?.("sessionPersistence");
    if (!persistence?.inspect) return { ok: false, reason: "没有持久化服务" };
    const keys = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((x) => x.length >= 2)
      .slice(0, 4);
    if (!keys.length) return { ok: false, reason: "关键词太短" };

    let targets = [];
    try {
      if (opts.cross) {
        const headers = (await persistence.list?.()) ?? [];
        targets = headers.map((h) => String(h.id));
      } else if (currentSid) {
        targets = [String(currentSid)];
      }
    } catch {
      targets = currentSid ? [String(currentSid)] : [];
    }
    if (!targets.length) return { ok: false, reason: "没有可检索的会话" };

    const hits = [];
    for (const sid of targets) {
      try {
        const inspected = await persistence.inspect(sid);
        for (const ev of inspected?.events ?? []) {
          const text = textOfEvent(ev);
          if (!text) continue;
          const low = text.toLowerCase();
          if (!keys.every((k) => low.includes(k))) continue;
          hits.push({
            sid,
            text: text.slice(0, 160),
            at: Number(ev.time) || 0,
          });
        }
      } catch {
        // 单个会话失败跳过
      }
    }
    hits.sort((a, b) => b.at - a.at);
    return { ok: true, hits: hits.slice(0, Number(cfg.recallMaxHits) || 5) };
  }

  /** 把检索结果排成提示词片段 */
  function renderRecall(hits) {
    if (!hits?.length) return "";
    const lines = hits.map((h) => {
      const d = h.at ? new Date(h.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      return `· [${d}] ${h.text}`;
    });
    return `[你回忆起的事]\n${lines.join("\n")}\n\n`;
  }

  // 群名缓存（10 分钟刷新一次）
  let groupNames = new Map();
  let groupNamesAt = 0;
  async function ensureGroupNames() {
    if (groupNames.size && Date.now() - groupNamesAt < 10 * 60000) return;
    try {
      const list = await client.call("get_group_list", {}, 8000);
      const arr = Array.isArray(list) ? list : (list?.data ?? []);
      for (const g of arr) {
        const gid = String(g.group_id ?? "");
        if (gid) groupNames.set(gid, String(g.group_name ?? ""));
      }
      groupNamesAt = Date.now();
    } catch {
      // 拿不到就用群号
    }
  }
  const groupLabel = (gid) => {
    const nm = groupNames.get(String(gid));
    return nm ? `${nm}(${gid})` : String(gid);
  };

  // ── 定时提醒 ──────────────────────────────────────────────
  const REMINDER_PATH = join(HOME, ".dsh/onebot-bridge/reminders.json");
  let reminders = [];
  let remindersLoaded = false;

  function loadReminders() {
    if (remindersLoaded) return;
    remindersLoaded = true;
    try {
      reminders = JSON.parse(readFileSync(REMINDER_PATH, "utf8"));
      if (!Array.isArray(reminders)) reminders = [];
    } catch {
      reminders = [];
    }
  }
  function saveReminders() {
    try {
      writeFileSync(REMINDER_PATH, JSON.stringify(reminders, null, 2), "utf8");
    } catch {
      // 忽略
    }
  }

  /** 解析提醒时间：「明天9点」「今天15:30」「每天8点」「两小时后」 */
  function parseReminderTime(text) {
    const now = new Date();
    const hhmm = text.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/);
    const daily = /每天|每日/.test(text);

    // N 小时后 / N 分钟后
    const rel = text.match(/(\d+)\s*(小时|分钟|分)后/);
    if (rel) {
      const n = Number(rel[1]);
      const ms = rel[2].startsWith("小时") ? n * 3600000 : n * 60000;
      return { at: Date.now() + ms, repeat: "once" };
    }

    if (!hhmm) return null;
    let hour = Number(hhmm[1]);
    const minute = Number(hhmm[2] || 0);
    if (hour > 23) hour = hour % 24;
    if (/下午|晚上|傍晚/.test(text) && hour < 12) hour += 12;
    if (/中午/.test(text) && hour < 11) hour += 12;

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    const tomorrow = /明天/.test(text);
    if (tomorrow) {
      target.setDate(target.getDate() + 1);
    } else if (!daily && target <= now) {
      target.setDate(target.getDate() + 1);
    } else if (daily && target <= now) {
      // 今天已过，首次从明天开始
      target.setDate(target.getDate() + 1);
    }

    return { at: target.getTime(), repeat: daily ? "daily" : "once", hour, minute };
  }

  async function checkReminders() {
    loadReminders();
    if (!reminders.length) return;
    const now = Date.now();
    const due = reminders.filter((r) => r.at <= now);
    if (!due.length) return;

    for (const r of due) {
      try {
        if (r.target?.type === "group" && r.target.groupId) {
          await client.call(
            "send_group_msg",
            {
              group_id: Number(r.target.groupId),
              message: [{ type: "text", data: { text: `⏰ 提醒：${r.text}` } }],
            },
            10000,
          );
        } else {

          await client.sendPrivate(r.target?.userId ?? cfg.ownerId, `⏰ 提醒：${r.text}`);
        }
        logger.info?.(`[onebot] 提醒触发：${r.text}`);
        audit({ kind: "reminder", text: r.text });
      } catch (err) {
        logger.warn?.(`[onebot] 提醒发送失败：${err?.message ?? err}`);
      }

      if (r.repeat === "daily") {
        const next = new Date(r.at);
        next.setDate(next.getDate() + 1);
        r.at = next.getTime();
      } else {
        const idx = reminders.indexOf(r);
        if (idx >= 0) reminders.splice(idx, 1);
      }
    }
    saveReminders();
  }

  // ── 回复长度档位：按概率抽一个，避免每句都差不多长 ──
  function pickLengthHint(userText) {
    const t = String(userText || "");
    // 对方明确要详细内容时，不受随机控制
    if (/(详细|展开|解释一下|解释下|怎么做|怎么弄|教程|步骤|原理|分析一下|说说看)/.test(t)) {
      return "（对方要详细内容，可以写到 200-300 字，用短句分段，但不要写成文档。）";
    }
    // 对方只是打个招呼/寒暄，倾向短
    if (/^(在吗|在不在|你好|早上好|晚上好|晚安|早|嗨|hi|hello)[!！?？~～。]*$/i.test(t.trim())) {
      return "（对方只是打个招呼，回一两个字到一句话就行。）";
    }
    // 问句不给「极短」，否则容易答非所问
    const isQuestion = /[?？]|吗|呢|什么|怎么|为什么|哪|多少|是不是|能不能/.test(t);
    const r = Math.random();
    if (isQuestion) {
      if (r < 0.5) return "（这轮短：10-25 个字，直接回答问题。）";
      if (r < 0.85) return "（这轮中等：30-60 个字。）";
      return "（这轮可以长一点：80-150 字，分 2-3 条发也行。）";
    }
    if (r < 0.4) return "（这轮极短：1-8 个字，像随口应一声。）";
    if (r < 0.7) return "（这轮短：10-25 个字。）";
    if (r < 0.9) return "（这轮中等：30-60 个字。）";
    return "（这轮可以长一点：80-150 字，分 2-3 条发也行。）";
  }

  /** 今日统计报表 */
  async function statsText() {
    await ensureGroupNames();
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const byKind = {};
    const byGroup = new Map();
    try {
      const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        if (!line.includes(ymd)) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        const g = String(r.key ?? "");
        if (g.startsWith("group:")) {
          const gid = g.slice(6);
          byGroup.set(gid, (byGroup.get(gid) ?? 0) + 1);
        }
      }
    } catch {
      // 读不到就算了
    }

    let drops = 0;
    let downMinutes = 0;
    let lastDrop = "";
    try {
      const lines = readFileSync(join(HOME, ".dsh/onebot-bridge/alert.log"), "utf8")
        .split("\n")
        .filter((l) => l.includes(ymd));
      for (const l of lines) {
        if (l.includes("检测到 3001 不通")) drops += 1;
        const m = l.match(/已恢复（掉线 (\d+) 分钟）/);
        if (m) downMinutes += Number(m[1]);
        if (l.includes("检测到")) lastDrop = l.slice(11, 16);
      }
    } catch {
      // 忽略
    }

    const st = summarizeDay(ymd) ?? {};
    const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const top = (k) => byKind[k] ?? 0;

    return [
      `今日统计（截至 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}）`,
      `消息：收 ${st.inbound ?? 0} / 回 ${st.replies ?? 0}｜token 约 ${((st.totalTokens ?? 0) / 10000).toFixed(1)} 万`,
      `主动：分享 ${top("proactive")} / 简讯 ${top("daily_brief")} / 说说 ${top("qzone") + top("qzone_manual")} / 冷群 ${top("quiet_topic")} / 热群 ${top("active_join")}`,
      `工具：表情包 ${top("sticker")} / 新闻 ${top("news")} / @人 ${top("at_person")} / 补回复 ${top("catchup") + top("poll_mention")}`,
      `异常：错误 ${top("error")}｜掉线 ${drops} 次${drops ? `（累计 ${downMinutes} 分钟${lastDrop ? "，最近 " + lastDrop : ""}）` : ""}`,
      groups.length ? `各群：\n${groups.map(([g, n]) => `· ${groupLabel(g)}：${n} 条`).join("\n")}` : "",
      `限流：${st.limited ?? 0} 次`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** 完整功能与指令清单（给主人看的） */
  function helpText() {
    return [
      "【聊天】",
      "· 私聊直接说话；群里 @ 我 或 我叫名字",
      "· 群里跟我聊过一次后，1 分钟内不用 @ 也能接着聊（最多 5 轮）",
      "· 发图我能看懂；发链接我会扫一眼正文（前 600 字）",
      "· 情绪到了会只发表情包，平时也会用 emoji",
      "",
      "【记忆】",
      "· 记得每个人的脾气（跨群共享）",
      "· 记得你说过的事实（跨会话）",
      "· 知道别的群最近在聊什么（只共享话题，不共享原文）",
      "· 每个群有独立的聊天历史",
      "",
      "【我自己会做的】",
      "· 热点分享：每 1-2 小时看心情说一句",
      "· 每日简讯：每天 9 点，带昨天的聊天统计",
      "· 说说：每天 0-3 条，9-23 点之间",
      "· 热群插话：群很热闹但很久没叫我，可能插一句",
      "· 冷群找话题：6 小时没人说话，我抛个话题（只抛一次）",
      "",
      "【你可以直接对我说】",
      "· 状态 → 在线情况、今日消息数、token 用量",
      "· 闭嘴 / 安静半小时 → 临时静音；说「恢复说话」解除",
      "· 停下 → 打断我正在跑的回合",
      "· 用 low / 切到 high → 换思考档位",
      "· 在 123456789 群说一句 xxx → 我代你发一句（不带 @）",
      "· 去 123456789 @ 100000001 → 我去群里找这个人搭话",
      "· 记住，我在上海 → 写进长期事实",
      "· 退群 123456789 → 退出某个群（记忆保留）",
      "· 同意 / 拒绝 → 回复别人的入群邀请",
      "",
      "【群里的规矩】",
      "· 只认 @ 和续聊，不刷屏；每分钟最多 6 条、每人每小时 30 条",
      "· 别人让我执行服务器命令一律拒绝，只有你能放行",
    ].join("\n");
  }

  /** 主人的自然语言控制：状态/打断/思考档位/群内发言/静音 */
  /** 戳一戳：只有当刚才在跟自己说话时才回应 */
  async function handlePoke(ev) {
    const target = String(ev.target_id ?? ev.target ?? "");
    if (target && target !== String(cfg.selfId)) return; // 戳的不是我
    const key = ev.group_id ? `group:${ev.group_id}` : `private:${ev.user_id}`;
    const nick = ev.sender?.nickname || ev.user_id;

    // 拉最近几条，看有没有在跟自己说话
    let talkingToMe = false;
    let hints = [];
    try {
      if (ev.group_id) {
        const hist = await client.call(
          "get_group_msg_history",
          { group_id: ev.group_id, count: 3 },
          6000,
        );
        const list = (hist?.messages ?? []).slice(-3);
        for (const m of list) {
          const segs = Array.isArray(m?.message) ? m.message : [];
          const hasAt = segs.some(
            (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
          );
          const txt = segs
            .filter((x) => x?.type === "text")
            .map((x) => x?.data?.text ?? "")
            .join("");
          const byName = /(肥鱼|大鱼|竹筒|鱼鱼)/.test(txt);
          if (hasAt || byName) talkingToMe = true;
          if (txt.trim()) hints.push(`${m?.sender?.nickname ?? "某人"}：${txt.slice(0, 60)}`);
        }
      }
    } catch {
      // 拉不到历史就当作不是在叫我
      return;
    }

    if (!talkingToMe) {
      logger.info?.(`[onebot] 被 ${nick} 戳了一下，但前面没在跟我说话，不回`);
      audit({ kind: "poke_ignored", key, from: String(ev.user_id ?? "") });
      return;
    }

    logger.info?.(`[onebot] 被 ${nick} 戳了，前面确实在跟我说话，回一句`);
    audit({ kind: "poke_reply", key, from: String(ev.user_id ?? "") });
    const ent = sessions.entries.get(key);
    if (ent) ent.lastTarget = { ...ev, message_type: ev.group_id ? "group" : "private", group_id: ev.group_id, user_id: ev.user_id };
    void sessions
      .runProactive(
        key,
        "（对方戳了你一下" +
          (hints.length ? `，刚才在聊：「${hints.join(" / ")}」` : "") +
          "。像是催你或者逗你。用一句话回应，语气自然，可以带点无奈或俏皮，别问「怎么了」，别长篇大论。）",
      )
      .catch(() => {});
  }

  async function handleOwnerNatural(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    const t = String(text || "").trim();

    // ── 解除静音（优先于其他判断） ──
    if (/(解除静音|恢复说话|可以说话了|别静音|不用安静了)/.test(t)) {
      cfg.mutedUntil = 0;
      await client.sendPrivate(cfg.ownerId, "好，我回来了。");
      logger.info?.("[onebot] 解除静音");
      return true;
    }

    // ── 主动行为总开关 ──
    if (/(别主动|不要主动|停止主动|安静点|消停点)/.test(t)) {
      cfg.autoActionsEnabled = false;
      cfg.proactiveEnabled = false;
      cfg.quietTopicEnabled = false;
      cfg.activeJoinEnabled = false;
      cfg.qzoneEnabled = false;
      persistConfig();
      await client.sendPrivate(cfg.ownerId, "好，我不再自己找话题了。想恢复就说「可以主动了」。");
      logger.info?.("[onebot] 主动行为已关闭");
      audit({ kind: "auto_actions", enabled: false });
      return true;
    }
    if (/(可以主动了|恢复主动|主动起来)/.test(t)) {
      cfg.autoActionsEnabled = true;
      cfg.proactiveEnabled = true;
      cfg.quietTopicEnabled = true;
      cfg.activeJoinEnabled = true;
      cfg.qzoneEnabled = true;
      persistConfig();
      await client.sendPrivate(cfg.ownerId, "好，恢复主动了。");
      audit({ kind: "auto_actions", enabled: true });
      return true;
    }

    // ── 设置称呼 ──
    const addr = t.match(/^(?:以后|平时)?(?:就)?叫(?:我|他|她)?[:：]?\s*(.{1,12})$/);
    if (addr && !/叫醒/.test(t)) {
      const val = people.setAddress(ev.user_id, addr[1]);
      await client.sendPrivate(cfg.ownerId, val ? `好，以后叫你「${val}」。` : "没听清，再说一次？");
      return true;
    }

    // ── 申请加群 ──
    const joinReq = t.match(/申请加群\s*(\d{6,12})/);
    if (joinReq) {
      const gid = Number(joinReq[1]);
      try {
        const list = await client.call("get_group_list", {}, 8000);
        const groups = Array.isArray(list) ? list : (list?.data ?? []);
        const hit = groups.find((g) => Number(g.group_id) === gid);
        if (hit) {
          await client.sendPrivate(
            cfg.ownerId,
            `我已经在「${hit.group_name || gid}」（${gid}）里了，不用再加。`,
          );
        } else {
          await client.sendPrivate(
            cfg.ownerId,
            `群 ${gid} 我加不了——NapCat 没提供"主动申请加群"的接口，只能接受邀请。\n\n` +
              `要让我进去，两个办法：\n` +
              `1. 你在群里邀请我，我会私聊问你，你回「同意」就行\n` +
              `2. 或者把我拉进去（群成员直接拉，无需我确认）`,
          );
        }
      } catch (err) {
        await client.sendPrivate(
          cfg.ownerId,
          `查群列表失败：${String(err?.message ?? err).slice(0, 120)}`,
        );
      }
      return true;
    }

    // ── 发说说（手动） ──
    const qz = t.match(/^(?:现在|马上)?(?:发|写)(?:一)?条?说说(?::|：)?\s*([\s\S]*)$/);
    if (qz) {
      let content = String(qz[1] || "").trim();
      try {
        if (!content) {
          // 没指定内容：让她自己写一条
          const picked = pickTarget();
          if (picked) {
            const news = await fetchHotNews(cfg, logger);
            const topic = news.length ? news[Math.floor(Math.random() * news.length)] : "";
            content = await sessions.generate(
              picked[0],
              "（内部：写一条要发到 QQ 空间的说说，一句话、40 字以内，符合你的人设和当前心情。" +
                (topic ? `可以借今天看到的「${topic}」发挥。` : "写点日常感受也行。") +
                "只输出正文，不要引号、不要话题标签。）",
            );
          }
        }
        content = String(content || "").trim().replace(/^["'「」]+|["'「」]+$/g, "");
        if (!content) {
          await client.sendPrivate(cfg.ownerId, "没写出内容，给我一句话我再发。");
          return true;
        }
        const res = await client.call("send_qzone_msg", {
          content,
          ugc_right: Number(cfg.qzoneVisibility ?? 1),
        });
        await client.sendPrivate(
          cfg.ownerId,
          `已经发到空间了：${content}\n（可见范围：${cfg.qzoneVisibility ?? 1}，返回 ${JSON.stringify(res ?? {}).slice(0, 80)}）`,
        );
        logger.info?.(`[onebot] 手动发说说：${content.slice(0, 40)}`);
        audit({ kind: "qzone_manual", text: content.slice(0, 200) });
      } catch (err) {
        logger.warn?.(`[onebot] 发说说失败：${err?.message ?? err}`);
        await client.sendPrivate(cfg.ownerId, `发说说失败：${String(err?.message ?? err).slice(0, 150)}`);
      }
      return true;
    }

    // ── 插件状态 ──
    if (/(插件|配套|记忆装|设置好没|配置好没)/.test(t) && /(状态|情况|好没好|怎么样|看看)/.test(t)) {
      const base = join(HOME, ".dsh");
      const read = (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      };
      const fm = read(join(base, "fish-memory-config.json"));
      const su = read(join(base, "speak-up-config.json"));
      const md = read(join(base, "feiyu-mood/config.json"));
      const fmOn = fm?.sessions ? Object.values(fm.sessions).filter(Boolean).length : 0;
      const suList = Array.isArray(su?.["目标会话"]) ? su["目标会话"].length : 0;
      const lines = [
        "配套插件状态：",
        `· 鱼的记忆：${fm ? `${fmOn} 个会话已开启` : "未安装"}`,
        `· 主动搭话：${su ? `${suList} 个目标会话，间隔 ${su["间隔分钟"] ?? "?"} 分钟` : "未安装"}`,
        `· 心情：${md?.targetSession ? "已绑定会话" : "未安装或未设置"}`,
        "",
        `自动配置：${cfg.autoConfigurePlugins === false ? "已关闭" : "开启（新会话自动接入）"}`,
      ];
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    }

    // ── 记忆查询 ──
    if (/(你记得我什么|记得我什么|你都记得|记住了什么|我的档案)/.test(t)) {
      people.load();
      const rec = people.data[String(ev.user_id)] ?? {};
      const factsLine = facts.render(20);
      const notes = Array.isArray(rec.notes) ? rec.notes.slice(-8) : [];
      const lines = [
        factsLine ? `关于你的事实：${factsLine}` : "关于你的事实：还没记下什么。",
        notes.length ? `对你的印象：${notes.join("；")}` : "",
        rec.address ? `我平时叫你：${rec.address}` : "",
        rec.groups?.length ? `我们在 ${rec.groups.length} 个群里聊过。` : "",
      ].filter(Boolean);
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    }

    // ── 改配置（限流/续聊/主动频率/回复长度） ──
    let cfgChanged = false;
    const rateMin = t.match(/每分钟\s*(\d+)\s*条/);
    if (rateMin) {
      cfg.ratePerMinute = Number(rateMin[1]);
      cfgChanged = true;
    }
    const rateHour = t.match(/每小时\s*(\d+)\s*条/);
    if (rateHour) {
      cfg.ratePerUserHour = Number(rateHour[1]);
      cfgChanged = true;
    }
    const fuSec = t.match(/续聊.{0,4}?(\d+)\s*(秒|分钟)/);
    if (fuSec) {
      cfg.followUpSeconds = fuSec[2] === "分钟" ? Number(fuSec[1]) * 60 : Number(fuSec[1]);
      cfgChanged = true;
    }
    const fuTurn = t.match(/续聊.{0,4}?(\d+)\s*轮/);
    if (fuTurn) {
      cfg.followUpMaxTurns = Number(fuTurn[1]);
      cfgChanged = true;
    }
    const replyLen = t.match(/(?:回复|字数).{0,4}?(\d+)\s*字/);
    if (replyLen) {
      cfg.maxReplyChars = Number(replyLen[1]);
      cfgChanged = true;
    }
    if (cfgChanged) {
      persistConfig();
      await client.sendPrivate(
        cfg.ownerId,
        `改好了：\n· 每会话每分钟 ${cfg.ratePerMinute ?? "-"} 条\n` +
          `· 每人每小时 ${cfg.ratePerUserHour ?? "-"} 条\n` +
          `· 续聊窗口 ${cfg.followUpSeconds ?? "-"} 秒 / ${cfg.followUpMaxTurns ?? "-"} 轮\n` +
          `· 回复上限 ${cfg.maxReplyChars ?? "-"} 字`,
      );
      logger.info?.("[onebot] 主人改了配置");
      audit({ kind: "config_change", rate: cfg.ratePerMinute, fu: cfg.followUpSeconds });
      return true;
    }

    // ── 功能/指令清单 ──
    if (/(帮助|功能|你会什么|能干什么|指令|怎么用|能做什么|都有啥)/.test(t) && t.length <= 18) {
      await client.sendPrivate(cfg.ownerId, helpText());
      return true;
    }

    // ── 掉线记录 ──
    if (/(掉线记录|掉线历史|断线记录|掉过几次)/.test(t) && t.length <= 18) {
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let lines = [];
      try {
        lines = readFileSync(join(HOME, ".dsh/onebot-bridge/alert.log"), "utf8")
          .split("\n")
          .filter((l) => l.includes(ymd) && /检测到|已恢复|自动恢复成功|需要扫码|额度已用完/.test(l));
      } catch {
        // 忽略
      }
      await client.sendPrivate(
        cfg.ownerId,
        lines.length ? `今日掉线记录：\n${lines.slice(-15).join("\n")}` : "今天没掉过线。",
      );
      return true;
    }

    // ── 各群活跃 ──
    if (/(各群|群活跃|群消息量|哪个群最热)/.test(t) && t.length <= 18) {
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const inMap = new Map();
      const outMap = new Map();
      try {
        const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          if (!line.includes(ymd)) continue;
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          const k = String(r.key ?? "");
          if (!k.startsWith("group:")) continue;
          const gid = k.slice(6);
          if (r.kind === "inbound") inMap.set(gid, (inMap.get(gid) ?? 0) + 1);
          if (r.kind === "reply") outMap.set(gid, (outMap.get(gid) ?? 0) + 1);
        }
      } catch {
        // 忽略
      }
      const all = [...new Set([...inMap.keys(), ...outMap.keys()])]
        .map((g) => ({ g, i: inMap.get(g) ?? 0, o: outMap.get(g) ?? 0 }))
        .sort((a, b) => b.i - a.i);
      await ensureGroupNames();
      const lines = all.slice(0, 10).map((x) => `· ${groupLabel(x.g)}：收 ${x.i} / 回 ${x.o}`);
      await client.sendPrivate(
        cfg.ownerId,
        all.length ? `各群活跃（今日）：\n${lines.join("\n")}` : "今天还没在群里说过话。",
      );
      return true;
    }

    // ── 最近错误 ──
    if (/(最近错误|错误记录|报错|出错了没)/.test(t) && t.length <= 16) {
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const errs = [];
      try {
        const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          if (!line.includes(ymd) || !line.includes('"error"')) continue;
          try {
            const r = JSON.parse(line);
            if (r.kind === "error" || r.kind === "catchup_fail") {
              errs.push(`${String(r.ts ?? "").slice(11, 19)} ${r.key ?? ""}：${String(r.error ?? r.text ?? "").slice(0, 60)}`);
            }
          } catch {
            // 忽略
          }
        }
      } catch {
        // 忽略
      }
      await client.sendPrivate(
        cfg.ownerId,
        errs.length ? `最近错误（今日 ${errs.length} 条）：\n${errs.slice(-10).join("\n")}` : "今天没有报错。",
      );
      return true;
    }

    // ── 好友请求确认 ──
    if (/^(同意好友|加他|通过好友|接受好友)/.test(t)) {
      const last = [...pendingFriends.entries()].sort((a, b) => b[1].at - a[1].at)[0];
      if (!last) {
        await client.sendPrivate(cfg.ownerId, "现在没有待处理的好友请求。");
        return true;
      }
      const [flag, info] = last;
      try {
        await client.call("set_friend_add_request", { flag, approve: true }, 10000);
        pendingFriends.delete(flag);
        await client.sendPrivate(cfg.ownerId, `已同意 ${info.userId} 的好友请求。`);
        logger.info?.(`[onebot] 已同意好友：${info.userId}`);
        audit({ kind: "friend_approve", userId: info.userId });
      } catch (err) {
        await client.sendPrivate(cfg.ownerId, `同意失败：${String(err?.message ?? err).slice(0, 120)}`);
      }
      return true;
    }
    if (/^(拒绝好友|不加他|拒绝加好友)/.test(t)) {
      const last = [...pendingFriends.entries()].sort((a, b) => b[1].at - a[1].at)[0];
      if (!last) {
        await client.sendPrivate(cfg.ownerId, "现在没有待处理的好友请求。");
        return true;
      }
      const [flag, info] = last;
      try {
        await client.call("set_friend_add_request", { flag, approve: false }, 10000);
        pendingFriends.delete(flag);
        await client.sendPrivate(cfg.ownerId, `已拒绝 ${info.userId} 的好友请求。`);
        audit({ kind: "friend_reject", userId: info.userId });
      } catch (err) {
        await client.sendPrivate(cfg.ownerId, `拒绝失败：${String(err?.message ?? err).slice(0, 120)}`);
      }
      return true;
    }

    // ── 定时提醒 ──
    // 查看 / 取消
    if (/(查看|有什么|列出).{0,4}(提醒)|我的提醒/.test(t) && t.length <= 20) {
      loadReminders();
      if (!reminders.length) {
        await client.sendPrivate(cfg.ownerId, "现在没有待触发的提醒。");
      } else {
        const lines = reminders.map((r) => {
          const d = new Date(r.at);
          const ds = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          return `· ${ds}（${r.repeat === "daily" ? "每天" : "一次"}）${r.text}`;
        });
        await client.sendPrivate(cfg.ownerId, `待触发提醒：\n${lines.join("\n")}`);
      }
      return true;
    }
    const cancelM = t.match(/取消提醒\s*(.+)?$/);
    if (cancelM) {
      loadReminders();
      const kw = String(cancelM[1] ?? "").trim();
      const before = reminders.length;
      reminders = reminders.filter((r) => !kw || !String(r.text).includes(kw));
      saveReminders();
      await client.sendPrivate(
        cfg.ownerId,
        before === reminders.length ? "没找到匹配的提醒。" : `取消了 ${before - reminders.length} 条提醒。`,
      );
      return true;
    }

    // 新增提醒：「明天9点提醒我交周报」「每天8点提醒群里打卡」
    if (/提醒/.test(t) && t.length <= 60) {
      const timeInfo = parseReminderTime(t);
      if (timeInfo) {
        let body = t
          .replace(/提醒我|提醒一下|提醒|到点|记一下/g, " ")
          .replace(/\d{1,2}\s*[:：点时]\s*\d{0,2}\s*分?/g, " ")
          .replace(/今天|明天|后天|每天|每日|上午|下午|晚上|中午/g, " ")
          .replace(/\d+\s*(小时|分钟|分)后/g, " ")
          .trim();
        body = body.replace(/^[:：,，\s]+/, "").slice(0, 40);
        if (!body) {
          await client.sendPrivate(cfg.ownerId, "要提醒你什么？比如「明天9点提醒我交周报」。");
          return true;
        }
        loadReminders();
        const isGroup = /群里|群|大家/.test(t) && /[0-9]{6,12}/.test(t);
        const gidM = t.match(/(\d{6,12})/);
        reminders.push({
          id: `r${Date.now()}`,
          text: body,
          at: timeInfo.at,
          repeat: timeInfo.repeat,
          target: isGroup
            ? { type: "group", groupId: gidM ? gidM[1] : (cfg.prewarmGroups ?? [])[0] }
            : { type: "private", userId: cfg.ownerId },
          createdAt: Date.now(),
        });
        saveReminders();
        const d = new Date(timeInfo.at);
        await client.sendPrivate(
          cfg.ownerId,
          `好，${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${timeInfo.repeat === "daily" ? "每天" : ""}提醒你：${body}`,
        );
        return true;
      }
    }

    // ── 统计报表 ──
    if (/(统计|报表|数据汇总|看看数据|今天的记录)/.test(t) && t.length <= 18) {
      await client.sendPrivate(cfg.ownerId, await statsText());
      return true;
    }

    // ── 状态 ──
    if (/(状态|运行情况|今天多少|用量|多少条|还在线吗|还好吗|统计)/.test(t) && t.length <= 20) {
      await client.sendPrivate(cfg.ownerId, statusText());
      return true;
    }

    // ── 静音 ──
    if (/(闭嘴|静音|先别说话|别出声|安静\s*(?:半|一|两|三|\d+))/.test(t)) {
      const ms = parseDuration(t, 30 * 60000);
      cfg.mutedUntil = Date.now() + ms;
      await client.sendPrivate(cfg.ownerId, `好，我安静 ${Math.round(ms / 60000)} 分钟。想说「恢复说话」就叫我。`);
      logger.info?.(`[onebot] 静音 ${Math.round(ms / 60000)} 分钟`);
      audit({ kind: "mute", minutes: Math.round(ms / 60000) });
      return true;
    }

    // ── 打断 ──
    if (/(打断|停下|停下来|别说了|先停|stop|中断)/i.test(t) && t.length <= 12) {
      const running = [...sessions.entries.entries()].find(([, e]) => e.running);
      if (running) {
        const [rk, entry] = running;
        try {
          entry.handle?.agent?.cancel({ kind: "user" });
          await client.sendPrivate(cfg.ownerId, `已打断 ${rk} 的回合。`);
          logger.info?.(`[onebot] 主人打断 ${rk}`);
          audit({ kind: "stop", key: rk });
        } catch (err) {
          await client.sendPrivate(cfg.ownerId, `打断失败：${String(err?.message ?? err).slice(0, 100)}`);
        }
      } else {
        await client.sendPrivate(cfg.ownerId, "现在没有正在跑的回合。");
      }
      return true;
    }

    // ── 思考档位 ──
    let thinkLevel = null;
    const tm = t.match(/(?:用|切到|调到|设成)\s*(off|low|high|max)/i);
    if (tm) thinkLevel = tm[1].toLowerCase();
    else if (/(想快点|快一点|别想太多)/.test(t)) thinkLevel = "low";
    else if (/(想深一点|认真想|深入点)/.test(t)) thinkLevel = "high";
    if (thinkLevel) {
      const level = thinkLevel;
      cfg.reasoningEffortOverride = level;
      // 重建常驻 agent，下轮用新档位
      for (const [, e] of sessions.entries) {
        try {
          await e.handle?.dispose?.();
        } catch {
          // 忽略
        }
        e.handle = null;
      }
      await client.sendPrivate(cfg.ownerId, `思考档位已切到 ${level}（下一条消息生效）。`);
      logger.info?.(`[onebot] 思考档位 -> ${level}`);
      audit({ kind: "think", level });
      return true;
    }

    // ── 群内说一句（不带 @） ──
    const sayMatch = t.match(/^(?:去|在)?\s*(\d{6,12})?\s*群?(?:里|中)?\s*说(?:一)?句[:：]?\s*(.+)$/s);
    if (sayMatch) {
      const gid = sayMatch[1] || (cfg.prewarmGroups ?? [])[0];
      const content = String(sayMatch[2] || "").trim();
      if (!gid || !content) {
        await client.sendPrivate(cfg.ownerId, "要发到哪个群、说什么？格式：在 123456789 群说一句 xxx");
        return true;
      }
      try {
        await client.call("send_group_msg", {
          group_id: Number(gid),
          message: [{ type: "text", data: { text: content } }],
        });
        await client.sendPrivate(cfg.ownerId, `已发到群 ${gid}：${content.slice(0, 60)}`);
        logger.info?.(`[onebot] 主人在群 ${gid} 代发言：${content.slice(0, 40)}`);
        audit({ kind: "say", groupId: String(gid), text: content.slice(0, 200) });
      } catch (err) {
        await client.sendPrivate(cfg.ownerId, `发送失败：${String(err?.message ?? err).slice(0, 120)}`);
      }
      return true;
    }

    return false;
  }

  /** 主人的「定向搭话」：去某群 @ 某人说一句 */
  async function handleOwnerRelay(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    const t = String(text || "").trim();
    // 识别「在群 X 和 Y 说句话」「去 X 群找 Y 聊两句」这类说法
    const looksLikeRelay = /(群|群聊)/.test(t) && /(说|聊|讲|问|找|@|艾特|和|跟)/.test(t);
    if (!looksLikeRelay) return false;

    let groupId = "";
    let targetQq = "";
    const g1 = t.match(/(?:群|群聊)\s*(\d{6,12})/);
    const g2 = t.match(/(\d{6,12})\s*(?:群|群聊)/);
    const g3 = t.match(/(?:在|去|到|进)\s*(\d{6,12})/);
    const gm = g1 ?? g2 ?? g3;
    if (gm) groupId = gm[1];

    const q1 = t.match(/(?:@|找|艾特|和|跟|对|与)\s*(\d{5,12})/);
    const q2 = t.match(/(\d{5,12})\s*(?:说|聊|讲|问)/);
    const qm = q1 ?? q2;
    if (qm) targetQq = qm[1];

    // 兜底：抓到两个数字就用（先群后人的常见顺序）
    if (!groupId || !targetQq) {
      const nums = [...t.matchAll(/\d{6,12}/g)].map((m) => m[1]);
      const uniq = [...new Set(nums)];
      if (uniq.length >= 2) {
        groupId = groupId || uniq[0];
        targetQq = targetQq || uniq[1];
      }
    }
    if (!groupId || !targetQq) return false;

    let rest = t
      .replace(groupId, " ")
      .replace(targetQq, " ")
      .replace(/^(?:在|去|到|进|让|你|她|请|帮我)\s*/, "")
      .replace(/(?:群聊?|里|中|的|找|艾特|@|和|跟|对|与)/g, " ")
      .replace(/^[:：,，\s]+/, "")
      .trim();
    const sayMatch = rest.match(/^说[:：]?\s*(.+)$/);
    const explicit = sayMatch ? sayMatch[1].trim() : "";

    try {
      let content = explicit;
      if (!content) {
        // 不指定内容：让她按上下文自己开口
        content = await sessions.generate(
          `group:${groupId}`,
          `（内部指令：主人让你去群里找 QQ ${targetQq} 主动搭一句话。` +
            `结合你对这个人的印象和群里最近的话题，说一句自然、简短、有来由的话，` +
            `不要@符号、不要称呼对方 QQ 号、不要解释你在执行任务，50 字以内。）`,
        );
      }
      content = String(content || "").trim().replace(/^@\S+\s*/, "");
      if (!content) {
        await client.sendPrivate(cfg.ownerId, "没生成出内容，换个说法再试？");
        return true;
      }
      await client.sendGroupAt(groupId, targetQq, content);
      if (cfg.followUpEnabled) {
        openWindow(`group:${groupId}`, targetQq);
        logger.info?.(`[onebot] 定向搭话后开窗口 group:${groupId} -> ${targetQq}`);
      }
      logger.info?.(`[onebot] 定向搭话：群 ${groupId} @ ${targetQq}：${content.slice(0, 40)}`);
      audit({ kind: "relay", groupId, targetQq, text: content.slice(0, 200) });
      await client.sendPrivate(cfg.ownerId, `已让它在群 ${groupId} @ ${targetQq} 说：${content}`);
    } catch (err) {
      logger.warn?.(`[onebot] 定向搭话失败：${err?.message ?? err}`);
      await client.sendPrivate(cfg.ownerId, `搭话失败：${String(err?.message ?? err).slice(0, 150)}`);
    }
    return true;
  }

  /** 主人的「记住 X」：直接落库，不经过模型 */
  async function handleOwnerRemember(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    const m = String(text || "").match(/^(记住|记一下|记下)[，,：:\s]*(.+)$/);
    if (!m) return false;
    const saved = facts.add(m[2], "owner");
    if (saved) {
      await client.sendPrivate(cfg.ownerId, `记住了：${saved}\n（所有会话都能用到）`);
      logger.info?.(`[onebot] 主人写入全局事实：${saved}`);
    } else {
      await client.sendPrivate(cfg.ownerId, "这条没存：内容为空或含敏感信息（QQ号/密钥/路径/口令）。");
    }
    return true;
  }

  /** 主人的退群指令：识别群号或群名，执行后保留记忆与档案 */
  async function handleOwnerLeaveGroup(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    const t = String(text || "");
    if (!/(退群|退出群|离开群|退掉群|退出这个群|退掉这个群)/.test(t)) return false;

    let gid = 0;
    const num = t.match(/(\d{6,12})/);
    if (num) {
      gid = Number(num[1]);
    } else {
      // 没给群号：按群名模糊匹配
      try {
        const list = (await client.call("get_group_list", {})) || [];
        const hit = list.find((g) => g.group_name && t.includes(g.group_name));
        if (hit) gid = Number(hit.group_id);
      } catch (err) {
        logger.warn?.(`[onebot] 查群列表失败：${err?.message ?? err}`);
      }
    }
    if (!gid) {
      await client.sendPrivate(
        cfg.ownerId,
        "要退哪个群？给我群号，或者说群名（我这边看到完整的群名才能对上）。",
      );
      return true;
    }

    try {
      await client.call("set_group_leave", { group_id: gid });
      logger.info?.(`[onebot] 已退出群 ${gid}（记忆/档案保留）`);
      await client.sendPrivate(
        cfg.ownerId,
        `已退出群 ${gid}。\n记忆和人物档案都没删：那个群的会话记录、群友印象都还在，重新进群还能接着聊。`,
      );
    } catch (err) {
      logger.warn?.(`[onebot] 退群失败：${err?.message ?? err}`);
      await client.sendPrivate(cfg.ownerId, `退群失败：${String(err?.message ?? err).slice(0, 150)}`);
    }
    return true;
  }

  /** 主人对邀请的答复：返回 true 表示这条消息被消费掉了 */
  async function handleOwnerInviteReply(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    if (pendingInvites.size === 0) return false;

    const yes = /^(同意|可以|进吧|批准|进|ok|yes)/i.test(text.trim());
    const no = /^(拒绝|不行|别进|不进|不要|no)/i.test(text.trim());
    if (!yes && !no) return false;

    const [flag, info] = [...pendingInvites.entries()].sort((a, b) => b[1].at - a[1].at)[0];
    try {
      await client.call("set_group_add_request", {
        flag,
        sub_type: info.subType,
        approve: yes,
        ...(yes ? {} : { reason: "管理员拒绝" }),
      });
      pendingInvites.delete(flag);
      await client.sendPrivate(cfg.ownerId, yes ? `已同意进群 ${info.groupId}` : `已拒绝进群 ${info.groupId}`);
      logger.info?.(`[onebot] 主人${yes ? "同意" : "拒绝"}了群 ${info.groupId} 的邀请`);
    } catch (err) {
      logger.warn?.(`[onebot] 执行入群决定失败：${err?.message ?? err}`);
      await client.sendPrivate(cfg.ownerId, `操作失败：${String(err?.message ?? err).slice(0, 120)}`);
    }
    return true;
  }

  client.onEvent = async (ev) => {
    const trace = (m) => {
      if (ev.__fromPoll) logger.info?.(`[onebot] trace ${ev.message_id}: ${m}`);
    };
    if (ev.post_type === "message") {
      lastInbound = ev;
      health.lastEventAt = Date.now();
    }
    if (ev.post_type === "request") {
      await handleGroupRequest(ev);
      return;
    }
    // 戳一戳：先看前两条是不是在跟自己说话，是才回应
    if (ev.post_type === "notice") {
      const nt = String(ev.notice_type ?? "");
      const st = String(ev.sub_type ?? "");
      const isPoke = nt === "poke" || st === "poke" || /poke|戳/.test(nt + st);
      if (isPoke) {
        void handlePoke(ev).catch((err) => logger.debug?.(`[onebot] 处理戳一戳失败：${err?.message ?? err}`));
      }
      return;
    }
    if (ev.post_type !== "message") return trace("非 message 事件");
    if (String(ev.user_id) === String(cfg.selfId)) return trace("自己发的");
    if (!dedupe(ev.message_id)) return trace("被去重拦下");
    // agent 还没就绪时先暂存，避免卡在 sessions.ensure
    if (!agentReady) {
      pendingWhileBooting.push(ev);
      if (pendingWhileBooting.length > 30) pendingWhileBooting.shift();
      // 超过 5 分钟还放不出去，说明不是"启动慢"，直接丢弃避免误导
      if (Date.now() - health.restartedAt > 300000) {
        pendingWhileBooting.length = 0;
        agentReady = true;
      }
      logger.info?.(`[onebot] agent 未就绪，暂存 ${ev.message_id}（队列 ${pendingWhileBooting.length}）`);
      return trace("agent 未就绪，暂存");
    }

    const parsed = parseMessage(ev, cfg.selfId);
    trace(`parsed text=${JSON.stringify(parsed.text)} hasAt=${parsed.hasAt} imgs=${parsed.images.length} segs=${Array.isArray(ev.message) ? ev.message.length : "无message"}`);
    ev.__hasAt = parsed.hasAt;
    // 空文本也可能是「只 @ 不说话」，交给后面按 hasAt 判断
    if (!parsed.text && !parsed.hasAt) return;

    const nickname = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    people.touch(ev.user_id, nickname, ev.message_type === "group" ? ev.group_id : 0);

    const key = conversationKey(ev);

    // 十分严格的选择性沉默：只在深夜 + 群聊 + 极短且非问句时偶尔不回
    if (cfg.silentMode !== false && ev.message_type === "group") {
      try {
        const h = new Date().getHours();
        const isNight = h >= Number(cfg.nightStart ?? 1) && h < Number(cfg.nightEnd ?? 6);
        const txt = String(parsed.text || "").trim();
        const noQuestion = !/[?？吗呢吧]/.test(txt) && !/(帮|请|问|怎么|为什么|啥|什么)/.test(txt);
        const today = new Date().toDateString();
        if (cfg.__silentDay !== today) {
          cfg.__silentDay = today;
          cfg.__silentCount = 0;
        }
        if (
          isNight &&
          txt.length <= 8 &&
          noQuestion &&
          Number(cfg.__silentCount ?? 0) < 5
        ) {
          cfg.__silentCount = Number(cfg.__silentCount ?? 0) + 1;
          try {
            const ent = sessions.entries.get(key);
            if (ent) {
              ent.nightPending = ent.nightPending ?? [];
              ent.nightPending.push({ name: nickname, text: txt, at: Date.now() });
              if (ent.nightPending.length > 20) ent.nightPending.shift();
            }
          } catch {
            // 忽略
          }
          logger.info?.(`[onebot] 深夜+极短消息，这次不回（已存待回）：${conversationKey(ev)}「${txt}」`);
          audit({ kind: "silent_skip", key: conversationKey(ev), text: txt });
          return;
        }
      } catch {
        // 判断失败就正常回
      }
    }

    // 主人的自然语言控制：状态/静音/打断/档位/代发言
    if (await handleOwnerNatural(ev, parsed.text)) return;

    // 静音期间：除了主人指令，其他一律不响应
    if (cfg.mutedUntil && Date.now() < cfg.mutedUntil) {
      logger.debug?.(`[onebot] 静音中，忽略 ${conversationKey(ev)}`);
      return;
    }

    // 主人的管理指令：定向搭话 / 记住 / 退群
    if (await handleOwnerRelay(ev, parsed.text)) return;
    if (await handleOwnerRemember(ev, parsed.text)) return;
    if (await handleOwnerLeaveGroup(ev, parsed.text)) return;

    // 主人正在回答「要不要进群」：这条消息不送给模型
    if (await handleOwnerInviteReply(ev, parsed.text)) return;

    // 连续对话：她刚回过的这个人，窗口内不 @ 也接话
    const nowTs = Date.now();
    const hit = cfg.followUpEnabled ? hitWindow(key, ev.user_id) : null;
    const continuing = !!hit;
    if (hit) {
      logger.info?.(
        `[onebot] 续聊命中 ${key} 用户 ${ev.user_id}（第 ${hit.rec.turns + 1}/${hit.rec.max} 轮，剩余 ${Math.round((hit.rec.until - nowTs) / 1000)}s）`,
      );
    }

    // 群里没 @ 她、也不是在续聊：只旁观、记录，不回复
    if (ev.message_type === "group" && !parsed.hasAt && !continuing && cfg.groupObserve) {
      const segTypes = (Array.isArray(ev.message) ? ev.message : [])
        .map((x) =>
          x?.type === "at"
            ? "at:" + String(x?.data?.qq) + "/" + String(x?.data?.name ?? "")
            : String(x?.type),
        )
        .join(",");
      logger.info?.(
        `[onebot] 旁听 ${key} [${nickname}] ${parsed.text.slice(0, 40)}（at=${parsed.hasAt} 段=${segTypes}）`,
      );
      try {
        const entry = await sessions.ensure(key);
        entry.observations = entry.observations ?? [];
        entry.observations.push(nickname + "：" + parsed.text.slice(0, 120));
        // 话题窗口：最近 30 分钟的词
        try {
          entry.topicWindow = (entry.topicWindow ?? []).filter(
            (x) => Date.now() - x.t < 30 * 60000,
          );
          const words = String(parsed.text || "")
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ")
            .split(/\s+/)
            .flatMap((c) => {
              const out = [];
              for (let n = 2; n <= 4; n++) {
                for (let i = 0; i + n <= c.length; i++) out.push(c.slice(i, i + n));
              }
              return out;
            });
          if (words.length) entry.topicWindow.push({ t: Date.now(), w: words });
          if (entry.topicWindow.length > 60) entry.topicWindow.shift();
        } catch {
          // 忽略
        }
        try {
          people.recordTopics(ev.user_id, parsed.text);
          people.markDirty?.();
        } catch {
          // 忽略
        }
        if (entry.observations.length > (cfg.observeLimit || 30)) entry.observations.shift();
        // 词频：2-4 字片段，用来识别群里的黑话/梗
        try {
          const freq = entry.wordFreq ?? (entry.wordFreq = new Map());
          const pure = parsed.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ");
          for (const chunk of pure.split(/\s+/)) {
            const c = String(chunk);
            for (let n = 2; n <= 4; n++) {
              for (let i = 0; i + n <= c.length; i++) {
                const w = c.slice(i, i + n);
                freq.set(w, (freq.get(w) ?? 0) + 1);
              }
            }
          }
          if (freq.size > 4000) entry.wordFreq = new Map([...freq].slice(-2000));
        } catch {
          // 忽略
        }
      } catch (err) {
        logger.warn?.(`[onebot] 记录群观察失败：${err?.message ?? err}`);
      }
      return;
    }

    if (!allowed(ev, continuing)) {
      logger.info?.(`[onebot] 未通过白名单/未 @：${conversationKey(ev)}（at=${parsed.hasAt} continuing=${continuing}）`);
      return;
    }

    // 注意：不在这里 markSeen —— 只有回复真正发出去之后才标记，
    // 这样「跑完但没发出」的消息（比如进程被重启打断）下次还能补回复。

    // 群活跃度统计
    if (ev.message_type === "group") {
      try {
        const ent = await sessions.ensure(key);
        const nowTs = Date.now();
        ent.lastMessageAt = nowTs;
        ent.msgTimes = (ent.msgTimes ?? []).filter((t) => nowTs - t < 60000);
        ent.msgTimes.push(nowTs);
        if (parsed.hasAt) ent.lastMentionAt = nowTs;

        // 连发检测：同一个人连着说话、没人接
        const streak = ent.streak ?? (ent.streak = { userId: "", count: 0, lastAt: 0, joinedAt: 0 });
        if (String(streak.userId) === String(ev.user_id)) {
          streak.count += 1;
        } else {
          streak.userId = String(ev.user_id);
          streak.count = 1;
          streak.joinedAt = nowTs;
        }
        streak.lastAt = nowTs;
        markRuntimeDirty();

        // 一个人连发多条、等了一会儿还没人接 → 搭一句给个台阶
        if (cfg.soloStreakEnabled !== false && cfg.autoActionsEnabled !== false) {
          const minMsgs = Number(cfg.soloStreakMin) || 4;
          const waitMs = (Number(cfg.soloStreakWaitSeconds) || 600) * 1000;
          const coolMs = (Number(cfg.soloStreakCooldownMinutes) || 20) * 60000;
          const waited = nowTs - streak.lastAt;
          const coolOk = nowTs - (ent.lastSoloJoinAt ?? 0) > coolMs;
          if (
            streak.count >= minMsgs &&
            waited >= waitMs &&
            coolOk &&
            !parsed.hasAt &&
            !continuing
          ) {
            ent.lastSoloJoinAt = nowTs;
            logger.info?.(
              `[onebot] ${streak.count} 条连发没人接（等了 ${Math.round(waited / 60000)} 分钟），搭一句：${key}`,
            );
            audit({ kind: "solo_join", key, count: streak.count });
            void sessions
              .runProactive(
                key,
                "（群里有人连着发了好几条，一直没人理。你可以接一句自然的，" +
                  "像「我也在想这个」「你说的那个我见过」这种，给对方一个台阶；" +
                  "别显得刻意、别说「你继续说」、别 @ 他。如果确实接不上，就什么都不说（只输出一个句号）。）",
              )
              .catch(() => {});
          }
        }

        // 记录完之后再判断要不要"热群插一句"
        if (cfg.activeJoinEnabled && cfg.autoActionsEnabled !== false) {
          // 她最近一次参与（被 @ 或说过话）距今多久
          const lastActive = Math.max(ent.lastMentionAt ?? 0, ent.lastReplyAt ?? 0);
          const idleFromActive = nowTs - lastActive;
          const cooldownOk =
            nowTs - (ent.lastActiveJoinAt ?? 0) >
            (Number(cfg.activeJoinCooldownMinutes) || 30) * 60000;
          if (
            ent.msgTimes.length >= (Number(cfg.activeJoinPerMinute) || 6) &&
            idleFromActive > (Number(cfg.activeJoinIdleMinutes) || 10) * 60000 &&
            cooldownOk
          ) {
            ent.lastActiveJoinAt = nowTs;
            markRuntimeDirty();
            logger.info?.(
              `[onebot] 群很热闹（${ent.msgTimes.length} 条/分钟）且她已 ${Math.round(idleFromActive / 60000)} 分钟没参与，插一句：${key}`,
            );
            audit({ kind: "active_join", key, perMinute: ent.msgTimes.length });
            void sessions
              .runProactive(
                key,
                "（这个群现在聊得很热闹，但没人叫你。如果你想加入，就顺着最近的话题插一句自然的、短的、" +
                  "不抢戏的话；如果你觉得插不上或者话题不适合你，就什么都不说（只输出一个句号）。）",
              )
              .catch(() => {});
          }
        }
        // 有人说话了 → 冷群话题的「已开过口」标记解除
        ent.topicPending = false;
      } catch {
        // 统计失败不影响对话
      }
    }

    // 链接预览：私聊直接抓，群里只在 @ 时抓（省 token）
    let linkNote = "";
    if (cfg.linkPreview !== false && !!(ev.message_type !== "group" || parsed.hasAt)) {
      const lm = parsed.text.match(/https?:\/\/[^\s<>"']+/);
      if (lm) {
        const pv = await fetchLinkPreview(lm[0], Number(cfg.linkPreviewChars) || 600, logger);
        if (pv) {
          linkNote =
            `[链接预览·前${Number(cfg.linkPreviewChars) || 600}字，非全文]\n` +
            (pv.title ? `标题：${pv.title}\n` : "") +
            `${pv.text}\n\n`;
          logger.info?.(`[onebot] 链接预览：${(pv.title || lm[0]).slice(0, 40)}`);
          audit({ kind: "link_preview", url: lm[0], title: pv.title });
        }
      }
    }

    // 图片：只在真的要回复时才下载，最多 maxImagesPerMessage 张
    let imagePayloads = [];
    if (cfg.enableImages && parsed.images.length) {
      const picked = parsed.images.slice(0, cfg.maxImagesPerMessage || 2);
      for (const img of picked) {
        const got = await imagePayloadFrom(img.url);
        if (got) imagePayloads.push(got);
        else logger.warn?.(`[onebot] 图片取不到：${String(img.url).slice(0, 80)}`);
      }
      if (imagePayloads.length) {
        logger.info?.(`[onebot] 已取到 ${imagePayloads.length} 张图（${imagePayloads.map((x) => x.mediaType).join(",")}）`);
      }
    }
    if (!parsed.text && !imagePayloads.length && !parsed.forwards?.length && !parsed.files?.length && !parsed.hasAt) return;

    if (parsed.hasAt) {
      try {
        const ent0 = await sessions.ensure(key);
        ent0.lastMentionAt = Date.now();
      } catch {
        // 忽略
      }
    }
    logger.info?.(`[onebot] ← ${key} [${ev.sender?.nickname ?? ev.user_id}] ${parsed.text.slice(0, 60)}`);
    audit({
      kind: "inbound",
      key,
      userId: String(ev.user_id),
      name: nickname,
      text: parsed.text.slice(0, 200),
      images: imagePayloads.length,
    });

    const gate = allowRate(key, ev.user_id);
    if (!gate.ok) {
      audit({ kind: "rate_limited", key, userId: String(ev.user_id), why: gate.why });
      logger.info?.(`[onebot] 限流（${gate.why}）：${key} 来自 ${ev.user_id}`);
      if (ev.message_type !== "group" && gate.why === "hour") {
        void client
          .sendHuman(ev, "你说得有点多，让我歇会儿，过阵子再聊。")
          .catch(() => {});
      }
      return;
    }

    const who = people.describe(ev.user_id);
    // 只 @ 没说话：把前面几条聊天记录带上，别空着回
    let emptyAtNote = "";
    if (!String(parsed.text || "").trim() && parsed.hasAt) {
      emptyAtNote = "[对方只 @ 了你，没打字。]\n";
      if (ev.message_type === "group") {
        try {
          const hist = await client.call(
            "get_group_msg_history",
            { group_id: ev.group_id, count: 10 },
            6000,
          );
          const list = Array.isArray(hist?.messages) ? hist.messages : [];
          const lines = [];
          const imgUrls = [];
          let forwardId = "";
          for (const m of list) {
            const nm = m?.sender?.card || m?.sender?.nickname || "某人";
            const segs = Array.isArray(m?.message) ? m.message : [];
            const tx = segs
              .filter((x) => x?.type === "text")
              .map((x) => x?.data?.text ?? "")
              .join("")
              .trim();
            const imgSeg = segs.find((x) => x?.type === "image");
            const fwSeg = segs.find((x) => x?.type === "forward");
            let mark = "";
            if (imgSeg) {
              const u = String(imgSeg?.data?.url || imgSeg?.data?.file || "");
              if (u) imgUrls.push(u);
              mark += "［图片］";
            }
            if (fwSeg) {
              if (!forwardId) {
                forwardId = String(fwSeg?.data?.id ?? fwSeg?.data?.message_id ?? fwSeg?.data?.resid ?? "");
              }
              mark += "［聊天记录］";
            }
            if (tx || mark) lines.push(`${nm}：${tx.slice(0, 80)}${mark}`);
          }
          lines.reverse();
          if (lines.length) {
            emptyAtNote += `[你被 @ 之前的聊天记录]\n${lines.join("\n")}\n`;
          }
          // 上面最后一张图也拿给她看
          if (imgUrls.length && cfg.enableImages) {
            const room = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
            const picks = imgUrls.slice(-Math.min(2, room));
            for (const u of picks) {
              const got = await imagePayloadFrom(u);
              if (got) imagePayloads.push(got);
            }
            if (picks.length) logger.info?.(`[onebot] 空 @ 时带上了上面 ${picks.length} 张图`);
          }
          // 上面如果有聊天合集，展开前 3 条
          if (forwardId) {
            try {
              const fres = await client.call("get_forward_msg", { id: forwardId }, 6000);
              const fmsgs = Array.isArray(fres?.messages) ? fres.messages : [];
              const flines = fmsgs.slice(0, 3).map((fm) => {
                const fn = fm?.sender?.card || fm?.sender?.nickname || "某人";
                const fsegs = Array.isArray(fm?.message) ? fm.message : [];
                const ft = fsegs
                  .filter((x) => x?.type === "text")
                  .map((x) => x?.data?.text ?? "")
                  .join("")
                  .trim();
                const hasImg = fsegs.some((x) => x?.type === "image");
                return ft || hasImg ? `${fn}：${ft.slice(0, 60)}${hasImg ? "［图片］" : ""}` : "";
              }).filter(Boolean);
              if (flines.length) {
                emptyAtNote += `[上面那个聊天记录（前 ${flines.length} 条，共 ${fmsgs.length} 条）]\n${flines.join("\n")}\n`;
                logger.info?.(`[onebot] 空 @ 时展开了上面的聊天合集（${fmsgs.length} 条）`);
              }
            } catch (fe) {
              logger.debug?.(`[onebot] 空 @ 展开合集失败：${fe?.message ?? fe}`);
            }
          }
        } catch (err) {
          logger.warn?.(`[onebot] 空 @ 拉历史失败：${err?.message ?? err}`);
        }
      }
      emptyAtNote +=
        "（对方只 @ 了你，没打字。上面是最近的聊天记录——你要自己判断他想让你看的是哪一条，" +
        "通常是最新的图片、链接、或那段聊天记录。针对那一条回应，具体说点内容，" +
        "别笼统地说「看过了」「怎么了」。实在判断不出来就接最近的话题讲一句。）\n\n";
    }

    let msgText = parsed.text || "（只有 @，没说话）";
    if (parsed.replyIds?.length && imagePayloads.length > 0 && !parsed.text) {
      msgText = "（@ 了你，并引用了上面那张图，没打字）";
    }
    const bodyBase =
      ev.message_type === "group"
        ? `[QQ群消息] 群号 ${ev.group_id}，发言人 ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`
        : `[QQ私聊] ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`;
    let observed = "";
    if (ev.message_type === "group" && cfg.groupObserve) {
      try {
        const entry = await sessions.ensure(conversationKey(ev));
        const list = entry.observations ?? [];
        if (list.length) observed = "\n[群里最近没人 @ 你的消息]\n" + list.slice(-12).join("\n");
      } catch {
        // 忽略
      }
    }
    let slangNote = "";
    if (ev.message_type === "group" && cfg.slangEnabled !== false) {
      // 优先：最近 30 分钟在聊什么
      try {
        const ent = sessions.entries.get(key);
        const win = ent?.topicWindow ?? [];
        if (win.length >= 3) {
          const cnt = new Map();
          const stop = new Set([
            "这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们",
            "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么",
            "知道", "觉得", "应该", "可能", "真的", "有点", "一直", "时候", "自己", "这样",
          ]);
          for (const item of win) {
            for (const w of item.w) {
              if (stop.has(w)) continue;
              cnt.set(w, (cnt.get(w) ?? 0) + 1);
            }
          }
          const top = [...cnt.entries()]
            .filter(([w, n]) => n >= 3 && w.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([w]) => w);
          if (top.length >= 2) slangNote = `[这个群最近在聊] ${top.join("、")}\n`;
        }
      } catch {
        // 忽略
      }
      try {
        const ent = sessions.entries.get(key);
        const freq = ent?.wordFreq;
        if (!slangNote && freq && freq.size) {
          const stop = new Set(["这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们", "现在", "然后", "因为", "所以", "还是", "已经", "一个"]);
          const top = [...freq.entries()]
            .filter(([w, n]) => n >= 3 && !stop.has(w) && w.length >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([w]) => w);
          if (top.length >= 2) slangNote = `[这个群最近常提] ${top.join("、")}\n`;
        }
      } catch {
        // 忽略
      }
    }

    const vibe = [timeContext(), moodContext()].filter(Boolean).join("\n");
    const vibeNote = vibe ? `${vibe}\n\n` : "";

    // 合并转发：展开前几条
    // 如果只是"回复了一条转发"，转发内容在被引用的消息里，先追溯回来
    if (
      cfg.forwardPreview !== false &&
      !parsed.forwards?.length &&
      parsed.replyIds?.length
    ) {
      try {
        const quoted = await client.call("get_msg", { message_id: parsed.replyIds[0] }, 6000);
        const qsegs = Array.isArray(quoted?.message) ? quoted.message : [];
        logger.info?.(
          `[onebot] 引用消息结构：types=${JSON.stringify(qsegs.map((x) => x?.type))} raw=${JSON.stringify(quoted).slice(0, 400)}`,
        );
        // 被引用的消息里如果有图，也拿给她看
        if (cfg.enableImages && imagePayloads.length < (cfg.maxImagesPerMessage || 2)) {
          const qImg = qsegs.find((x) => x?.type === "image");
          if (qImg) {
            const u = String(qImg?.data?.url || qImg?.data?.file || "");
            if (u) {
              const got = await imagePayloadFrom(u);
              if (got) {
                imagePayloads.push(got);
                logger.info?.("[onebot] 引用消息里的图已取到");
              } else {
                logger.warn?.("[onebot] 引用消息里的图取不到（直连和 get_image 都失败）");
              }
            }
          }
        }
        const fwSeg = qsegs.find((x) => x?.type === "forward");
        if (fwSeg) {
          parsed.forwards.push({
            id: String(fwSeg.data?.id ?? fwSeg.data?.message_id ?? fwSeg.data?.resid ?? ""),
            rawKeys: Object.keys(fwSeg.data ?? {}),
            raw: fwSeg.data ?? {},
          });
          logger.info?.("[onebot] 从引用消息里找到了转发");
        }
      } catch (err) {
        // 旧客户端消息可能查不到，用引用段自带的摘要兜底
        const msg = String(err?.message ?? err);
        logger.info?.(`[onebot] 追溯引用失败（${msg.slice(0, 60)}），用摘要兜底`);
        if (parsed.replySummary) {
          parsed.forwards.push({ id: "", rawKeys: [], raw: {}, summaryOnly: parsed.replySummary });
        }
      }
    }

    // 被 @ 但本条既没转发也没引用：回看最近几条，找上面刚发的转发
    if (
      cfg.forwardPreview !== false &&
      !parsed.forwards?.length &&
      !parsed.replyIds?.length &&
      parsed.hasAt &&
      ev.message_type === "group"
    ) {
      try {
        const hist = await client.call(
          "get_group_msg_history",
          { group_id: ev.group_id, count: Number(cfg.forwardLookback) || 25 },
          8000,
        );
        const list = Array.isArray(hist?.messages) ? hist.messages : [];
        for (const m of [...list].reverse()) {
          const segs2 = Array.isArray(m?.message) ? m.message : Array.isArray(m?.content) ? m.content : [];
          const fw = segs2.find((x) => x?.type === "forward");
          if (fw) {
            parsed.forwards.push({
              id: String(fw.data?.id ?? fw.data?.message_id ?? fw.data?.resid ?? ""),
              rawKeys: Object.keys(fw.data ?? {}),
              raw: fw.data ?? {},
            });
            logger.info?.(
              `[onebot] 从最近历史里找到了转发：id=${parsed.forwards[parsed.forwards.length - 1].id}`,
            );
            break;
          }
        }
      } catch (err) {
        logger.debug?.(`[onebot] 回看历史失败：${err?.message ?? err}`);
      }
    }

    let forwardNote = "";
    if (cfg.forwardPreview !== false && parsed.forwards?.length) {
      const only = parsed.forwards[0];
      if (only?.summaryOnly) {
        forwardNote = `[对方引用了这条消息] ${only.summaryOnly}\n（查不到原文，只能看到摘要）\n\n`;
      }
      try {
        const fw = parsed.forwards[0];
        if (fw?.summaryOnly) throw new Error("skip");
        logger.info?.(
          `[onebot] 收到转发段：id=${fw.id || "(空)"} keys=${JSON.stringify(fw.rawKeys)} raw=${JSON.stringify(fw.raw).slice(0, 200)}`,
        );
        let res;
        try {
          res = await client.call("get_forward_msg", { id: fw.id }, 8000);
        } catch (e1) {
          logger.warn?.(`[onebot] get_forward_msg(id) 失败：${e1?.message ?? e1}，改用 message_id`);
          res = await client.call("get_forward_msg", { message_id: fw.id }, 8000);
        }
        if (!res || (Array.isArray(res?.messages) && res.messages.length === 0)) {
          logger.warn?.(`[onebot] 转发展开为空，返回：${JSON.stringify(res).slice(0, 300)}`);
        }
        const msgs = Array.isArray(res?.messages) ? res.messages : Array.isArray(res) ? res : [];
        const forwardImages = [];
        const lines = [];
        let nestedDone = false;
        for (const m of msgs.slice(0, Number(cfg.forwardMaxItems) || 5)) {
          const name = m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || "某人";
          const segs2 = Array.isArray(m?.content)
            ? m.content
            : Array.isArray(m?.message)
              ? m.message
              : [];
          for (const x of segs2) {
            if (x?.type === "image") {
              const u = String(x?.data?.url || x?.data?.file || "");
              if (u) forwardImages.push(u);
            }
          }
          let t = segs2
            .filter((x) => x?.type === "text")
            .map((x) => x?.data?.text ?? "")
            .join("")
            .trim();

          // 内层转发：递归展开一个，最多 3 条
          const subFw = segs2.find((x) => x?.type === "forward");
          if (subFw && !nestedDone) {
            nestedDone = true;
            try {
              const subId = String(subFw.data?.id ?? subFw.data?.message_id ?? subFw.data?.resid ?? "");
              if (subId) {
                const subRes = await client.call("get_forward_msg", { id: subId }, 6000);
                const subMsgs = Array.isArray(subRes?.messages)
                  ? subRes.messages
                  : Array.isArray(subRes)
                    ? subRes
                    : [];
                const subLines = subMsgs
                  .slice(0, 3)
                  .map((sm) => {
                    const sn =
                      sm?.sender?.card || sm?.sender?.nickname || sm?.sender?.user_id || "某人";
                    const ssegs = Array.isArray(sm?.content)
                      ? sm.content
                      : Array.isArray(sm?.message)
                        ? sm.message
                        : [];
                    const st = ssegs
                      .filter((x) => x?.type === "text")
                      .map((x) => x?.data?.text ?? "")
                      .join("")
                      .trim();
                    return st ? `${sn}：${st.slice(0, 50)}` : "";
                  })
                  .filter(Boolean);
                if (subLines.length) {
                  t += `\n  ↳[内层转发，共 ${subMsgs.length} 条，看前 ${subLines.length} 条] ${subLines.join("；")}`;
                }
              }
            } catch (e2) {
              logger.debug?.(`[onebot] 内层转发展开失败：${e2?.message ?? e2}`);
            }
          }

          if (t) lines.push(`${name}：${t.slice(0, 220)}`);
        }
        // 转发里的第一张图也拿给模型看
        if (forwardImages.length && cfg.enableImages !== false) {
          const limit = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
          let gotCount = 0;
          for (const u of forwardImages.slice(0, Math.min(2, limit))) {
            const got = await downloadImage(u, cfg.maxImageBytes || 6000000);
            if (got) {
              imagePayloads.push(got);
              gotCount += 1;
            }
          }
          if (gotCount) logger.info?.(`[onebot] 已取到转发展开里的 ${gotCount} 张图`);
        }
        // 记下转发 id，供 read_forward_more 工具继续展开
        try {
          const ent = await sessions.ensure(key);
          ent.lastForward = { id: fw.id, total: msgs.length, at: Date.now() };
        } catch {
          // 忽略
        }
        if (lines.length) {
          forwardNote =
            `[转发聊天记录（前 ${lines.length} 条，共 ${msgs.length} 条）]\n` +
            lines.join("\n") +
            (msgs.length > lines.length
              ? "\n（如果这个话题你感兴趣，可以调 read_forward_more 看后面几条）\n"
              : "") +
            "\n";
        }
      } catch (err) {
        logger.warn?.(`[onebot] 转发展开失败：${err?.message ?? err}`);
      }
    }

    // 文本文件：读前 1000 字
    let fileNote = "";
    if (cfg.filePreview !== false && parsed.files?.length) {
      const f = parsed.files[0];
      try {
        const okExt = /\.(txt|md|log|json|csv|yml|yaml|ini|conf)$/i.test(f.name);
        if (!okExt) {
          fileNote = `[收到文件：${f.name}（不是文本格式，未展开）]\n\n`;
        } else {
          let url = "";
          if (ev.message_type === "group") {
            const r = await client.call(
              "get_group_file_url",
              { group_id: ev.group_id, file_id: f.id, busid: f.busid ?? 0 },
              8000,
            );
            url = String(r?.url ?? r?.file ?? "");
          } else {
            const r = await client.call(
              "get_private_file_url",
              { user_id: ev.user_id, file_id: f.id },
              8000,
            );
            url = String(r?.url ?? r?.file ?? "");
          }
          if (!url) throw new Error("拿不到下载地址");
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(12000),
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const maxBytes = Number(cfg.fileMaxBytes) || 1048576;
          const body2 = buf.subarray(0, maxBytes).toString("utf8");
          const limit = Number(cfg.filePreviewChars) || 1000;
          const snippet = body2.slice(0, limit);
          fileNote =
            `[文件 ${f.name}${buf.length > maxBytes ? "（超大，只读头部）" : ""}，前 ${snippet.length} 字]\n` +
            snippet +
            "\n\n";
        }
      } catch (err) {
        logger.warn?.(`[onebot] 文件预览失败：${err?.message ?? err}`);
        fileNote = `[收到文件：${f.name}（读取失败）]\n\n`;
      }
    }

    let crossNote = "";
    if (cfg.crossGroupMemory && ev.message_type === "group") {
      const digest = otherGroupDigest(key, cfg.crossGroupMax);
      if (digest) crossNote = `[你其他群最近在聊] ${digest}\n`;
    }

    let recallNote = "";
    if (cfg.recallEnabled && cfg.recallAutoTrigger && /(记得|上次|之前|以前|提过|说过|那次)/.test(parsed.text)) {
      try {
        const entryForRecall = await sessions.ensure(key);
        const res = await recallSearch(entryForRecall.sessionId, parsed.text, { cross: false });
        if (res.ok && res.hits?.length) {
          recallNote = renderRecall(res.hits);
          logger.info?.(`[onebot] 自动回忆命中 ${res.hits.length} 条`);
        }
      } catch (err) {
        logger.debug?.(`[onebot] 自动回忆失败：${err?.message ?? err}`);
      }
    }

    const catchupNote = ev.__catchup
      ? "（你刚才离线了一阵，这是恢复连接后补看到的消息，直接回一句就好，不要解释掉线。）\n"
      : "";
    let selfLine = "";
    if (cfg.selfViews !== false) {
      const views = selfViews.render(4);
      if (views) selfLine = `[你自己的想法] ${views}\n`;
      if (cfg.selfReflect !== false) {
        const ref = selfViews.renderReflections(1);
        if (ref) selfLine += `[你最近的自我反省] ${ref}\n`;
      }
    }

    let factLine = "";
    if (ev.message_type !== "group" || cfg.shareFactsToGroup) {
      const rendered = facts.render(6);
      if (rendered) factLine = `[你记得的事] ${rendered}\n`;
    }
    const body = vibeNote + slangNote + selfLine + emptyAtNote + forwardNote + fileNote + catchupNote + recallNote + linkNote + crossNote + factLine + bodyBase + observed;
    const ownerNote =
      cfg.ownerId && String(ev.user_id) === String(cfg.ownerId) && ev.message_type !== "group"
        ? "（这是你的主人。）\n"
        : "";
    const lenHint = pickLengthHint(parsed.text);
    const prompt = (
      cfg.styleHint
        ? `${cfg.styleHint}\n${lenHint}\n${ownerNote}\n${body}`
        : `${lenHint}\n${ownerNote}${body}`
    ).trim();

    // 私聊偶尔多说两句（大部分还是一句）
    const privateExtra =
      ev.message_type !== "group" &&
      Math.random() < (Number(cfg.privateMultiSentenceChance) || 0.2)
        ? "（这次可以多说两句，2-3 句，聊开一点。）\n"
        : "";
    enqueue(key, ev, privateExtra + prompt, imagePayloads);
  };

  /** 合并窗口：对方连续快速发消息时，攒一会儿一起回 */
  const mergeBuf = new Map();
  function flushBuf(key) {
    const buf = mergeBuf.get(key);
    if (!buf) return;
    mergeBuf.delete(key);
    if (buf.timer) clearTimeout(buf.timer);
    const merged =
      buf.prompts.length > 1
        ? `（对方连着发了 ${buf.prompts.length} 条，合起来一起回）\n` + buf.prompts.join("\n")
        : buf.prompts[0];
    void deliver(key, buf.ev, merged, buf.images);
  }

  function enqueue(key, ev, prompt, images) {
    const isGroup = ev.message_type === "group";
    // 合并只对私聊生效；群聊立即处理
    if (cfg.mergeMessages === false || isGroup) {
      void deliver(key, ev, prompt, images);
      return;
    }
    const buf = mergeBuf.get(key) ?? { prompts: [], images: [], ev, timer: null };
    buf.prompts.push(prompt);
    buf.ev = ev;
    if (Array.isArray(images) && images.length) {
      buf.images = [...buf.images, ...images].slice(0, 3);
    }
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      flushBuf(key);
    }, Number(isGroup ? (cfg.groupMergeWindowMs || 1500) : (cfg.mergeWindowMs || 2500)));
    buf.timer.unref?.();
    mergeBuf.set(key, buf);
  }

  /** 正在处理中的 message_id，防止实时事件和轮询重复回复同一条 */
  const processingIds = new Set();

  /** 取图：先走直连 CDN，失败再用 NapCat 的 get_image 兜底 */
  async function imagePayloadFrom(url) {
    if (!url) return null;
    const got = await downloadImage(url, cfg.maxImageBytes || 6000000);
    if (got) return got;
    try {
      const r = await client.call("get_image", { file: String(url) }, 12000);
      const p = String(r?.file ?? r?.path ?? r?.data?.file ?? "");
      if (p && existsSync(p)) {
        const buf = readFileSync(p);
        if (buf.length && buf.length <= (cfg.maxImageBytes || 6000000)) {
          logger.info?.("[onebot] 直连失败，改用 get_image 拿到本地图");
          return { data: buf, mediaType: "image/jpeg" };
        }
      }
    } catch {
      // 兜底也失败就算了
    }
    return null;
  }

  /** 执行一轮并发送回复 */
  async function deliver(key, ev, prompt, images) {
    const pid = String(ev?.message_id ?? "");
    if (pid) processingIds.add(pid);
    try {
      // 加超时保护：agent 未就绪时 sessions.run 可能无限挂起
      const reply = await Promise.race([
        sessions.run(key, prompt, ev, images),
        sleep(90000).then(() => {
          throw new Error("回合超时 90s（agent 可能未就绪或模型卡住）");
        }),
      ]);
      const cur = sessions.entries.get(key);
      if (cur?.usedStickerOnly && !String(reply || "").trim()) {
        logger.info?.("[onebot] 本轮只发了表情包，不再补文字");
        markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
        flushSeen();
        if (cfg.followUpEnabled) {
          if (hitWindow(key, ev.user_id)) bumpWindow(key, ev.user_id);
          else openWindow(key, ev.user_id);
        }
        return;
      }
      const out = (reply || "").trim();
      if (!out) {
        // 模型什么都没说，就什么都不发（别发占位文案）
        logger.info?.("[onebot] 本轮无文本输出，不发消息");
        return;
      }
      const clipped =
        out.length > cfg.maxReplyChars ? out.slice(0, cfg.maxReplyChars) + "\n…（已截断）" : out;
      const hasQuoteSeg =
        Array.isArray(ev.message) && ev.message.some((x) => x?.type === "reply");
      await client.sendHuman(ev, clipped, { quote: !!(ev.__hasAt || hasQuoteSeg) });
      try {
        const ent2 = sessions.entries.get(key);
        if (ent2) {
          ent2.lastReplyAt = Date.now();
          markRuntimeDirty();
        }
      } catch {
        // 忽略
      }
      logger.info?.(`[onebot] → ${key} ${clipped.slice(0, 60).replace(/\n/g, " ")}`);
      audit({ kind: "reply", key, text: clipped.slice(0, 200) });
      markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
      flushSeen();
      // 情绪到位时主动补一张表情包（不依赖模型主动调用）
      if (cfg.autoSticker !== false && Math.random() < (Number(cfg.autoStickerChance) || 0.3)) {
        try {
          const t2 = String(clipped || "");
          let mood = "";
          if (/(哈哈|笑死|好笑|乐死|😂|🤣)/.test(t2)) mood = "大笑";
          else if (/(无语|服了|离谱|绝了|🙄)/.test(t2)) mood = "无语";
          else if (/(生气|气死|烦|火大|😤)/.test(t2)) mood = "生气";
          else if (/(难过|委屈|哭|😭)/.test(t2)) mood = "委屈";
          else if (/(吓|震惊|居然|😱)/.test(t2)) mood = "震惊";
          else if (/(开心|高兴|太好了|😄|😊)/.test(t2)) mood = "开心";
          else if (/(困|睡觉|晚安|😴)/.test(t2)) mood = "睡觉";
          if (mood) {
            const picked2 = pickSticker(cfg.stickerDir, mood);
            if (picked2) {
              await sleep(300 + Math.random() * 500);
              await client.sendImage(ev, picked2.path);
              logger.info?.(`[onebot] 顺手补了一张表情包（${mood}）`);
              audit({ kind: "sticker_auto", mood, file: picked2.path });
            }
          }
        } catch (err) {
          logger.debug?.(`[onebot] 自动表情包失败：${err?.message ?? err}`);
        }
      }

      if (!agentReady) {
        agentReady = true;
        logger.info?.(`[onebot] agent 已就绪，重放暂存 ${pendingWhileBooting.length} 条`);
        const queued = pendingWhileBooting.splice(0);
        for (const qev of queued) {
          // 暂存时已经进过 recentIds，重放要清掉，否则会被去重拦下
          try {
            recentIds.delete(String(qev.message_id ?? ""));
          } catch {
            // 忽略
          }
          void client.onEvent(qev).catch(() => {});
        }
      }
      if (cfg.followUpEnabled) {
        if (hitWindow(key, ev.user_id)) {
          bumpWindow(key, ev.user_id);
        } else {
          openWindow(key, ev.user_id);
          logger.info?.(`[onebot] 续聊窗口打开 ${key} 用户 ${ev.user_id}（上限 ${followMax()} 轮）`);
        }
      }
    } catch (err) {
      const emsg = String(err?.message ?? err);
      logger.warn?.(`[onebot] 处理失败 ${key}：${emsg}`);
      audit({ kind: "error", key, error: emsg.slice(0, 300) });
      // 网络/掉线类错误不重试——重试也发不出去，等重连后由 catchUp 补
      if (/网络连接异常|1006514|未连接|disconnected|ECONN|ETIMEDOUT|socket/i.test(emsg)) {
        logger.info?.(`[onebot] 网络异常，跳过重试（等重连补回）：${key}`);
        return;
      }
      try {
        const ent = sessions.entries.get(key);
        if (ent) {
          logger.info?.(`[onebot] 自动重试 ${key}`);
          await sleep(1500);
          try {
            await ent.handle?.dispose?.();
          } catch {
            // 忽略
          }
          ent.handle = null;
          const reply2 = await sessions.run(key, prompt, ev, images);
          const out2 = String(reply2 || "").trim();
          if (out2) {
            await client.sendHuman(ev, out2);
            audit({ kind: "retry_ok", key, text: out2.slice(0, 120) });
            markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
            flushSeen();
          }
        }
      } catch (err2) {
        logger.warn?.(`[onebot] 重试仍失败 ${key}：${err2?.message ?? err2}`);
      }
      if (cfg.replyOnError) {
        try {
          await client.sendText(ev, `处理出错：${String(err?.message ?? err).slice(0, 300)}`);
        } catch {
          // 回复失败忽略
        }
      }
    } finally {
      if (pid) processingIds.delete(pid);
    }
  }

  /** 其他群最近在聊什么（脱敏、截断、只取话题） */
  function otherGroupDigest(currentKey, maxItems) {
    const bits = [];
    for (const [k, e] of sessions.entries) {
      if (!k.startsWith("group:") || k === currentKey) continue;
      const obs = e.observations ?? [];
      if (!obs.length) continue;
      for (const line of obs.slice(-4)) {
        // 去掉「昵称：」前缀，只留内容
        const clean = String(line).replace(/^[^：:\n]{1,16}[：:]\s*/, "").slice(0, 36);
        if (!clean || SENSITIVE.test(clean)) continue;
        bits.push(clean);
      }
    }
    return bits.slice(-(maxItems || 4)).join("；");
  }

  /** 把某个会话 id 自动写进配套插件配置（幂等） */
  function autoConfigurePlugins(sid) {
    if (cfg.autoConfigurePlugins === false) return;
    const base = join(HOME, ".dsh");
    let changed = [];

    // fish-memory：开启该会话的记忆
    try {
      const fp = join(base, "fish-memory-config.json");
      const d = existsSync(fp) ? JSON.parse(readFileSync(fp, "utf8")) : {};
      d.sessions = d.sessions && typeof d.sessions === "object" ? d.sessions : {};
      if (!d.sessions[sid]) {
        d.sessions[sid] = true;
        writeFileSync(fp, JSON.stringify(d, null, 2), "utf8");
        changed.push("fish-memory");
      }
    } catch {
      // 插件没装就算了
    }

    // speak-up：把会话加进目标列表
    try {
      const sp = join(base, "speak-up-config.json");
      const d = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {};
      const list = Array.isArray(d["目标会话"]) ? d["目标会话"] : [];
      if (!list.includes(sid)) {
        list.push(sid);
        d["目标会话"] = list;
        writeFileSync(sp, JSON.stringify(d, null, 2), "utf8");
        changed.push("speak-up");
      }
    } catch {
      // 忽略
    }

    // feiyu-mood：只在还没设目标时设一次
    try {
      const mp = join(base, "feiyu-mood/config.json");
      const d = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
      if (!d.targetSession) {
        d.targetSession = sid;
        mkdirSync(join(base, "feiyu-mood"), { recursive: true });
        writeFileSync(mp, JSON.stringify(d, null, 2), "utf8");
        changed.push("feiyu-mood");
      }
    } catch {
      // 忽略
    }

    if (changed.length) {
      logger.info?.(`[onebot] 自动配置插件：${changed.join(",")} <- ${sid}`);
      audit({ kind: "plugin_autoconfig", sid, plugins: changed });
    }
  }

  // ── 运行时状态持久化（重启不丢 msgTimes / lastReplyAt 等） ──
  const RUNTIME_PATH = join(HOME, ".dsh/onebot-bridge/runtime.json");
  let runtimeDirty = false;
  let runtimeTimer = null;

  function snapshotRuntime() {
    const data = {};
    for (const [key, ent] of sessions.entries) {
      data[key] = {
        msgTimes: ent.msgTimes ?? [],
        lastMentionAt: ent.lastMentionAt ?? 0,
        lastReplyAt: ent.lastReplyAt ?? 0,
        lastActiveJoinAt: ent.lastActiveJoinAt ?? 0,
        lastMessageAt: ent.lastMessageAt ?? 0,
        topicPending: !!ent.topicPending,
        lastTopicAt: ent.lastTopicAt ?? 0,
      };
    }
    try {
      writeFileSync(RUNTIME_PATH, JSON.stringify(data), "utf8");
    } catch {
      // 忽略
    }
  }

  function markRuntimeDirty() {
    runtimeDirty = true;
    if (runtimeTimer) return;
    runtimeTimer = setTimeout(() => {
      runtimeTimer = null;
      if (!runtimeDirty) return;
      runtimeDirty = false;
      snapshotRuntime();
    }, 5000);
    runtimeTimer.unref?.();
  }

  function restoreRuntime(entry) {
    try {
      if (!restoreRuntime.cache) {
        try {
          restoreRuntime.cache = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
        } catch {
          restoreRuntime.cache = {};
        }
      }
      const saved = restoreRuntime.cache?.[entry.key];
      if (!saved) return;
      if (Array.isArray(saved.msgTimes)) {
        const now = Date.now();
        entry.msgTimes = saved.msgTimes.filter((t) => now - t < 60000);
      }
      for (const k of ["lastMentionAt", "lastReplyAt", "lastActiveJoinAt", "lastMessageAt", "lastTopicAt"]) {
        if (saved[k]) entry[k] = saved[k];
      }
      if (saved.topicPending) entry.topicPending = true;
    } catch {
      // 忽略
    }
  }

  // ── 健康状态（给看门狗读） ──
  const HEALTH_PATH = join(HOME, ".dsh/onebot-bridge/health.json");
  const health = {
    lastPollAt: 0,
    lastEventAt: 0,
    apiFailStreak: 0,
    eventMissSince: 0,
    restartedAt: Date.now(),
  };
  function saveHealth() {
    try {
      writeFileSync(HEALTH_PATH, JSON.stringify(health), "utf8");
    } catch {
      // 忽略
    }
  }

  /** 把运行时配置写回 config.json */
  function persistConfig() {
    try {
      writeFileSync(
        join(HOME, ".dsh/onebot-bridge/config.json"),
        JSON.stringify(cfg, null, 2),
        "utf8",
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── 掉线恢复后：补回复最近一次 @ ────────────────────────────
  client.onReconnected = async () => {
    try {
      const groups = new Set();
      for (const gid of cfg.prewarmGroups ?? []) groups.add(String(gid));
      for (const [k] of sessions.entries) {
        if (k.startsWith("group:")) groups.add(k.slice(6));
      }
      // 关键：历史上处理过的群（包括临时拉的群）也要补
      for (const k of Object.keys(seenState)) {
        if (k.startsWith("group:")) groups.add(k.slice(6));
      }
      for (const gid of groups) {
        try {
          const res = await client.call("get_group_msg_history", {
            group_id: Number(gid),
            count: 30,
          });
          const list = Array.isArray(res) ? res : res?.messages ?? [];
          const rec = seenState[`group:${gid}`] ?? {};
          const done = new Set(Array.isArray(rec.ids) ? rec.ids.map(String) : []);
          const since = rec.lastTime ?? 0;
          const hasIds = Array.isArray(rec.ids) && rec.ids.length > 0;
          let caught = 0;
          for (const m of [...list].reverse()) {
            const mid = String(m.message_id ?? m.id ?? "");
            if (!mid || recentIds.has(mid) || done.has(mid)) continue;
            const msgTs = Number(m.time) * 1000 || 0;
            // 有 id 记录时只看 id；旧数据没有 ids 时用时间兜底
            if (!hasIds && msgTs && msgTs <= since) continue;
            const segs = Array.isArray(m.message) ? m.message : [];
            const atMe = segs.some(
              (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
            );
            if (!atMe) continue;
            const ev = {
              post_type: "message",
              message_type: "group",
              group_id: Number(gid),
              user_id: m.sender?.user_id ?? m.user_id,
              message_id: mid,
              message: segs,
              sender: m.sender ?? {},
              __catchup: true,
            };
            logger.info?.(`[onebot] 补回复离线期间的 @：群 ${gid} 消息 ${mid}`);
            audit({ kind: "catchup", key: `group:${gid}`, messageId: mid });
            // 不在这里 markSeen —— 交给 onEvent 在回复成功后记录，
            // 否则会出现「标记了已处理但其实没回复」，轮询也不会再补。
            ev.__fromPoll = true;
            try {
              await Promise.race([
                client.onEvent(ev),
                sleep(45000).then(() => {
                  throw new Error("onEvent 超时（可能 agent 未就绪）");
                }),
              ]);
            } catch (terr) {
              logger.warn?.(`[onebot] 补回复 ${mid} 失败：${terr?.message ?? terr}`);
            }
            // 每个群最多补 2 条
            caught += 1;
            if (caught >= 2) break;
          }
        } catch (err) {
          logger.debug?.(`[onebot] 拉取群 ${gid} 历史失败：${err?.message ?? err}`);
        }
      }
    } catch (err) {
      logger.warn?.(`[onebot] 补回复流程失败：${err?.message ?? err}`);
    }
  };

  // ── 工具审批：QQ 会话里自动拒绝，避免回合挂死 ──────────────
  // DSH 的 approval/request 是 waterfall；不接管就会一直等。
  ctx.on?.("approval/request", (req, next) => {
    try {
      const sid = req?.agent?.session?.id;
      const entry = sid ? sessions.bySessionId(sid) : null;
      if (!entry) return next();
      const target = entry.lastTarget;
      const toolName = req?.toolName ?? "unknown";
      // 只在「控制者本人的私聊」里自动放行；群聊/其他人一律拒绝
      const isOwnerPrivate =
        !!target &&
        target.message_type !== "group" &&
        cfg.ownerId &&
        String(target.user_id) === String(cfg.ownerId);
      if (isOwnerPrivate) {
        logger.info?.(`[onebot] 自动允许工具：${toolName}（控制者私聊）`);
        return "allowed-once";
      }
      logger.warn?.(`[onebot] 自动拒绝工具：${toolName}（非控制者或群聊）`);
      return "rejected";
    } catch {
      return next();
    }
  });

  // ── 自发消息转发：agent 自己开口（speak-up 等）时把话发到 QQ ──
  // 桥触发的回合由 sendHuman 自己发，这里只处理「不是桥触发的」turn。
  ctx.on?.("session/event", (a, b) => {
    try {
      const session = a && a.id ? a : b && b.session;
      const event = a && a.id ? b : a;
      if (!session || !event) return;
      const entry = sessions.bySessionId(session.id);
      if (!entry) return;
      if (event.type === "assistant/message") {
        const blocks = event.data?.message?.content ?? [];
        const text = blocks
          .filter((x) => x?.type === "text")
          .map((x) => x.text ?? "")
          .join("")
          .trim();
        if (text) entry.spontaneousText = text;
        return;
      }
      if (event.type === "turn/end") {
        const text = entry.spontaneousText ?? "";
        entry.spontaneousText = "";
        if (entry.inTurn) return; // 桥自己的回合，已经发过了
        if (!text || !entry.lastTarget) return;
        const ev = entry.lastTarget;
        // 检查是否照抄了新闻标题
        const topic = entryLastTopic.get(conversationKey(ev));
        if (topic) {
          const src = new Set(topic.split(""));
          let hit = 0;
          for (const ch of new Set(text.split(""))) if (src.has(ch)) hit += 1;
          const ratio = hit / Math.max(1, src.size);
          if (ratio > 0.75) {
            logger.warn?.(`[onebot] 自发消息与标题重合度 ${(ratio * 100).toFixed(0)}%，可能在复读：${text.slice(0, 40)}`);
            audit({ kind: "proactive_repeat", key: conversationKey(ev), ratio: Number(ratio.toFixed(2)), text: text.slice(0, 120) });
          }
          entryLastTopic.delete(conversationKey(ev));
        }
        logger.info?.(`[onebot] 自发消息 → ${conversationKey(ev)} ${text.slice(0, 40).replace(/\n/g, " ")}`);
        void client.sendHuman(ev, text.slice(0, cfg.maxReplyChars)).catch(() => {});
      }
    } catch (err) {
      logger.warn?.(`[onebot] 自发转发异常：${err?.message ?? err}`);
    }
  });

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

  const inQuietHours = () => {
    const h = new Date().getHours();
    const a = Number(cfg.proactiveQuietStart ?? 1);
    const b = Number(cfg.proactiveQuietEnd ?? 8);
    if (a === b) return false;
    return a < b ? h >= a && h < b : h >= a || h < b;
  };

  function scheduleProactive() {
    if (!cfg.proactiveEnabled || cfg.autoActionsEnabled === false) return;
    const min = Math.max(15, Number(cfg.proactiveMinMinutes) || 60);
    const max = Math.max(min, Number(cfg.proactiveMaxMinutes) || 120);
    const delay = (min + Math.random() * (max - min)) * 60 * 1000;
    setTimeout(() => {
      void (async () => {
        try {
          if (inQuietHours()) return;
          if (Math.random() > (Number(cfg.proactiveChance) || 0.45)) return;
          const picked = pickTarget();
          if (!picked) return;
          const [key] = picked;
          const news = await fetchHotNews(cfg, logger);
          if (!news.length) {
            logger.info?.("[onebot] 没抓到可用的热点，跳过本次主动分享");
            return;
          }
          const pick = news[Math.floor(Math.random() * news.length)];
          logger.info?.(`[onebot] 主动分享触发：${key} -> ${pick}`);
          audit({ kind: "proactive", key, topic: pick });
          entryLastTopic.set(key, pick);
          await sessions.runProactive(
            key,
            `（这是你自己的空闲时间，不是别人在问你。你刚刷到一条：「${pick}」。` +
              "如果你有想法，就用**你自己的话**讲出来——换个说法、加一句评论或吐槽都行，" +
              "**绝对不要照抄上面那句话的原文**，也不要提「热点」「新闻」「看到一条」这类词；" +
              "如果没什么可说的，就聊点别的轻松话题，当没看见这条。）",
          );
          if (cfg.followUpEnabled) {
            openWindow(key, "*");
            logger.info?.(`[onebot] 主动冒泡后开群级窗口 ${key}`);
          }
        } catch (err) {
          logger.warn?.(`[onebot] 主动分享失败：${err?.message ?? err}`);
        } finally {
          scheduleProactive();
        }
      })();
    }, delay).unref?.();
    logger.info?.(`[onebot] 下次主动分享约 ${Math.round(delay / 60000)} 分钟后`);
  }

  function scheduleDailyBrief() {
    if (!cfg.dailyBriefEnabled) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(cfg.dailyBriefHour) || 9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      void (async () => {
        try {
          const picked = pickTarget();
          if (picked) {
            logger.info?.(`[onebot] 生成每日简讯：${picked[0]}`);
            audit({ kind: "daily_brief", key: picked[0] });
            const y = new Date(Date.now() - 86400000);
            const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
            const statsLine = renderStats(summarizeDay(ymd));
            await sessions.runProactive(
              picked[0],
              "（内部任务：生成今天的简讯。用三四句话报一下今天的天气、1-2 条值得知道的 AI/科技动态，" +
                (statsLine ? `最后顺带提一句昨天的聊天情况：${statsLine} ` : "") +
                "语气像朋友随口转述，不要标题、不要列表、不要「简讯」两个字。）",
            );
          }
        } catch (err) {
          logger.warn?.(`[onebot] 简讯生成失败：${err?.message ?? err}`);
        } finally {
          scheduleDailyBrief();
        }
      })();
    }, Math.max(60000, delay)).unref?.();
    logger.info?.(`[onebot] 每日简讯将在 ${next.toLocaleString("zh-CN")} 触发`);
  }

  // ── 说说：每天 0-3 条 ──────────────────────────────────────
  async function postQzone() {
    try {
      if (!cfg.qzoneEnabled) return;
      const hour = new Date().getHours();
      if (hour < Number(cfg.qzoneStartHour ?? 9) || hour >= Number(cfg.qzoneEndHour ?? 23)) return;
      const picked = pickTarget();
      if (!picked) return;
      const news = await fetchHotNews(cfg, logger);
      const topic = news.length ? news[Math.floor(Math.random() * news.length)] : "";
      const text = await sessions.generate(
        picked[0],
        "（内部任务：写一条 QQ 空间说说，一句话、40 字以内，符合你的人设和当前心情。" +
          (topic ? `可以借今天看到的一件事发挥：「${topic}」。` : "写点日常感受也行。") +
          "只输出说说的正文，不要引号、不要话题标签、不要解释。）",
      );
      const content = String(text || "").trim().replace(/^["'「」]+|["'「」]+$/g, "");
      if (!content) return;
      await client.call("send_qzone_msg", {
        content,
        ugc_right: Number(cfg.qzoneVisibility ?? 1),
      });
      logger.info?.(`[onebot] 发了条说说：${content.slice(0, 40)}`);
      audit({ kind: "qzone", key: picked[0], text: content.slice(0, 200) });
    } catch (err) {
      logger.warn?.(`[onebot] 发说说失败：${err?.message ?? err}`);
    }
  }

  function scheduleQzone() {
    if (!cfg.qzoneEnabled || cfg.autoActionsEnabled === false) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 5, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      void (async () => {
        try {
          const max = Math.max(0, Number(cfg.qzonePerDayMax ?? 3));
          const count = Math.floor(Math.random() * (max + 1));
          const startH = Number(cfg.qzoneStartHour ?? 9);
          const endH = Number(cfg.qzoneEndHour ?? 23);
          for (let i = 0; i < count; i++) {
            const at = startH + Math.random() * Math.max(0.5, endH - startH);
            const delayMs = Math.max(60000, (at - new Date().getHours()) * 3600 * 1000);
            setTimeout(() => void postQzone(), delayMs).unref?.();
          }
          logger.info?.(`[onebot] 今天计划发 ${count} 条说说`);
        } catch (err) {
          logger.warn?.(`[onebot] 排说说失败：${err?.message ?? err}`);
        } finally {
          scheduleQzone();
        }
      })();
    }, Math.max(60000, next - now)).unref?.();
  }

  // ── 冷群找话题：每 10 分钟检查一次 ──────────────────────────
  function checkSoloStreak() {
    if (cfg.soloStreakEnabled === false || cfg.autoActionsEnabled === false) return;
    const nowTs = Date.now();
    const minMsgs = Number(cfg.soloStreakMin) || 4;
    const waitMs = (Number(cfg.soloStreakWaitSeconds) || 600) * 1000;
    const coolMs = (Number(cfg.soloStreakCooldownMinutes) || 20) * 60000;
    for (const [key, ent] of sessions.entries) {
      if (!key.startsWith("group:")) continue;
      const st = ent.streak;
      if (!st || st.count < minMsgs) continue;
      const waited = nowTs - (st.lastAt ?? 0);
      if (waited < waitMs || waited > 15 * 60000) continue; // 太久就不提了
      if (nowTs - (ent.lastSoloJoinAt ?? 0) < coolMs) continue;
      if (ent.soloJoining) continue;
      ent.soloJoining = true;
      ent.lastSoloJoinAt = nowTs;
      const cnt = st.count;
      st.count = 0;
      logger.info?.(`[onebot] ${cnt} 条连发等了 ${Math.round(waited / 60000)} 分钟没人接，搭一句：${key}`);
      audit({ kind: "solo_join", key, count: cnt });
      void sessions
        .runProactive(
          key,
          "（群里有人刚才连着发了好几条，一直没人理。你可以接一句自然的，" +
            "像「我也在想这个」「你说的那个我见过」这种，给对方一个台阶；" +
            "别显得刻意、别说「你继续说」、别 @ 他。如果确实接不上，就什么都不说（只输出一个句号）。）",
        )
        .catch(() => {})
        .finally(() => {
          ent.soloJoining = false;
        });
    }
  }

  function checkQuietGroups() {
    if (!cfg.quietTopicEnabled || cfg.autoActionsEnabled === false) return;
    const nowTs = Date.now();
    const limit = (Number(cfg.quietTopicHours) || 6) * 3600 * 1000;
    for (const [key, ent] of sessions.entries) {
      if (!key.startsWith("group:")) continue;
      if (ent.topicPending) continue; // 上次主动开口后没人接话，不再开第二次
      const last = ent.lastMessageAt ?? 0;
      if (!last || nowTs - last < limit) continue;
      if (nowTs - (ent.lastTopicAt ?? 0) < limit) continue;
      ent.lastTopicAt = nowTs;
      ent.topicPending = true;
      logger.info?.(`[onebot] 群 ${key} 静了 ${cfg.quietTopicHours} 小时，主动找话题`);
      audit({ kind: "quiet_topic", key });
      void sessions
        .runProactive(
          key,
          "（这个群已经好几个小时没人说话了。你可以主动抛一个轻松的话题，" +
            "比如最近的新闻、天气、或者一个无关痛痒的小问题；一句话就够，" +
            "不要问「有人在吗」、不要说「好久没聊了」，像随口一提。）",
        )
        .catch(() => {});
    }
  }

  // ── 轮询兜底：NapCat 不推送"纯 @ 无文字"的消息，只能主动拉 ──
  let groupListCache = { at: 0, ids: [] };
  async function allGroupIds() {
    if (Date.now() - groupListCache.at > 10 * 60000 && groupListCache.ids.length === 0) {
      try {
        const list = await client.call("get_group_list", {}, 8000);
        const arr = Array.isArray(list) ? list : (list?.data ?? []);
        groupListCache = {
          at: Date.now(),
          ids: arr.map((g) => Number(g.group_id)).filter((n) => Number.isFinite(n) && n > 0),
        };
      } catch {
        // 拿不到就用已加载的
      }
    }
    if (groupListCache.ids.length) {
      if (Date.now() - groupListCache.at > 10 * 60000) groupListCache.at = Date.now();
      return groupListCache.ids;
    }
    return [...sessions.entries.keys()]
      .filter((k) => k.startsWith("group:"))
      .map((k) => Number(k.slice(6)))
      .filter(Boolean);
  }

  async function pollMissedMentions() {
    if (cfg.pollMentions === false) return;
    const count = Math.max(1, Number(cfg.pollMentionsCount) || 3);
    const targets = await allGroupIds();
    for (const gid of targets) {
      const key = `group:${gid}`;
      try {
        const hist = await client.call(
          "get_group_msg_history",
          { group_id: gid, count },
          6000,
        );
        const list = Array.isArray(hist?.messages) ? hist.messages : [];
        health.lastPollAt = Date.now();
        // 事件心跳：历史里最新一条「非 @ 我」的消息，桥收到过吗？
        try {
          const latestPlain = [...list]
            .reverse()
            .find(
              (m) =>
                !(Array.isArray(m?.message) ? m.message : []).some(
                  (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
                ),
            );
          const lid = String(latestPlain?.message_id ?? "");
          if (lid && !recentIds.has(lid)) {
            const ts = Number(latestPlain?.time) * 1000 || 0;
            if (!ts || Date.now() - ts < 300000) {
              if (!health.eventMissSince) health.eventMissSince = Date.now();
            }
          } else if (lid) {
            health.eventMissSince = 0;
          }
        } catch {
          // 忽略
        }

        const rec = seenState[key] ?? {};
        const replied = new Set(Array.isArray(rec.ids) ? rec.ids.map(String) : []);
        for (const m of [...list].reverse()) {
          const segs = Array.isArray(m?.message) ? m.message : [];
          const mentionsMe = segs.some(
            (x) => x?.type === "at" && String(x?.data?.qq) === String(cfg.selfId),
          );
          if (!mentionsMe) continue;
          // 只补「纯 @ 无文字」的消息——带字的消息腾讯会正常推送实时事件，
          // 轮询再插手只会重复回复。漏掉带字消息由「重连补回复」兜底。
          const bodyText = segs
            .filter((x) => x?.type === "text")
            .map((x) => x?.data?.text ?? "")
            .join("")
            .trim();
          if (bodyText) continue;
          const mid = String(m?.message_id ?? "");
          // 已回复 / 正在处理 / 实时链路已经处理过 —— 统统跳过
          // （处理失败的重试交给「重连补回复」，轮询只负责实时收不到的消息）
          if (!mid || replied.has(mid) || processingIds.has(mid) || recentIds.has(mid)) {
            continue;
          }
          // 只补最近 10 分钟内的
          const ts = Number(m?.time) * 1000 || 0;
          if (ts && Date.now() - ts > 10 * 60 * 1000) continue;
          const ev = {
            ...m,
            post_type: "message",
            message_type: "group",
            group_id: gid,
            user_id: m?.sender?.user_id,
            time: m?.time,
          };
          logger.info?.(`[onebot] 轮询发现未回复的 @：群 ${gid} 消息 ${mid}`);
          audit({ kind: "poll_mention", key, messageId: mid });
          recentIds.delete(mid); // 允许重试（上次可能失败了）
          ev.__fromPoll = true;
          try {
            await client.onEvent(ev);
          } catch (perr) {
            logger.warn?.(`[onebot] 轮询处理 ${mid} 失败：${perr?.message ?? perr}`);
          }
        }
      } catch (err) {
        health.apiFailStreak = (health.apiFailStreak ?? 0) + 1;
        logger.warn?.(`[onebot] 轮询拉历史失败 ${gid}：${err?.message ?? err}`);
      }
    }
    health.apiFailStreak = 0;
    saveHealth();
  }

  // ── 早上统一补回昨晚错过的消息 ─────────────────────────────
  async function morningCatchup() {
    if (!cfg.morningCatchup) return;
    for (const [key, entry] of sessions.entries) {
      const pend = entry.nightPending ?? [];
      if (!pend.length) continue;
      if (!entry.lastTarget) continue;
      const list = pend
        .slice(-6)
        .map((p) => `${p.name}：${p.text}`)
        .join("\n");
      entry.nightPending = [];
      try {
        const text = await sessions.generate(
          key,
          "（内部：你昨晚睡了，错过了下面这些消息。现在是早上，你刚醒。" +
            "用一两句话统一回一下——语气自然，别逐条机械回复，也别道歉太多。\n" +
            list +
            "）",
        );
        const content = String(text || "").trim();
        if (content) {
          const ev = entry.lastTarget;
          await client.sendHuman(ev, content);
          logger.info?.(`[onebot] 早上补回 ${key}（${pend.length} 条）：${content.slice(0, 40)}`);
          audit({ kind: "morning_catchup", key, count: pend.length, text: content.slice(0, 200) });
          markSeen(key, Number(ev.time) * 1000 || Date.now(), ev.message_id);
          flushSeen();
        }
      } catch (err) {
        logger.warn?.(`[onebot] 早上补回失败 ${key}：${err?.message ?? err}`);
      }
    }
  }

  function scheduleMorningCatchup() {
    if (!cfg.morningCatchup) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(cfg.morningCatchupHour) || 7, Number(cfg.morningCatchupMinute) || 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      void (async () => {
        try {
          await morningCatchup();
        } finally {
          scheduleMorningCatchup();
        }
      })();
    }, Math.max(60000, next - now)).unref?.();
    logger.info?.(`[onebot] 早上补回将在 ${next.toLocaleString("zh-CN")} 触发`);
  }

  // ── 她的一天：每晚总结发给主人 ─────────────────────────────
  async function dailyDiary() {
    if (cfg.dailyDiary === false) return;
    try {
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const st = summarizeDay(ymd) ?? {};
      const dialog = recentDialog(20);
      const picked = pickTarget();
      if (!picked) return;
      const text = await sessions.generate(
        picked[0],
        "（内部：现在是一天结束的时候，写一段你今天的日记，给主人看。" +
          "回顾今天：和谁聊了什么、看到什么有意思的事、有没有说错话、心情怎么样。" +
          "150 字以内，第一人称，像真人写日记，不要分点、不要总结成报告。）\n" +
          `【今天的数字】收到 ${st.inbound ?? 0} 条消息，回了 ${st.replies ?? 0} 条。\n` +
          (dialog ? `【今天的片段】\n${dialog}\n` : ""),
      );
      const content = String(text || "").trim();
      if (!content) return;
      await client.sendPrivate(cfg.ownerId, `今天我的一天：\n${content}`);
      logger.info?.(`[onebot] 已发送今日日记（${content.length} 字）`);
      audit({ kind: "daily_diary", text: content.slice(0, 200) });
    } catch (err) {
      logger.warn?.(`[onebot] 写日记失败：${err?.message ?? err}`);
    }
  }

  function scheduleDiary() {
    if (cfg.dailyDiary === false) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(cfg.dailyDiaryHour) || 23, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      void (async () => {
        try {
          await dailyDiary();
        } finally {
          scheduleDiary();
        }
      })();
    }, Math.max(60000, next - now)).unref?.();
    logger.info?.(`[onebot] 今日日记将在 ${next.toLocaleString("zh-CN")} 生成`);
  }

  // ── 自我反思：每天一次 ─────────────────────────────────────
  function recentDialog(limit = 12) {
    try {
      const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const recs = [];
      for (const line of lines) {
        if (!line.includes(ymd)) continue;
        try {
          const r = JSON.parse(line);
          if (r.kind === "inbound" || r.kind === "reply") recs.push(r);
        } catch {
          // 忽略
        }
      }
      return recs
        .slice(-limit)
        .map((r) => (r.kind === "inbound" ? `对方：${r.text}` : `我：${r.text}`))
        .join("\n");
    } catch {
      return "";
    }
  }

  async function dailyReflect() {
    if (!cfg.selfReflect) return;
    try {
      const picked = pickTarget();
      if (!picked) return;
      const dialog = recentDialog(12);
      const views = selfViews.render(6);
      const text = await sessions.generate(
        picked[0],
        "（内部：现在是你每天的自我复盘时间。下面是今天的一些对话片段和你已有的看法。\n" +
          (dialog ? `【今天的对话】\n${dialog}\n` : "") +
          (views ? `【你之前的看法】${views}\n` : "") +
          "想一想：1) 有没有哪句话说得不合适、太冲或太敷衍？2) 对某个人的态度要不要调整？" +
          "3) 你对某件事的看法有没有变？用两三句话写下来，像日记。只输出反思本身，不要解释。\n" +
          "如果你形成了新的明确看法，可以调 remember_self 记下来。）",
      );
      const content = String(text || "").trim();
      if (!content) return;
      selfViews.addReflection(content);
      logger.info?.(`[onebot] 今日反思：${content.slice(0, 60)}`);
      audit({ kind: "reflect", text: content.slice(0, 300) });
    } catch (err) {
      logger.warn?.(`[onebot] 反思失败：${err?.message ?? err}`);
    }
  }

  function scheduleReflect() {
    if (!cfg.selfReflect) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(cfg.reflectHour) || 22, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      void (async () => {
        try {
          await dailyReflect();
        } finally {
          scheduleReflect();
        }
      })();
    }, Math.max(60000, next - now)).unref?.();
    logger.info?.(`[onebot] 自我反思将在 ${next.toLocaleString("zh-CN")} 触发`);
  }

  // ── token 用量告警 ─────────────────────────────────────────
  let tokenAlertDay = "";
  function checkTokenBudget() {
    const limit = Number(cfg.tokenDailyAlert) || 5000000;
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (tokenAlertDay === ymd) return;
    const st = summarizeDay(ymd);
    if (!st || st.totalTokens < limit) return;
    tokenAlertDay = ymd;
    void client
      .sendPrivate(
        cfg.ownerId,
        `今天的 token 用量到 ${(st.totalTokens / 10000).toFixed(1)} 万了，超过你设的 ${(limit / 10000).toFixed(0)} 万。\n` +
          `收到 ${st.inbound} 条、回了 ${st.replies} 条、主动开口 ${st.proactive} 次。\n` +
          `觉得吵可以跟我说「别主动了」。`,
      )
      .catch(() => {});
    audit({ kind: "token_alert", tokens: st.totalTokens });
  }

  // ── 自动压缩：只有会话文件超过阈值才压 ──────────────────────
  function findSessionFile(sid) {
    try {
      const base = join(HOME, ".dsh/sessions");
      for (const d of readdirSync(base)) {
        const f = join(base, d, String(sid), "session.v4.jsonl.zstd");
        if (existsSync(f)) return f;
      }
    } catch {
      // 找不到就算了
    }
    return null;
  }

  async function maybeCompactAll() {
    const limitMB = Number(cfg.compactThresholdMB) || 50;
    const compaction = ctx.get?.("compaction");
    if (!compaction?.compactNow) return;
    for (const [key, entry] of sessions.entries) {
      try {
        const f = findSessionFile(entry.sessionId);
        if (!f) continue;
        const mb = statSync(f).size / 1024 / 1024;
        if (mb < limitMB) continue;
        const agent = entry.handle?.agent;
        if (!agent) continue;
        logger.info?.(`[onebot] ${key} 的会话已 ${mb.toFixed(1)}MB，超过 ${limitMB}MB，开始压缩`);
        await compaction.compactNow(agent, new AbortController().signal);
        audit({ kind: "compact", key, mb: Number(mb.toFixed(1)) });
        logger.info?.(`[onebot] ${key} 压缩完成（原文仍保留在 jsonl 里，可用 recall 检索）`);
      } catch (err) {
        logger.warn?.(`[onebot] 压缩 ${key} 失败：${err?.message ?? err}`);
      }
    }
  }

  auditEnabled = cfg.auditLog !== false;
  rotateAudit();
  audit({ kind: "boot", selfId: cfg.selfId, ownerId: cfg.ownerId });

  // 等预热完成后启动定时器（避免太早没有可用会话）
  setTimeout(() => {
    if (!agentReady) {
      agentReady = true;
      logger.warn?.("[onebot] 60 秒未成功回复，强制放行暂存消息");
      const queued = pendingWhileBooting.splice(0);
      for (const qev of queued) {
        // 暂存时已进过 recentIds，重放前清掉，否则会被去重挡回
        try {
          recentIds.delete(String(qev.message_id ?? ""));
        } catch {
          // 忽略
        }
        void client.onEvent(qev).catch(() => {});
      }
    }
  }, 60000).unref?.();

  setTimeout(() => {
    scheduleProactive();
    scheduleDailyBrief();
    scheduleQzone();
    scheduleReflect();
    scheduleMorningCatchup();
    scheduleDiary();
  }, 20000).unref?.();

  setInterval(() => {
    try {
      checkSoloStreak();
    } catch (err) {
      logger.warn?.(`[onebot] 连发检查失败：${err?.message ?? err}`);
    }
  }, 60000).unref?.();

  setInterval(() => {
    try {
      checkQuietGroups();
    } catch (err) {
      logger.warn?.(`[onebot] 冷群检查失败：${err?.message ?? err}`);
    }
  }, 10 * 60 * 1000).unref?.();

  setInterval(() => {
    void maybeCompactAll();
  }, Math.max(5, Number(cfg.compactCheckMinutes) || 30) * 60 * 1000).unref?.();

  setInterval(() => {
    void pollMissedMentions();
  }, Math.max(60, Number(cfg.pollMentionsSeconds) || 120) * 1000).unref?.();

  setInterval(() => {
    void checkReminders().catch((err) => logger.warn?.(`[onebot] 提醒检查失败：${err?.message ?? err}`));
  }, 30000).unref?.();

  setInterval(() => {
    try {
      checkTokenBudget();
    } catch {
      // 忽略
    }
  }, 10 * 60 * 1000).unref?.();

  // 冷启动也补一次离线期间的 @（用 seen 进度避免重复）
  setTimeout(() => {
    void client.onReconnected?.();
  }, 10000).unref?.();

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
