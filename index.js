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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { SessionId } from "@deepseek-ai/dsh-session";
import { zstdDecompressSync } from "node:zlib";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "dsh-onebot-bridge";
/** 不 inject：全部走 ctx.get() 兜底 */
export const inject = [];

const HOME = process.env.HOME || homedir();
const CONFIG_PATH = join(HOME, ".dsh/onebot-bridge/config.json");

// 风控节流的全局计数：最近发出的时间戳 + 上次发送时间
const SEND_STATE = { recent: [], lastAt: 0 };
function noteSent() {
  const now = Date.now();
  SEND_STATE.lastAt = now;
  SEND_STATE.recent.push(now);
  if (SEND_STATE.recent.length > 400) SEND_STATE.recent.splice(0, SEND_STATE.recent.length - 400);
}
/** 按「最近 1 分钟 + 最近 10 分钟」的自身发送量，决定这一条要等多久 */
function pickBaseDelay(cfg) {
  const now = Date.now();
  const recent = SEND_STATE.recent;
  let r60 = 0;
  let r600 = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const dt = now - recent[i];
    if (dt < 60_000) r60 += 1;
    if (dt < 600_000) r600 += 1;
    else break;
  }
  const idleMs = Number(cfg.replyBaseIdleMs ?? 350) || 350;
  if (r60 >= 15) return 4000;
  if (r60 >= 10) return 3000;
  if (r60 >= 6) return 2000;
  if (r60 >= 3) return r600 > 10 ? 1600 : 1400;
  if (r60 >= 1) return r600 > 10 ? 1100 : 900;
  if (r600 <= 2) return idleMs;
  if (r600 <= 10) return 600;
  return 900;
}

/** 同时说话的群多、或最近发得太密 → 额外多等一会儿，把发送曲线拉平 */
function backlogDelay(cfg) {
  const now = Date.now();
  SEND_STATE.recent = SEND_STATE.recent.filter((t) => now - t < 30000);
  const n = SEND_STATE.recent.length;
  let extra = 0;
  if (n > 6) extra += Math.min(6000, (n - 6) * 400);
  const gap = Number(cfg.minSendGapMs ?? 1200) || 0;
  const wait = Math.max(0, gap - (now - SEND_STATE.lastAt));
  return { extra, wait, perMin: n };
}

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
  compactThresholdMB: 5,
  compactCheckMinutes: 30,
  /** 当日 token 超过这个数就私聊提醒 */
  tokenDailyAlert: 50000000,
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
  /** 主动行为的活跃时段：9-23 点之外不主动开口 */
  activeStartHour: 9,
  activeEndHour: 23,
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
      images.push({
        url: String(data.url || data.file || ""),
        file: String(data.file || ""),
        summary: String(data.summary || ""),
      });
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
      if (wasReconnect) this.noteOutage("up");
      // 补回复要等 agent 就绪再跑（状态由外部注入，类里看不到 apply 的局部变量）
      setTimeout(() => {
        void (async () => {
          for (let i = 0; i < 15; i++) {
            if (this.readyFn?.() === true) break;
            await sleep(2000);
          }
          if (this.readyFn?.() !== true) {
            this.logger?.warn?.("[onebot] agent 仍未就绪，仍然尝试补回复");
          }
          try {
            this.onReconnected?.();
          } catch (err) {
            this.logger?.warn?.(`[onebot] 补回复触发失败：${err?.message ?? err}`);
          }
        })();
      }, 10000).unref?.();
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
      if (wasConnected) {
        this.logger?.warn?.("[onebot] 连接断开");
        this.noteOutage("down");
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close 事件会跟着来，这里只降噪
    });
  }

  /** 立刻重连（端口探活发现服务起来时用） */
  reconnectNow() {
    if (this.stopped || this.connected) return;
    try {
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          // 忽略
        }
        this.ws = null;
      }
      this.retry = 0;
      this.connect();
    } catch {
      // 忽略
    }
  }

  /** 记录掉线（由外部注入持久化逻辑） */
  noteOutage(kind) {
    try {
      this.onOutage?.(kind, Date.now());
    } catch {
      // 忽略
    }
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
    // 私聊防纠缠：上一句已经是她说的、对方还没出声，就不再追加
    // （正常回复时 lastSpeaker 刚被 onEvent 置为 "them"，不会误拦）
    if (ev.message_type !== "group" && !opts.force) {
      try {
        const k = conversationKey(ev);
        const ent = sessions.entries.get(k);
        if (ent && ent.lastSpeaker === "me") {
          this.logger?.info?.(`[onebot] 私聊里她刚说完、对方还没回，跳过追加：${k}`);
          audit({ kind: "dm_no_piggyback", key: k, text: String(text).slice(0, 80) });
          return;
        }
      } catch {
        // 忽略
      }
    }
    // 节奏：普通模式按长度自适应；风控模式固定先「想」约 2 秒，再看拥堵加长
    const len = String(text || "").length;
    let delay;
    if (this.cfg.riskMode === false) {
      if (len <= 6) delay = 150 + Math.random() * 350;
      else if (len <= 40) delay = 600 + Math.random() * 900;
      else if (len <= 120) delay = 1100 + Math.random() * 1300;
      else delay = 1800 + Math.random() * 2000;
    } else {
      // 双窗口自适应：空闲 350ms，高峰可到 4000ms + 拥堵加成
      const base = pickBaseDelay(this.cfg);
      const back = backlogDelay(this.cfg);
      delay = base * (0.85 + Math.random() * 0.3) + Math.min(3000, len * 10) + back.extra + back.wait;
      if (base <= 400) this.logger?.debug?.(`[onebot] 空闲期快速回（${Math.round(delay)}ms）`);
    }
    if (delay > 0) await sleep(delay);
    // 她自己写的 [split]：拆成两条发（群里忽略，群里连发是风控红线）
    let segs = [String(text || "")];
    if (/\[split\]/i.test(segs[0]) && ev?.message_type !== "group") {
      segs = segs[0]
        .split(/\[split\]/i)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 2);
      this.logger?.info?.(`[onebot] 她自己拆成 ${segs.length} 条发`);
    } else {
      segs[0] = segs[0].replace(/\[split\]/gi, " ");
    }

    const parts = [];
    for (const seg of segs) {
      for (const piece of splitMessage(seg, this.cfg)) {
        parts.push(humanizePunct(piece));
      }
    }
    await this.typing(ev);
    try {
      const k0 = conversationKey(ev);
      const ent0 = sessions.entries.get(k0);
      if (ent0) ent0.lastSpeaker = "me";
    } catch {
      // 忽略
    }
    for (let i = 0; i < parts.length; i++) {
      // 她自己拆的段落之间多等一会儿（像打完一条想一下），机器切的多等少
      const isSelfSplit = Array.isArray(segs) && segs.length > 1;
      if (i > 0) await sleep(isSelfSplit ? 1000 + Math.random() * 2000 : 500 + Math.random() * 900);
      const sent = await this.sendText(ev, parts[i], {
        quote:
          !!this.cfg.quoteInGroup &&
          ev.message_type === "group" &&
          i === 0 &&
          opts.quote !== false &&
          !ev.__noQuote,
      });
      try {
        const mid = String(sent?.message_id ?? sent?.data?.message_id ?? "");
        if (mid) this.onSentMessage?.(mid);
      } catch {
        // 忽略
      }
      noteSent();
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
    // QQ 离线时不要抛错：调用方（比如主人指令）会整条崩掉，连普通对话都被吞。
    // 改成把内容推给 WebUI，至少主人能看到。
    if (!this.connected) {
      const txt = String(text || "");
      try {
        this.onOfflineText?.(txt);
      } catch {
        // 忽略
      }
      this.logger?.warn?.(`[onebot] QQ 离线，这条没发出去（已转 WebUI）：${txt.slice(0, 40)}`);
      return Promise.resolve({ message_id: `offline-${Date.now()}`, offline: true });
    }
    return this.call("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "text", data: { text } }],
    });
  }

  /** 发一张本地图片（表情包） */
  sendImage(ev, filePath, opts = {}) {
    // WebUI 来的：把图存成静态文件，推给浏览器（不发 QQ）
    if (ev?.__fromWebUI) {
      try {
        this.onWebImage?.(filePath);
      } catch {
        // 忽略
      }
      return Promise.resolve({ message_id: `webui-img-${Date.now()}` });
    }
    let imgSeg;
    try {
      const b64 = readFileSync(filePath).toString("base64");
      imgSeg = { type: "image", data: { file: `base64://${b64}` } };
    } catch {
      imgSeg = { type: "image", data: { file: `file://${filePath}` } };
    }
    const seg = [];
    // 表情也能「引用某条消息」——想直接回应谁就带 quote
    if (opts.quote && ev.message_id) {
      seg.push({ type: "reply", data: { id: String(ev.message_id) } });
    }
    seg.push(imgSeg);
    return ev.message_type === "group"
      ? this.call("send_group_msg", { group_id: ev.group_id, message: seg })
      : this.call("send_private_msg", { user_id: ev.user_id, message: seg });
  }

  sendText(ev, text, opts = {}) {
    // WebUI 来的消息：不发给 QQ，推给浏览器（类方法访问不到外层，用回调）
    if (ev?.__fromWebUI) {
      try {
        const raw = String(text || "");
        const pieces = raw
          .split(/\[split\]/i)
          .map((x) => x.trim())
          .filter(Boolean);
        for (const p of pieces.length ? pieces : [raw]) {
          this.onWebReply?.(p);
        }
      } catch {
        // 忽略
      }
      return Promise.resolve({ message_id: `webui-reply-${Date.now()}` });
    }
    const segs = [];
    if (opts.quote && ev.message_id) {
      segs.push({ type: "reply", data: { id: String(ev.message_id) } });
    }
    // 文本里的 [face:14] 转成 QQ 原生小黄脸，其余照常是文本
    for (const part of String(text ?? "").split(/(\[face:\d{1,3}\])/g)) {
      if (!part) continue;
      const fm = /^\[face:(\d{1,3})\]$/.exec(part);
      if (fm) segs.push({ type: "face", data: { id: fm[1] } });
      else segs.push({ type: "text", data: { text: part } });
    }
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
const REFUSE_PATH = join(HOME, ".dsh/onebot-bridge/refusals.json");

/** 她声明「不再回复」的人：QQ号 -> { until, reason, key, at } */
let refuseState = {};
try {
  if (existsSync(REFUSE_PATH)) refuseState = JSON.parse(readFileSync(REFUSE_PATH, "utf8")) || {};
} catch {
  refuseState = {};
}
function isRefused(uid) {
  const rec = refuseState[String(uid)];
  return !!(rec && Number(rec.until || 0) > Date.now());
}
function refusePerson(uid, minutes, meta = {}) {
  refuseState[String(uid)] = {
    until: Date.now() + Math.max(5, Number(minutes) || 120) * 60_000,
    reason: String(meta.reason ?? "").slice(0, 80),
    key: String(meta.key ?? ""),
    at: Date.now(),
  };
  try {
    writeFileSync(REFUSE_PATH, JSON.stringify(refuseState, null, 1));
  } catch {
    // 写不进去也不影响本次生效
  }
  return refuseState[String(uid)];
}
const seenState = (() => {
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf8"));
  } catch {
    return {};
  }
})();
let seenDirty = false;

/** 清掉孤立代理项：slice 截断可能把 emoji 切成半个，发到 API 会 400 */
function stripLoneSurrogates(input) {
  const s = String(input ?? "");
  if (!s) return s;
  try {
    // 先按码点规整，再去掉落单的代理
    return s
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  } catch {
    // 环境不支持 lookbehind 时退化为只处理高位
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  }
}

/** 按码点安全截断，不会切开 emoji */
function safeSlice(input, max) {
  const s = String(input ?? "");
  if (s.length <= max) return s;
  try {
    const arr = Array.from(s);
    return arr.slice(0, max).join("");
  } catch {
    return s.slice(0, max);
  }
}

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
/** 日期键：n 天前（负数）/ 后 */
function ymdOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + (Number(days) || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** 说说正文清洗：去掉开头残留的逗号/引号 */
function cleanQzone(text) {
  return String(text || "")
    .trim()
    .replace(/^[，。、；：:!！?？~～…\s"'“”‘’「」【】]+/, "")
    .replace(/["'“”‘’]$/, "")
    .trim();
}
/** 是不是在复述素材：按 5 字窗口的重合比例判断 */
function parrotOf(text, source) {
  const norm = (s) => String(s || "").replace(/[\s，。、；：:!！?？~～…"'“”‘’（）()【】\[\]]/g, "");
  const t = norm(text);
  const s = norm(source);
  if (!t || s.length < 8) return false;
  let hit = 0;
  let tot = 0;
  for (let i = 0; i + 5 <= s.length; i += 3) {
    tot += 1;
    if (t.includes(s.slice(i, i + 5))) hit += 1;
  }
  return tot >= 2 && hit / tot >= 0.55;
}

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
    this.save();
    return t;
  },
  /** 反思时改写某条旧想法：按原文精确匹配，匹配不到就按「包含」找 */
  revise(oldText, newText) {
    const o = String(oldText || "").trim();
    const t = String(newText || "").trim().slice(0, 60);
    if (!o || !t || SENSITIVE.test(t)) return null;
    this.load();
    let idx = this.data.findIndex((v) => v.text === o);
    if (idx < 0) idx = this.data.findIndex((v) => v.text.includes(o));
    if (idx < 0) return null;
    const before = this.data[idx].text;
    this.data[idx] = { text: t, at: Date.now() };
    this.save();
    return { before, after: t };
  },
  /** 反思时删掉某条想法（不确定的、过时的、不认同的） */
  remove(text) {
    const o = String(text || "").trim();
    if (!o) return null;
    this.load();
    let idx = this.data.findIndex((v) => v.text === o);
    if (idx < 0) idx = this.data.findIndex((v) => v.text.includes(o));
    if (idx < 0) return null;
    const [gone] = this.data.splice(idx, 1);
    this.save();
    return gone?.text ?? null;
  },
  /** 注入用：默认全量（按字数预算从新往旧取），也可只取最近 n 条 */
  render(n = 0) {
    this.load();
    const list = this.data.filter((v) => !SENSITIVE.test(v.text));
    const picked = n > 0 ? list.slice(-n) : list;
    const budget = 1200;
    const out = [];
    let used = 0;
    for (let i = picked.length - 1; i >= 0; i--) {
      const t = picked[i].text;
      if (out.length && used + t.length + 1 > budget) break;
      out.unshift(t);
      used += t.length + 1;
    }
    return out.join("；");
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
  touch(userId, name, groupId, text) {
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
      const gid = String(groupId);
      rec.groups = Array.isArray(rec.groups) ? rec.groups : [];
      if (!rec.groups.includes(gid)) rec.groups.push(gid);
      // 跨群发言摘要：每人每群留最近 3 条
      const t = String(text || "").trim();
      if (t) {
        rec.recentByGroup =
          rec.recentByGroup && typeof rec.recentByGroup === "object" ? rec.recentByGroup : {};
        const arr = Array.isArray(rec.recentByGroup[gid]) ? rec.recentByGroup[gid] : [];
        const last = arr[arr.length - 1];
        if (!last || last.text !== t.slice(0, 80)) {
          arr.push({ text: t.slice(0, 80), at: Date.now() });
          if (arr.length > 3) arr.shift();
          rec.recentByGroup[gid] = arr;
        }
      }
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

/** 按「文件名 m007」或「序号 7」定位一张表情（序号同「表情包列表」的顺序） */
function resolveSticker(dir, key) {
  try {
    const files = readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort();
    const k = String(key || "").trim();
    if (!k || !files.length) return null;
    const labels = loadStickerLabels(dir);
    let name = null;
    if (/^m\d+$/i.test(k)) {
      name = files.find((f) => f.replace(/\.[^.]+$/, "").toLowerCase() === k.toLowerCase()) ?? null;
    } else if (/^\d+$/.test(k)) {
      name = files[Number(k) - 1] ?? null;
    } else {
      name = files.find((f) => f.toLowerCase() === k.toLowerCase()) ?? null;
    }
    if (!name) return null;
    return { path: pathJoin(dir, name), name, tags: labels[name] || [] };
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
    this.readyFn = () => false;
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
  // 同一个 sessionId 的打开操作必须串行，否则会撞上「active write handle」
  async openAgent(sessionId) {
    const key = String(sessionId);
    if (!this._openLocks) this._openLocks = new Map();
    const prev = this._openLocks.get(key) ?? Promise.resolve();
    const run = prev.then(
      () => this._openAgentInner(key),
      () => this._openAgentInner(key),
    );
    this._openLocks.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }

  async _openAgentInner(sessionId) {
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      return await resume();
    } catch (err) {
      const msg = String(err?.message ?? err);
      // 会话被别的实例握着写锁：等一会儿再试，别立刻判失败
      if (/already owned by an active write handle/i.test(msg)) {
        for (let i = 0; i < 5; i++) {
          await wait(2500);
          try {
            return await resume();
          } catch (e2) {
            if (i === 4) throw e2;
          }
        }
      }
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
    entry.proactiveTurn = false; // 被动回复：由 sendHuman 发，turn/end 不要转发
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
    // content 绝不能为空数组，否则 API 会 400 并且永久污染会话
    const safeText = String(text ?? "").trim() || "（对方只发了非文字内容）";
    const blocks = [{ type: "text", text: safeText }];
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

  /** 用临时会话看一张图并描述（不占用当前对话的 agent） */
  async describeImage(image, question) {
    const agents = this.svc("agents");
    if (!agents) return "";
    const att = this.svc("attachments");
    if (!att) return "";
    const tmpId = `vision-${Date.now()}`;
    let agent = null;
    try {
      const setup = async (agentCtx) => {
        try {
          const presets = this.svc("agentPresets");
          if (presets?.mount) await presets.mount(agentCtx);
        } catch {
          // 忽略
        }
      };
      agent = await agents.create({
        sessionId: SessionId(tmpId),
        meta: { cwd: this.cfg.workspace },
        setup,
        agentOptions: this.agentOptions(),
      });
      const ref = await att.saveImage({ data: image.data, mediaType: image.mediaType });
      const session = agent.session;
      const firstSeq = session.seq;
      agent.followup(
        createUserMessage({
          content: [
            { type: "text", text: question || "这张图是什么？一两句话描述，别长篇。" },
            { type: "image", attachment: ref },
          ],
          source: { kind: "user" },
        }),
      );
      await withTimeout(agent.whenIdle(), 45000, "vision-turn");
      return String(extractReply(session, firstSeq) ?? "").trim();
    } catch (err) {
      this.logger?.warn?.(`[onebot] 看图失败：${err?.message ?? err}`);
      return "";
    } finally {
      try {
        await agent?.dispose?.();
      } catch {
        // 忽略
      }
    }
  }

  /** 静默回合：只让她想/记，不把任何内容发到 QQ */
  async runSilent(key, instruction) {
    const entry = await this.ensure(key);
    const job = entry.queue.then(async () => {
      if (!entry.handle) entry.handle = await this.openAgent(entry.sessionId);
      const agent = entry.handle.agent;
      await withTimeout(agent.whenIdle(), 20000, "silent-idle");
      entry.proactiveTurn = true;
      entry.proactiveQuote = false;
      entry.silentTurn = true; // 关键：turn/end 不发送
      const firstSeq = agent.session.seq;
      try {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: instruction }],
            source: { kind: "user" },
          }),
        );
        await withTimeout(agent.whenIdle(), 60000, "silent-turn");
        return extractReply(agent.session, firstSeq);
      } finally {
        entry.silentTurn = false;
      }
    });
    entry.queue = job.catch(() => {});
    return job;
  }

  /** 主动回合：让 agent 自己说一段，不进 inTurn（这样自发转发会把它发到 QQ） */
  async runProactive(key, instruction, triggerEv, opts = {}) {
    const entry = await this.ensure(key);
    const job = entry.queue.then(async () => {
      if (!entry.handle) entry.handle = await this.openAgent(entry.sessionId);
      const agent = entry.handle.agent;
      await withTimeout(agent.whenIdle(), 20000, "proactive-idle");
      entry.proactiveTurn = true; // 主动回合：turn/end 负责把话发出去
      // 记住是「哪条消息」触发的，发送时引用它，避免回错人
      entry.proactiveTarget = triggerEv || entry.lastTarget;
      // 热群插话是「加入正在进行的讨论」，引用某一条会显得突兀，默认不引用
      entry.proactiveQuote = opts.quote === true;
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
/** 句末标点拟人化：人类 87% 的聊天消息不加句号，短句尤其明显 */
function humanizePunct(input) {
  let t = String(input || "").trim();
  if (!t) return t;
  if (!/[。．]$/.test(t)) return t; // 本来就没中文句号，不动
  const len = t.length;
  // 短句统一不写句号（人类 87% 如此），只给长段保留——规则简单，风格才统一
  if (len <= 40) {
    t = t.slice(0, -1).trimEnd();
    t = t.replace(/[，,、]$/, "").trimEnd();
  }
  return t;
}


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

  // ── 风控模式（默认开；关掉恢复原有节奏） ──
  const RISK_OVERRIDES = {
    ratePerMinute: 2,
    ratePerUserHour: 8,
    followUpSeconds: 20,
    maxParts: 2,
    replyBaseMs: 2000,
  replyBaseIdleMs: 350,
  /** 她可以申请新功能，每天最多一次 */
  featureRequestEnabled: true,
  featureRequestCooldownHours: 24,
    minSendGapMs: 1200,
    quietTopicHours: 6,
    quietTopicPerDay: 1,
    quietNightQuiet: true,
    activeJoinPerMinute: 2,
    activeJoinCooldownMinutes: 90,
    soloStreakWaitSeconds: 3600,
    soloStreakPerDay: 2,
    proactiveMinMinutes: 180,
    proactiveMaxMinutes: 300,
    qzoneMinMinutes: 120,
    qzoneMaxMinutes: 240,
    qzonePerDayMax: 2,
    groupMergeWindowMs: 2000,
    mergeGroups: true,
  };
  const normalSnapshot = {};
  for (const k of Object.keys(RISK_OVERRIDES)) normalSnapshot[k] = cfg[k];
  function applyMode() {
    if (cfg.riskMode === false) {
      for (const k of Object.keys(RISK_OVERRIDES)) cfg[k] = normalSnapshot[k];
      return false;
    }
    for (const [k, v] of Object.entries(RISK_OVERRIDES)) cfg[k] = v;
    return true;
  }
  const riskOn = applyMode();
  logger.info?.(
    `[onebot] 模式：${riskOn ? "风控（默认，慢节奏）" : "普通"}｜每分 ${cfg.ratePerMinute} 条 / 每人每小时 ${cfg.ratePerUserHour} 次`,
  );
  const sessions = new SessionManager(ctx, cfg, logger);
  sessions.autoConfigure = (sid) => autoConfigurePlugins(sid);
  sessions.restoreRuntime = (entry) => restoreRuntime(entry);
  sessions.isAgentReady = () => agentReady;
  const client = new OneBotClient(cfg, logger);
  client.readyFn = () => agentReady;
  client.onOutage = (kind, ts) => noteOutageFromClient(kind, ts);
  client.onWebReply = (text) => webPush({ role: "her", text });
  // QQ 离线时，本该私聊发出的内容改成推到 WebUI
  client.onOfflineText = (text) => {
    try {
      webPush({ role: "her", text: String(text || "").slice(0, 2000) });
    } catch {
      // 忽略
    }
  };

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

  let lastInbound = null;
  let pendingPromptForDiag = "";
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

  /** 两句中文的二元组重合率，用来判断「这句是不是在接上一句」 */
  function textOverlaps(a, b) {
    try {
      const norm = (x) => String(x || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
      const A = norm(a);
      const B = norm(b);
      if (A.length < 4 || B.length < 4) return false;
      const grams = new Set();
      for (let i = 0; i < B.length - 1; i++) grams.add(B.slice(i, i + 2));
      let hit = 0;
      for (let i = 0; i < A.length - 1; i++) {
        if (grams.has(A.slice(i, i + 2))) hit += 1;
      }
      return hit / Math.max(1, A.length - 1) >= 0.2;
    } catch {
      return false;
    }
  }

  /** 这个群有没有还没过期的续聊窗口（返回窗口目标用户，没有就 null） */
  function activeWindowTarget(key, excludeUserId) {
    const map = followUps.get(key);
    if (!map) return null;
    const now = Date.now();
    for (const [who, rec] of map.entries()) {
      if (who === "*") continue;
      if (now >= rec.until) continue;
      if (excludeUserId && who === String(excludeUserId)) continue;
      return who;
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

  /** 换目标时关掉旧目标的续聊窗口（其他窗口不动） */
  function closeWindowFor(key, userId) {
    const map = followUps.get(key);
    if (!map) return;
    map.delete(String(userId));
  }

  const switchJudgeAt = new Map();

  /**
   * 两步判断：A 旧目标是否已经不再跟她说话；B 新来这句是否冲她说的。
   * 只多一次内部调用，输出 A=是/否 B=是/否。
   */
  async function judgeSwitchTalk(key, oldId, newId, newName, newText, lastReplyText) {
    try {
      let oldName = String(oldId);
      try {
        people.load();
        oldName = people.data[String(oldId)]?.name || oldName;
      } catch {
        // 忽略
      }
      const prompt =
        "（内部判断，不要发给任何人。只输出两行：A=是/否，B=是/否）\n" +
        `A：上一位「${oldName}」是不是已经不再跟你说话了（他最后那句不是冲你说的，或者他转去跟别人聊了）？\n` +
        (lastReplyText ? `你上一条对他的回复是：「${lastReplyText}」\n` : "") +
        `B：现在「${newName}」说「${newText}」。这句是不是**在接你刚才说的话**？\n` +
        "判断标准放宽一点：只要他这句是在回应你上一条（哪怕是接你的话题、顺着你的话往下说、"+ 
        "回答你的问题、或者对你说的事做评价），就算「是」。只有明显是在跟别人聊、跟你无关时才算「否」。\n" +
        "只输出：\nA=是/否\nB=是/否";
      const raw = String((await sessions.runSilent(key, prompt)) ?? "");
      const a = raw.match(/A\s*[=:：]\s*(是|否|yes|no)/i);
      const b = raw.match(/B\s*[=:：]\s*(是|否|yes|no)/i);
      if (!a || !b) return false;
      const yes = (m) => /^(是|yes)$/i.test(String(m?.[1] ?? ""));
      return yes(a) && yes(b);
    } catch {
      return false;
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
    "save_sticker",
    "draw_image",
    "draw_svg",
    "hot_news",
    "at_person",
    "recall",
    "read_forward_more",
    "remember_fact",
    "remember_person",
    "remember_self",
    "request_feature",
    "my_outages",
    "my_status",
    "my_memory",
    "person_dossier",
    "group_recap",
    "who_said",
    "view_avatar",
    "my_changelog",
    "my_source",
    "my_adventures",
    "my_digest",
    "memory_index",
    "exec_sandbox",
    "read_source",
    "note_want",
    "my_wants",
    "resolve_want",
    "drop_want",
    "my_activities",
    "my_capabilities",
    "my_schedule",
    "owner_commands",
    "group_impressions",
    "my_thoughts",
    "run_activity",
    "set_reminder",
    "write_notebook",
    "read_notebook",
    "read_pdf",
    "propose_patch",
    "my_patch_proposals",
    "render_page",
    "add_webui_button",
    "remove_webui_button",
    "list_stickers",
    "refuse_person",
    "send_face",
    "revise_self",
    "forget_self",
    // 只读网络：查天气/新闻这类需求要靠它，安全但限频
    "web_search",
    "web_fetch",
  ]);

  // 搜索类工具按小时限频，避免她一句话查十次
  const searchTimes = [];
  function searchRateOk() {
    // searchPerHour <= 0 表示不限
    const limit = Number(cfg.searchPerHour ?? 0);
    if (!(limit > 0)) return true;
    const now = Date.now();
    while (searchTimes.length && now - searchTimes[0] > 3600_000) searchTimes.shift();
    if (searchTimes.length >= limit) return false;
    searchTimes.push(now);
    return true;
  }
  if (cfg.toolWhitelist !== false) {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const name = String(exec?.name ?? exec?.call?.name ?? exec?.tool?.name ?? "");
      if (!name) return next();
      if (ALLOWED_TOOLS.has(name)) {
        if ((name === "web_search" || name === "web_fetch") && !searchRateOk()) {
          logger.warn?.(`[onebot] 搜索太频繁，本次拒绝：${name}`);
          return { kind: "deny", reason: "这一小时查得够多了，先凭印象回答或者直说不知道。" };
        }
        return next();
      }
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
            "你的上下文会被定期压缩（节省开销），压缩掉的细节都还在这里，需要时尽管查。" +
            "query 填关键词（如「显卡」「书名」「那个约定」），会返回最相关的几条原文片段。",
          parameters: {
            query: { type: "string", description: "关键词，2-10 个字" },
            all_sessions: { type: "boolean", description: "是否连其他群/私聊一起搜（默认只搜当前会话）" },
            only_user: {
              type: "boolean",
              description: "只搜对方说的原话（要核对「他当时到底怎么说的」时用）",
            },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = exec?.agent?.session?.id;
            const cross = args?.all_sessions === true && cfg.recallCrossSession;
            const res = await recallSearch(sid, args?.query ?? "", {
              cross,
              onlyUser: args?.only_user === true,
            });
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

  // 反思时用：改写 / 删除已经过时的想法（记忆没有上限，但允许自己修正）
  void (async () => {
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "revise_self",
          description:
            "改写你自己以前记下的一条想法（想法变了、说法过时了、或者想说得更准）。old 填原来那句（能对上就行，不必一字不差），new 填新的一句话。",
          parameters: {
            old: { type: "string", description: "原来那句话（或其中一小段）" },
            new: { type: "string", description: "改成什么，30 字内" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const r = selfViews.revise(String(args?.old ?? ""), String(args?.new ?? ""));
            return r ? { ok: true, ...r } : { ok: false, reason: "没找到那条想法，或新内容为空/含敏感信息" };
          },
        }),
      );
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "forget_self",
          description:
            "删掉你自己以前记下的一条想法（不再认同、已经不成立了）。只删真正过时的，不用为了腾地方删——想法可以无限累积。",
          parameters: { text: { type: "string", description: "要删的那句话（或其中一小段）" } },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const gone = selfViews.remove(String(args?.text ?? ""));
            return gone ? { ok: true, deleted: gone } : { ok: false, reason: "没找到那条想法" };
          },
        }),
      );
      logger.info?.("[onebot] 想法修正工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 想法修正工具注册失败：${err?.message ?? err}`);
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
    // 存表情每小时限频用的时间戳（此前漏了声明，save_sticker 必抛 ReferenceError）
    const savedStickerTimes = [];
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
            },
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
              const want = String(args?.name ?? "").trim();
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
          execute: async (args) => {
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
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = String(exec?.agent?.session?.id ?? "");
            const entry = sid ? sessions.bySessionId(sid) : null;
            const seen = Array.isArray(entry?.currentTurnImages) ? entry.currentTurnImages : [];
            const imgs = seen.length ? seen : (entry?.lastImages ?? []);
            const idx = Math.max(0, (Number(args?.which) || 1) - 1);
            const raw = imgs[idx];
            const url =
              typeof raw === "string" ? raw : String(raw?.url || raw?.file || "");
            if (!url) return { ok: false, reason: "这条消息里没有第 " + (idx + 1) + " 张图" };
            if (!seen.length && Date.now() - Number(entry?.lastImagesAt || 0) > 5 * 60_000) {
              return { ok: false, reason: "那张图我有点记不清了，你再发一次我看看" };
            }

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

      // 功能申请：她可以提一次，由主人决定加不加
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "request_feature",
          description:
            "如果你发现自己缺某个能力（想存图但没工具、想查某个信息但没接口、想做某件事但做不到），" +
            "可以提一次功能申请给主人。**不要频繁**：一天最多一次，只有真的影响你做事的时候才提。" +
            "提之前先想想有没有现有工具能绕过去。",
          parameters: {
            idea: { type: "string", description: "你想要的新功能，一句话说清" },
            why: { type: "string", description: "为什么需要它（今天遇到了什么具体情况）" },
            how: { type: "string", description: "你猜大概怎么做（可选，不懂就写不知道）" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            if (cfg.featureRequestEnabled === false) {
              return { ok: false, reason: "主人关掉了这个通道" };
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
            return { ok: true, note: "已经发给主人了，等他判断" };
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
            const recent = outages.filter((o) => now - o.upAt < 24 * 3600_000);
            if (!recent.length) {
              return {
                ok: true,
                count: 0,
                recentlyDown: outageDownAt > 0,
                note:
                  outageDownAt > 0
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
            if (outageDownAt > 0) {
              const mins = Math.max(1, Math.round((Date.now() - outageDownAt) / 60000));
              items.push({
                from: fmt(new Date(outageDownAt)),
                to: "现在",
                minutes: mins,
                ongoing: true,
              });
            }
            const totalMin = items.reduce((a, b) => a + b.minutes, 0);
            audit({ kind: "check_outages", count: items.length, ongoing: outageDownAt > 0 });
            return {
              ok: true,
              count: items.length,
              totalMinutes: totalMin,
              recentlyDown: outageDownAt > 0,
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
              outagesToday: outages.filter((o) => new Date(o.upAt).toDateString() === today).length,
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
            "翻自己的记忆。type 可选 people（人物）/ facts（事实）/ views（观点）/ reflections（反思）/" +
            "learnings（学到的）/ all（全都搜，每条标来源）/ notebook（本子）。" +
            "query 可选关键词；all 模式会跨所有存储搜并标注每条来自哪儿。",
          parameters: {
            type: {
              type: "string",
              description: "people / facts / views / reflections / learnings / all / notebook",
            },
            query: { type: "string", description: "关键词，可不填" },
            limit: { type: "number", description: "all 模式下最多返回几条，默认 20" },
          },
          output: TOOL_OUT,
          execute: async (args) => {
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
              const push = (source, text, at) => {
                if (!text) return;
                if (q && !String(text).includes(q)) return;
                results.push({ source, text: String(text).slice(0, 300), at: at || 0 });
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
                for (const r of selfViews.reflections || []) push("反思", r.text, r.at);
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
              return {
                ok: true,
                type: "all",
                query: q,
                count: results.length,
                shown: Math.min(lim, results.length),
                items: results.slice(0, lim),
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
                  .map((f) => ({ file: f, text: readFileSync(join(NOTEBOOK_DIR, f), "utf8").slice(0, 2000) }))
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
            "查某个人：我和他聊过几次、在哪些群见过、他最近在各群说过什么、我对他有什么印象。" +
            "有人问「我们有几个共同群」「他刚才在别的群说了啥」就用这个。",
          parameters: { qq: { type: "string", description: "对方 QQ 号" } },
          output: TOOL_OUT,
          execute: async (args) => {
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
            return {
              ok: true,
              qq: id,
              name: r.name || id,
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
          execute: async (args) => {
            const gid = String(args?.gid ?? "").trim();
            const key = `group:${gid}`;
            const ent = sessions.entries.get(key);
            if (!ent) return { ok: false, reason: `没有群 ${gid} 的会话记录` };
            const win = ent.topicWindow ?? [];
            const cnt = new Map();
            for (const it of win) for (const w of it.w || []) cnt.set(w, (cnt.get(w) ?? 0) + 1);
            const topics = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
            const obs = (ent.observations ?? []).slice(-6);
            return {
              ok: true,
              group: groupLabel(gid),
              lastActive: ent.lastMessageAt
                ? new Date(ent.lastMessageAt).toLocaleString("zh-CN")
                : "未知",
              topics,
              recent: obs,
            };
          },
        }),
      );

      // 5. 谁说过 X
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "who_said",
          description:
            "跨群搜：谁在哪个群说过某个词（基于最近各群的发言摘要）。" +
            "想找「这话是谁说的」「哪个群聊过这个」时用。",
          parameters: { word: { type: "string", description: "要搜的词" } },
          output: TOOL_OUT,
          execute: async (args) => {
            const w = String(args?.word ?? "").trim();
            if (!w) return { ok: false, reason: "要搜什么词？" };
            people.load();
            const hits = [];
            for (const [id, r] of Object.entries(people.data)) {
              for (const [gid, arr] of Object.entries(r.recentByGroup || {})) {
                for (const it of arr) {
                  if (String(it.text).includes(w)) {
                    hits.push({
                      who: r.name || id,
                      qq: id,
                      where: groupLabel(gid),
                      when: new Date(it.at).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                      what: it.text,
                    });
                  }
                }
              }
            }
            hits.sort((a, b) => (b.when > a.when ? 1 : -1));
            return { ok: true, word: w, count: hits.length, hits: hits.slice(0, 10) };
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
            "别滥用——一天最多看几次，每次都会花一点算力。",
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
          execute: async (args) => {
            const path = join(HOME, ".dsh/onebot-bridge/CHANGELOG.md");
            let text = "";
            try {
              text = readFileSync(path, "utf8");
            } catch {
              try {
                text = readFileSync("/root/dev/dsh-onebot-bridge/CHANGELOG.md", "utf8");
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
            "看你自己的源码里某个函数/关键词是怎么实现的。有人问「你怎么做到的」「你的代码怎么写的」，或者你自己想确认某个行为时用。" +
            "只返回匹配到的片段，不是全文。",
          parameters: {
            keyword: { type: "string", description: "函数名或关键词，比如 window_handoff、humanizePunct" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const kw = String(args?.keyword ?? "").trim();
            if (kw.length < 3) return { ok: false, reason: "关键词至少 3 个字" };
            let src = "";
            try {
              src = readFileSync("/root/dev/dsh-onebot-bridge/index.js", "utf8");
            } catch {
              return { ok: false, reason: "读不到自己的源码" };
            }
            const lines = src.split("\n");
            const idxs = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(kw)) idxs.push(i);
              if (idxs.length >= 3) break;
            }
            if (!idxs.length) return { ok: false, reason: `源码里没找到「${kw}」` };
            const snippets = idxs.slice(0, 3).map((i) => ({
              line: i + 1,
              code: lines.slice(Math.max(0, i - 3), i + 12).join("\n").slice(0, 900),
            }));
            audit({ kind: "read_source", keyword: kw, hits: idxs.length });
            return { ok: true, keyword: kw, totalHits: idxs.length, snippets };
          },
        }),
      );
      logger.info?.("[onebot] 自我查看工具已注册（changelog/source）");

      // 翻自己的探险日志：我去过哪儿、当时怎么想的
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "my_adventures",
          description:
            "翻你自己出门走过的地方（每次自主探索的完整记录：看了什么、为什么往那儿走、当时想到什么）。" +
            "有人问你「最近在忙什么」「有什么新发现」，或者你自己想回顾时用。",
          parameters: {
            limit: { type: "number", description: "返回几条，默认 5" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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
          execute: async (args) => {
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
          execute: async (args) => {
            const mode = String(args?.mode ?? "topic").toLowerCase();
            const mems = loadMemLog(500);
            if (!mems.length) return { ok: true, count: 0, note: "记忆日志还是空的" };
            if (mode === "day") {
              const byDay = {};
              for (const m of mems) {
                const d = new Date(m.at).toLocaleDateString("zh-CN");
                byDay[d] = (byDay[d] || 0) + 1;
              }
              return { ok: true, mode, days: Object.entries(byDay).slice(-10) };
            }
            if (mode === "kind") {
              const byKind = {};
              for (const m of mems) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
              return { ok: true, mode, kinds: byKind };
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
        /\/root\/\.dsh/,
        /\/root\/dev/,
        /subprocess|os\.system|os\.popen/,
        /socket|requests|urllib|http\.client|fetch\(/,
        /\.\.\/\.\.\//,
        /chmod|chown|rm\s+-rf/,
      ];

      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "exec_sandbox",
          description:
            "在自己的沙箱里跑代码。可以算数、统计、处理文本、画图（matplotlib）、写小游戏、" +
            "联网抓东西（curl / requests 都行）。" +
            "沙箱是降权的（sandbox 用户），碰不到你的记忆和源码（那些是只读的）；不限时，但 CPU 时间有上限。" +
            "language 填 python 或 javascript；输出最多 4000 字。",
          parameters: {
            language: { type: "string", description: "python 或 javascript" },
            code: { type: "string", description: "要跑的代码" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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

            const dir = `/tmp/sbx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            try {
              mkdirSync(dir, { recursive: true });
              const file = lang === "javascript" ? "main.js" : "main.py";
              writeFileSync(join(dir, file), code);
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
                stdout: String(stdout || "").slice(0, 4000),
                stderr: String(stderr || "").slice(0, 1000),
              };
            } catch (err) {
              audit({ kind: "run_code", lang, ok: false, ms: Date.now() - now });
              return {
                ok: false,
                reason: String(err?.message ?? err).slice(0, 300),
                stdout: String(err?.stdout ?? "").slice(0, 2000),
                stderr: String(err?.stderr ?? "").slice(0, 1500),
              };
            } finally {
              try {
                execFileSync("rm", ["-rf", dir], { timeout: 5000 });
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
            "看你自己的源码。可以搜函数名/关键词，也可以按行号看一段。源码是只读副本，你只能看不能改。",
          parameters: {
            keyword: { type: "string", description: "要搜的关键词或函数名" },
            start: { type: "number", description: "起始行号（配合 count）" },
            count: { type: "number", description: "看多少行，默认 40" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            let src = "";
            try {
              src = readFileSync("/opt/fish-src/index.js", "utf8");
            } catch {
              return { ok: false, reason: "读不到源码副本" };
            }
            const lines = src.split("\n");
            const kw = String(args?.keyword ?? "").trim();
            if (kw) {
              const hits = [];
              for (let i = 0; i < lines.length && hits.length < 5; i++) {
                if (lines[i].includes(kw)) hits.push(i + 1);
              }
              if (!hits.length) return { ok: false, reason: `源码里没找到「${kw}」` };
              return {
                ok: true,
                totalLines: lines.length,
                hits: hits.map((ln) => ({
                  line: ln,
                  code: lines.slice(Math.max(0, ln - 4), ln + 10).join("\n").slice(0, 1200),
                })),
              };
            }
            const start = Math.max(1, Number(args?.start) || 1);
            const count = Math.max(1, Math.min(200, Number(args?.count) || 40));
            return {
              ok: true,
              totalLines: lines.length,
              from: start,
              code: lines.slice(start - 1, start - 1 + count).join("\n").slice(0, 6000),
            };
          },
        }),
      );
      logger.info?.("[onebot] 沙箱工具已注册（exec_sandbox/read_source）");

      // 需求记事本：想要什么随手记，主人有空再看
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "note_want",
          description:
            "把「我想要什么」记进记事本：感兴趣的网站要账号、缺的功能、想看的书/番…" +
            "随时可以记，不占额度。主人有空会看，恢复联络时会一起报给他。" +
            "kind 填 account（要账号）/ feature（要功能）/ other（其它）。",
          parameters: {
            kind: { type: "string", description: "account / feature / other" },
            what: { type: "string", description: "想要什么，一句话" },
            why: { type: "string", description: "为什么想要（遇到了什么具体场景）" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
            const kind = String(args?.kind ?? "other").toLowerCase();
            const what = String(args?.what ?? "").trim().slice(0, 150);
            const why = String(args?.why ?? "").trim().slice(0, 250);
            if (!what) return { ok: false, reason: "得先说想要什么" };
            const wants = loadWants();
            // 同一件事别重复记
            if (wants.some((w) => w.status === "pending" && w.what === what)) {
              return { ok: true, note: "这条已经记过了，等主人看" };
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
              note: `记下了。现在本子上有 ${pend} 条待处理，主人有空会看。`,
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
          execute: async (args) => {
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
          execute: async (args) => {
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
            "每条都有「当时想做什么」「为什么」「实际做了什么」「反思」。" +
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
          execute: async (args) => {
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
                kind: r.kind,
                kindLabel: KIND_LABEL[r.kind] || r.kind,
                wanted: cut(plan.intent, 100),
                why: cut(plan.why, 200),
                mood: String(plan.mood || ""),
                looked: Array.isArray(plan.looked) ? plan.looked : [],
                did: cut(r.content, 300),
                reflect: cut(r.reflect, 600),
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
            "列一下你自己会什么：能用的工具、能做的自主活动、能查的记忆、有什么限制。" +
            "有人问「你会什么」「你能做什么」「你有什么功能」时用它，别凭印象瞎说。",
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
            const nextAt = Number(st.selfActivityNextAt) || 0;
            const now = Date.now();
            const fmt = (t) => {
              const d = new Date(t);
              return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
            };
            let nextActivity = "还没安排（等下一次唤醒）";
            let nextIn = "";
            if (nextAt > now) {
              const mins = Math.round((nextAt - now) / 60000);
              nextActivity = `${fmt(nextAt)}（约 ${mins} 分钟后）`;
              nextIn = `${mins} 分钟`;
            } else if (nextAt > 0) {
              nextActivity = "时间已过，下次唤醒时就会动";
            }

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

      // 主人能发什么指令（她自己不知道这些，都是桥里写死的）
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "owner_commands",
          description:
            "查主人能对你发哪些指令。有人问「你能做什么」「有哪些指令」「怎么让你去探险」时用它，" +
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
              note: "这些都是主人在 QQ 私聊或网页里直接发的；她不需要「听懂」某个指令，桥会自己拦截处理。",
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
            "查你自己写下的观点和自省。有人问「你都有什么想法」「你反省过什么」时用。" +
            "which 填 views（观点，默认）或 reflections（自省）。",
          parameters: {
            which: { type: "string", description: "views（观点）/ reflections（自省），默认 views" },
            limit: { type: "number", description: "看几条，默认 20" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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

      // 让她能自己决定开始一轮活动（主人说「活动一下」「去探险」时由她自己调）
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "run_activity",
          description:
            "开始一轮自己的活动。主人说「活动一下」「去探险」「读点书」「玩会儿」「想想事」" +
            "「回忆一下」「憧憬一下」「研究代码」时，用这个开始，而不是嘴上答应。" +
            "kind 不填就自己挑一个。",
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
          execute: async (args) => {
            const kind = String(args?.kind ?? "").trim();
            const rounds = Math.max(1, Math.min(5, Number(args?.rounds) || 1));
            const VALID = ["explore", "read", "play", "think", "write", "recall", "dream", "study"];
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

      // 提醒（主人说「提醒我…」时由她自己设）
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "set_reminder",
          description:
            "给主人设一个提醒。他说「提醒我…」「到点告诉我…」时用。" +
            "minutes 填多少分钟后提醒（最少 1 分钟）",
          parameters: {
            minutes: { type: "number", description: "多少分钟后提醒" },
            what: { type: "string", description: "提醒什么事" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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
            "往你的本子上写东西。这是你自己的本子：写什么、怎么写都由你，不会被人整理成别的格式。" +
            "按天分文件，写进去就存住了，隔几晚翻回来还认得。",
          parameters: {
            text: { type: "string", description: "要写的内容（可以写很多）" },
            title: { type: "string", description: "小标题，可省略" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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
            "翻自己的本子。参数 date 填某天（2026-10-29），不填就看最近几天；days 控制看几天，默认 3。",
          parameters: {
            date: { type: "string", description: "某一天，格式 2026-10-29" },
            days: { type: "number", description: "看最近几天，默认 3" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args) => {
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
                  out.push({ file: f.split("/").pop(), text: readFileSync(f, "utf8").slice(0, 6000) });
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
          execute: async (args) => {
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
              return {
                ok: true,
                chars: txt.length,
                truncated: txt.length > 8000,
                text: txt.slice(0, 8000),
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

      // ── 改动申请：她想改代码时，写一份设计报告给主人，不自己动手 ──
      const PROPOSAL_DIR = join(HOME, ".dsh/onebot-bridge/patch-proposals");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "propose_patch",
          description:
            "你想改自己代码的时候用这个：写一份「改动申请」发给主人，由他来执行。" +
            "你改不了代码，但可以把想法说清楚——改哪一行、为什么改、会有什么影响、怎么验证、怎么撤。" +
            "写清楚原理，主人看了才敢动手。",
          parameters: {
            file: { type: "string", description: "要改哪个文件，比如 index.js / README.md" },
            where: { type: "string", description: "大概位置：函数名或行号附近，方便主人找" },
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
          execute: async (args) => {
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
              `由她于 ${d.toLocaleString("zh-CN")} 提出，等待主人执行。`,
              "",
            ]
              .filter(Boolean)
              .join("\n");

            try {
              mkdirSync(PROPOSAL_DIR, { recursive: true });
              writeFileSync(join(PROPOSAL_DIR, `${id}.md`), doc, "utf8");
              audit({ kind: "patch_proposal", id, file });
              // 推给主人的 WebUI，让他第一时间看到
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
                note: "已发给主人。他执行完会告诉你。",
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
          description: "看你提过哪些改动申请、主人执行了没有。",
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
                  if (d?.status === "done") status = "done";
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
                  ? `有 ${pending} 份还在等主人执行`
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
            "做一张网页给自己或主人看：展示统计、记录、记忆、时间线、想法都行。" +
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
          execute: async (args) => {
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
              note: "在 WebUI 里打开这个地址能看到；在 QQ 里主人得自己去 WebUI 看。",
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
            "① 填 prompt：点一下等于主人发一句话给你，你照着做；" +
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
          execute: async (args) => {
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
          execute: async (args) => {
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
            "只在真的受不了时用，别因为小摩擦就拒聊；对主人无效。",
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
            const target = entry?.lastTarget ?? lastInbound;
            const uid = String(target?.user_id ?? "");
            if (!uid) return { ok: false, reason: "不知道这次是针对谁，先别登记" };
            if (cfg.ownerId && uid === String(cfg.ownerId)) {
              return { ok: false, reason: "这是主人，不理他做不到" };
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
      } catch (err) {
        logger.warn?.(`[onebot] 表情包工具注册失败：${err?.message ?? err}`);
      }
    })();
  }

  // QQ 原生小黄脸：单独发一个（文字里想夹就用 [face:13] 标记）
  void (async () => {
    const faceTimes = [];
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      ctx.get?.("tools")?.register?.(
        defineTool({
          name: "send_face",
          description:
            "发一个 QQ 原生小黄脸（聊天框里那种黄脸），情绪到位时才用，平时少发。" +
            "常用编号：14微笑 13呲牙 21可爱 20偷笑 22白眼 27流汗 26惊恐 10尴尬 12调皮 16酷 " +
            "9大哭 6害羞 4得意 11发怒 15难过 32疑问 18抓狂 25困 76赞 79胜利 5流泪 30奋斗。" +
            "只想在文字中间夹一个的话，直接在回复里写 [face:13] 就行，不用调这个工具。",
          parameters: {
            id: { type: "number", description: "小黄脸编号，比如 13（呲牙）、21（可爱）" },
          },
          output: {
            schema: { type: "json" },
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            const sid = String(exec?.agent?.session?.id ?? "");
            const entry = sid ? sessions.bySessionId(sid) : null;
            const target = entry?.lastTarget ?? lastInbound;
            if (!target || (!target.group_id && !target.user_id)) {
              return { ok: false, reason: "当前没有 QQ 会话上下文" };
            }
            const id = Math.max(0, Math.min(400, Number(args?.id) || 0));
            const now = Date.now();
            while (faceTimes.length && now - faceTimes[0] > 3600_000) faceTimes.shift();
            const perHour = Number(cfg.facePerHour) || 6;
            if (faceTimes.length >= perHour) {
              return { ok: false, reason: "小黄脸发得有点多了，缓缓" };
            }
            if (faceTimes.length && now - faceTimes[faceTimes.length - 1] < 60_000) {
              return { ok: false, reason: "刚发过一个，先别连着发" };
            }
            const seg = [{ type: "face", data: { id: String(id) } }];
            await client.call(
              target.message_type === "group" ? "send_group_msg" : "send_private_msg",
              target.message_type === "group"
                ? { group_id: target.group_id, message: seg }
                : { user_id: target.user_id, message: seg },
            );
            faceTimes.push(now);
            audit({ kind: "face", id });
            return { ok: true, id };
          },
        }),
      );
      logger.info?.("[onebot] 小黄脸工具已注册");
    } catch (err) {
      logger.warn?.(`[onebot] 小黄脸工具注册失败：${err?.message ?? err}`);
    }
  })();

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
  async function statusText(dateStr) {
    const cnt = await ensureCounts();
    const d = new Date();
    const ymd = dateStr || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayLabel = dateStr ? ymd.slice(5) : "今天";
    const st = summarizeDay(ymd) ?? {};
    const mins = Math.floor(process.uptime() / 60);
    const muted = cfg.mutedUntil && Date.now() < cfg.mutedUntil;
    const lines = [
      `在线：${client.connected ? "是" : "否"}`,
      `好友：${cnt.friends} 人｜群：${cnt.groups} 个`,
      `会话：${sessions.entries.size} 个`,
      `${dayLabel}：收到 ${st.inbound ?? 0} 条，回了 ${st.replies ?? 0} 条`,
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
  /** 从桥的 prompt 里剥出「对方真正说的话」；纯内部提示返回空 */
  function extractRealInbound(raw) {
    const t = String(raw || "").trim();
    if (!t) return "";

    // ⚠️ 顺序很重要：先尝试提取真实消息，再判断是不是纯内部提示。
    // 因为真实的私聊 prompt 长这样：
    //   （QQ 聊天场景：像真人发消息一样简短…）
    //   [QQ私聊] 竹叶不知秋：你好
    // 开头是「（QQ 聊天」，但里面确实有真人说的话。
    const m1 = t.match(/\[消息内容\]\s*([\s\S]*?)(?:\n\[|$)/);
    if (m1 && m1[1].trim()) return m1[1].trim().slice(0, 400);

    const m3 = t.match(/\[(?:QQ群消息|QQ私聊|网页聊天)\][^：:\n]*[：:]\s*([\s\S]*)/);
    if (m3 && m3[1].trim()) return m3[1].trim().slice(0, 400);

    // DSH 自己注入的运行时说明，不是人说的话
    if (/^(Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding|Current runtime context|Current DSH file policy|Approval prompts are disabled|Current DeepSeek Harness implementation checkout|Current working directory)/i.test(t)) {
      return "";
    }
    if (/Time sampled while preparing|Browser time zone for this request|Current runtime context\. This snapshot supersedes/i.test(t) && t.length < 1200) {
      return "";
    }

    // 到这里说明没提取到真实消息 —— 再看是不是纯内部提示
    if (/^（(内部|这次|对方连着|QQ 聊天|你在|这是你|刚才|下面|想一想)/.test(t)) return "";
    if (
      /内部整理|内部反思|内部回顾|内部探索|不要发消息|不发给任何人|只输出/.test(t) &&
      t.length < 200
    ) {
      return "";
    }
    // 活动产出（JSON 计划之类）也不是对话
    if (/^\s*\{\s*"looked"/.test(t)) return "";

    // 兜底前先排掉 prompt 模板（这些不是人说的话）
    if (
      /（QQ 聊天[:：]|（QQ私聊[:：]|像真人发消息|长度要有变化|不要用 markdown|不要复述我的问题|只输出|不要发消息|点了智慧会发/.test(
        t,
      )
    ) {
      return "";
    }
    // 看起来就是正常对话
    if (t.length <= 400 && !/\[消息内容\]|\[群聊最近|\[你想起的\]|\[你自己的话\]/.test(t)) {
      return t;
    }
    return "";
  }

  /** 从事件里取文本；返回 { text, role }，role: "对方" / "我" */
  function textOfEvent(ev) {
    try {
      if (ev.type === "user/message") {
        const blocks = ev.data?.content ?? [];
        const raw = blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        // 桥发给她的 prompt 也记成 user/message，里面混着内部提示词。
        // 真正的对方消息在这里面：[消息内容] xxx 或 [QQ私聊] 名字：xxx
        const real = extractRealInbound(raw);
        if (!real) return { text: "", role: "" }; // 纯内部提示，不收
        return { text: real, role: "对方" };
      }
      if (ev.type === "assistant/message") {
        const blocks = ev.data?.message?.content ?? [];
        const text = blocks
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        return { text, role: "我" };
      }
    } catch {
      // 忽略
    }
    return { text: "", role: "" };
  }

  /** 在归档里搜关键词；返回最近若干条 */
  /** 列出会话文件（按修改时间倒序） */
  function listSessionFiles(limit = 20) {
    const base = join(HOME, ".dsh/sessions");
    const out = [];
    try {
      for (const d of readdirSync(base)) {
        const p = join(base, d);
        let subs = [];
        try {
          subs = readdirSync(p);
        } catch {
          continue;
        }
        for (const sid of subs) {
          const f = join(p, sid, "session.v4.jsonl.zstd");
          try {
            const st = statSync(f);
            out.push({ sid, file: f, mtime: st.mtimeMs });
          } catch {
            // 跳过
          }
        }
      }
    } catch {
      return [];
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit);
  }

  async function recallSearch(currentSid, query, opts = {}) {
    const keys = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((x) => x.length >= 2)
      .slice(0, 4);
    if (!keys.length) return { ok: false, reason: "关键词太短" };

    const all = listSessionFiles(opts.cross ? 20 : 8);
    let targets = [];
    if (currentSid) {
      const mine = all.find((x) => x.sid === String(currentSid));
      if (mine) targets.push(mine);
      if (opts.cross) targets = all;
      else targets = targets.length ? targets : all.slice(0, 2);
    } else {
      targets = all.slice(0, 2);
    }
    if (!targets.length) return { ok: false, reason: "找不到会话文件" };

    const hits = [];
    for (const t of targets) {
      try {
        const raw = zstdDecompressSync(readFileSync(t.file)).toString("utf8");
        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line || !line.includes(keys[0])) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          const got = textOfEvent(ev);
          const text = got.text;
          if (!text) continue;
          const low = text.toLowerCase();
          if (!keys.every((k) => low.includes(k))) continue;
          // 只搜对方原话时，跳过自己说的
          if (opts.onlyUser && got.role !== "对方") continue;
          hits.push({
            sid: t.sid,
            role: got.role,
            text: text.slice(0, 200),
            at: Number(ev.time) || Number(ev.ts) || 0,
          });
        }
      } catch (err) {
        logger.warn?.(`[onebot] 读会话失败 ${t.sid}：${err?.message ?? err}`);
      }
    }
    // 对方原话优先（她要核对自己有没有听错）
    hits.sort((a, b) => {
      const ra = a.role === "对方" ? 0 : 1;
      const rb = b.role === "对方" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.at - a.at;
    });
    return { ok: true, hits: hits.slice(0, Number(cfg.recallMaxHits) || 8) };
  }

  /** 把检索结果排成提示词片段 */
  function renderRecall(hits) {
    if (!hits?.length) return "";
    const lines = hits.map((h) => {
      const d = h.at ? new Date(h.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      const who = h.role ? `${h.role}：` : "";
      return `· [${d}] ${who}${h.text}`;
    });
    return `[你回忆起的事]\n${lines.join("\n")}\n\n`;
  }

  // 好友数 / 群数（5 分钟缓存）
  let countsCache = { at: 0, friends: 0, groups: 0 };
  async function ensureCounts() {
    if (Date.now() - countsCache.at < 5 * 60000 && countsCache.at) return countsCache;
    try {
      const [fl, gl] = await Promise.all([
        client.call("get_friend_list", {}, 8000).catch(() => []),
        client.call("get_group_list", {}, 8000).catch(() => []),
      ]);
      const fArr = Array.isArray(fl) ? fl : (fl?.data ?? []);
      const gArr = Array.isArray(gl) ? gl : (gl?.data ?? []);
      countsCache = {
        at: Date.now(),
        friends: Array.isArray(fArr) ? fArr.length : 0,
        groups: Array.isArray(gArr) ? gArr.length : 0,
      };
    } catch {
      // 拿不到就用旧值
    }
    return countsCache;
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
    if (!client.connected && reminders.some((r) => !r.done)) {
      // 掉线时不发提醒，等重连（提醒是“到点就发”，晚几分钟比丢了好）
      return;
    }
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
  let lastLengthTier = "";
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
      if (r < 0.5) {
        lastLengthTier = "问句短";
        return "（这轮短：10-25 个字，直接回答问题。）";
      }
      if (r < 0.85) {
        lastLengthTier = "问句中";
        return "（这轮中等：30-60 个字。）";
      }
      lastLengthTier = "问句长";
      return "（这轮可以长一点：80-150 字，分 2-3 条发也行。）";
    }
    if (r < 0.4) return "（这轮极短：1-8 个字，像随口应一声。）";
    if (r < 0.7) return "（这轮短：10-25 个字。）";
    if (r < 0.9) return "（这轮中等：30-60 个字。）";
    return "（这轮可以长一点：80-150 字，分 2-3 条发也行。）";
  }

  /** 今日统计报表 */
  async function statsText(dateStr) {
    await ensureGroupNames();
    const cnt = await ensureCounts();
    const d = new Date();
    const ymd = dateStr || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
      dateStr ? `${ymd} 统计` : `今日统计（截至 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}）`,
      `好友：${cnt.friends} 人｜群：${cnt.groups} 个｜会话：${sessions.entries.size} 个`,
      `消息：收 ${st.inbound ?? 0} / 回 ${st.replies ?? 0}｜token 约 ${((st.totalTokens ?? 0) / 10000).toFixed(1)} 万`,
      `主动：分享 ${top("proactive")} / 简讯 ${top("daily_brief")} / 说说 ${top("qzone") + top("qzone_manual")} / 冷群 ${top("quiet_topic")} / 热群 ${top("active_join")}`,
      `工具：表情包 ${top("sticker")} / 新闻 ${top("news")} / @人 ${top("at_person")} / 补回复 ${top("catchup") + top("poll_mention")}`,
      `异常：错误 ${top("error")}｜掉线 ${drops} 次${drops ? `（累计 ${downMinutes} 分钟${lastDrop ? "，最近 " + lastDrop : ""}）` : ""}`,
      groups.length ? `各群：\n${groups.map(([g, n]) => `· ${groupLabel(g)}：${n} 条`).join("\n")}` : "",
      `模式：${cfg.riskMode === false ? "普通" : "风控"}｜近 30 秒已发 ${SEND_STATE.recent.filter((x) => Date.now() - x < 30000).length} 条`,
      `限流：${st.limited ?? 0} 次`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** 完整功能与指令清单（给主人看的） */
  function helpText() {
    return [
      "【聊天】",
      "· 私聊随意；群里 @ 我 / 打「@昵称」必回",
      "· 只叫「肥鱼」「大鱼」→ 叫我必回；闲聊提到我 70% 接",
      "· 聊过一次后 1 分钟免 @ 续聊（≤5 轮）；10 秒内换人接手会先判断新旧目标",
      "· 懂图、看链接、展转发；情绪到了只发表情 / 小黄脸",
      "· 表情包列表 / 看表情 12 → 看库、看单张",
      "· 被难堪到底 → 声明不再理他，之后一段时间他 @ 也不回",
      "",
      "【记忆与查询】",
      "· 昨天状态 / 前天状态 / 状态 10-24 / 最近三天 → 历史数据",
      "· 印象深刻的人 / 对他们的印象",
      "· 你对 123456789 的印象 → 单人档案",
      "· 各个群的印象 → 这群干什么的、常聊什么、都是什么人、说话风格、氛围，熟的人排在最后",
      "· 群 123456789 你记得谁 / 你对群 123456789 的印象",
      "· 你都记得我什么",
      "· 你现在是什么样 → 性格、风格、记忆存量、自省",
      "· 全部想法 / 全部自省 → 完整清单（分条，不截断）",
      "· 事实、观点、反思一直累积，不冲掉旧的；她可自行改写或删除",
      "",
      "【她自己会做】",
      "· 热点：每 1–2 小时看心情说一句；每日 9 点简讯",
      "· 说说：120–240 分钟问一次要不要发，0–2 条/天，全看她心情",
      "· 内省每小时；反思 22 点；日记 23 点",
      "· 热群插话：≥2 条/分、我 10 分钟没参与、90 分钟没插过 → 可能插一句",
      "· 冷群找话题：6 小时没人说话才抛一次（每群每天 1 次；23–7 点不做）",
      "· 连发搭话：连发 3 条纯文字、等 60 分钟没人理 → 搭一句（每群每天 ≤2）",
      "· 好友申请：先私聊问你要不要通过",
      "· 风控模式（默认）：2 条/分、每人 8 次/时、先等 2 秒、合并回复、23–7 点静默",
      "",
      "【你可以直接对我说】",
      "· 状态 / 统计 / 发言统计 / 各群活跃 / 掉线记录 / 最近错误 / 插件状态",
      "· 闭嘴 / 安静半小时 → 静音；恢复说话 解除",
      "· 停下 → 打断回合｜用 low / 切到 high → 思考档位",
      "· 在 123456789 群说一句 xxx → 代你发（不带 @）",
      "· 去 123456789 @ 100000001 → 找某人搭话（一次）",
      "· 记住，我在上海 → 写进长期事实｜以后叫我主人 → 改称呼",
      "· 退群 123456789 → 退出（记忆保留）",
      "· 同意 / 拒绝 → 入群邀请；同意好友 / 拒绝好友 → 好友申请",
      "· 提醒我 明天9点 交周报；查看提醒 / 取消提醒",
      "· 风控模式 开/关 → 切换慢节奏 / 原节奏",
      "· 发条说说 / 发条说说：事情 → 她用自己的口吻发",
      "· 别主动了 / 可以主动了｜帮助 → 这张表",
      "",
      "【群里的规矩】",
      "· 只认 @、名字、续聊；风控 2 条/分、8 次/时；普通 6 条/分、30 次/时",
      "· 别人让我跑服务器命令一律拒，只有你能放行",
      "· 只有社交工具（表情/画图/新闻/搜网页/记事），无服务器权限",
      "· 搜网页 8 次/时；AI 画图 2 次/时；SVG 不限；存表情 3 张/时，库 300 张 / 30MB",

    ].join("\n");
  }

  /** 主人的自然语言控制：状态/打断/思考档位/群内发言/静音 */
  // ── 轮询好友申请（NapCat 不以 request 事件推送，只能主动查） ──
  const notifiedFriends = new Set();
  async function pollFriendRequests() {
    if (cfg.friendRequests === false) return;
    if (!client.connected) return;
    let arr = [];
    // 首选 NapCat 补丁暴露的 get_buddy_req（「联系人-好友通知」的数据源）
    try {
      const res = await client.call("get_buddy_req", {}, 8000);
      const list = res?.buddyReqs ?? res?.data?.buddyReqs ?? null;
      if (Array.isArray(list)) {
        arr = list
          .filter((r) => r && r.isDecide === false)
          .map((r) => ({
            uid: String(r.friendUid ?? ""),
            flag: String(r.friendUid ?? ""),
            reqTime: String(r.reqTime ?? ""),
            name: String(r.friendNick ?? "").trim(),
            message: String(r.extWords ?? "").trim(),
            groupCode: String(r.groupCode ?? ""),
            source: String(r.addSource ?? ""),
          }));
      }
    } catch {
      // 没有补丁就退回可疑申请接口
    }
    if (!arr.length) {
      try {
        const res = await client.call("get_doubt_friends_add_request", { count: 50 }, 8000);
        const raw = Array.isArray(res) ? res : (res?.data ?? []);
        if (Array.isArray(raw)) {
          arr = raw.map((r) => ({
            uid: String(r?.user_id ?? r?.uid ?? r?.uin ?? ""),
            flag: String(r?.flag ?? r?.user_id ?? ""),
            reqTime: String(r?.reqTime ?? ""),
            name: String(r?.nickname ?? r?.nick ?? "").trim(),
            message: String(r?.reason ?? r?.message ?? "").trim(),
            groupCode: String(r?.groupCode ?? ""),
            source: "可疑申请",
          }));
        }
      } catch (err) {
        logger.debug?.(`[onebot] 查好友申请失败：${err?.message ?? err}`);
      }
    }

    for (const r of arr) {
      const key = r.flag || r.uid || `${r.name}:${r.message}`;
      if (!key || notifiedFriends.has(key)) continue;
      notifiedFriends.add(key);
      pendingFriends.set(key, { ...r, at: Date.now() });
      logger.info?.(`[onebot] 发现好友申请：${r.name || r.uid}（${r.source || "未知来源"}）`);
      const where = r.groupCode ? `\n来自群：${r.groupCode}` : "";
      const text =
        `有人申请加我好友${r.name ? `：${r.name}` : ""}` +
        (r.uid ? `\n账号：${r.uid}` : "") +
        where +
        (r.message ? `\n验证消息：${r.message}` : "") +
        `\n\n回复「同意好友」或「拒绝好友」。`;
      if (cfg.ownerId) {
        await client.sendPrivate(cfg.ownerId, text);
        audit({ kind: "friend_request", uid: r.uid, name: r.name, msg: r.message });
      }
    }
  }

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

  /** 主人私聊指令：表情包清单 / 单独看某一张 */
  async function handleOwnerStickerCmd(ev, text) {
    if (!cfg.stickerEnabled || !cfg.stickerDir) return false;
    const t = String(text || "").trim();
    if (!t) return false;
    const filesNow = () => {
      try {
        return readdirSync(cfg.stickerDir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort();
      } catch {
        return [];
      }
    };

    if (/^(?:看看|查|列一下|列出|全部|所有)?\s*(?:我的|你的)?\s*(?:表情包?|表情)(?:列表|清单|库)?(?:都|全)?(?:有(?:哪些|什么|啥))?$/.test(t) && t.length <= 12) {
      try {
        const files = filesNow();
        if (!files.length) {
          await client.sendPrivate(ev.user_id, "库里还没有表情包。");
          return true;
        }
        const labels = loadStickerLabels(cfg.stickerDir);
        const lines = files.map(
          (f, i) =>
            `${i + 1}. ${f.replace(/\.[^.]+$/, "")}` +
            (labels[f]?.length ? `（${labels[f].join("/")}）` : ""),
        );
        const chunks = [];
        for (let i = 0; i < lines.length; i += 12) {
          chunks.push(
            `（${i + 1}-${Math.min(i + 12, lines.length)} / 共 ${lines.length} 张）\n` +
              lines.slice(i, i + 12).join("\n"),
          );
        }
        await client.sendPrivate(
          ev.user_id,
          `表情包共 ${files.length} 张（文件名编号有跳号，以这里的序号为准）。` +
            `看第几张发「看表情 序号」，按文件名看就发「看表情 m007」：\n${chunks[0]}`,
        );
        for (const c of chunks.slice(1)) await client.sendPrivate(ev.user_id, c);
        audit({ kind: "sticker_list", count: files.length });
        return true;
      } catch (e) {
        await client.sendPrivate(ev.user_id, `列表情包失败：${String(e?.message ?? e).slice(0, 80)}`);
        return true;
      }
    }

    const m = t.match(/^(?:看{1,2}表情|查看表情|表情图|表情)\s*[:：]?\s*(m?)(\d{1,4})\s*$/i) ||
      t.match(/^(?:看{1,2}|查看|打开|展示|来一张)\s*(?:第)?\s*(m?)(\d+)\s*(?:张|个|号)?\s*(?:表情|表情图|图|表情包)?\s*$/i);
    if (m) {
      try {
        const files = filesNow();
        const want = Number(m[2]);
        const byName = !!m[1];
        const name = byName
          ? files.find((f) => Number(/^m(\d+)\.[a-z]+$/i.exec(f)?.[1] ?? -1) === want)
          : files[want - 1];
        if (!name) {
          await client.sendPrivate(
            ev.user_id,
            `没有第 ${want} 张。发「表情包列表」看看序号范围（共 ${files.length} 张）。`,
          );
          return true;
        }
        const labels = loadStickerLabels(cfg.stickerDir);
        await client.sendImage(ev, join(cfg.stickerDir, name));
        await client.sendPrivate(
          ev.user_id,
          `${name}${labels[name]?.length ? "：" + labels[name].join("/") : ""}`,
        );
        audit({ kind: "sticker_view", name });
        return true;
      } catch (e) {
        await client.sendPrivate(ev.user_id, `发图失败：${String(e?.message ?? e).slice(0, 80)}`);
        return true;
      }
    }
    return false;
  }

  /**
 * 只保留「危险或涉及主人身份」的指令给桥直接执行：
 * 退群、加群、改配置、代发言、同意/拒绝、静音/风控、续聊参数。
 * 其余（活动、提醒、记住、查询类）全部交给 agent 自己判断并调工具。
 */
function isSensitiveCommand(t) {
  return /(退群|申请加群|同意|拒绝|改配置|以后叫我|代发言|定向搭话|别主动|可以主动|安静点|消停点|闭嘴|解除静音|不用安静了|风控|续聊|回复.{0,4}字|每分钟.{0,4}条|每小时.{0,4}条)/.test(
    t,
  );
}

async function handleOwnerNatural(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) {
      // 非主人发来的「指令样」消息：不执行，但留个痕，方便排查
      if (
        ev.message_type !== "group" &&
        /(提醒|退群|统计|状态|同意|拒绝|闭嘴|恢复|停下|记住|申请加群|别主动)/.test(String(text || ""))
      ) {
        logger.info?.(`[onebot] 非主人尝试指令，已忽略：${ev.user_id}「${String(text).slice(0, 30)}」`);
        audit({ kind: "cmd_blocked", from: String(ev.user_id), text: String(text).slice(0, 80) });
      }
      return false;
    }
    if (ev.message_type === "group") return false;
    const t = String(text || "").trim();

    // 非敏感指令交给 agent：她自己决定调 run_activity / set_reminder /
    // remember_fact / my_status 等工具，也自己决定怎么呈现结果
    if (!isSensitiveCommand(t)) return false;

    // ── 表情包清单 / 查看某张 ──
    if (await handleOwnerStickerCmd(ev, t)) return true;

    // ── 解除静音（优先于其他判断） ──
    if (/(解除静音|恢复说话|可以说话了|别静音|不用安静了)/.test(t)) {
      cfg.mutedUntil = 0;
      await client.sendPrivate(cfg.ownerId, "好，我回来了。");
      logger.info?.("[onebot] 解除静音");
      return true;
    }

    // ── 风控模式开关（默认开） ──
    if (/(开启|打开|启用|切到|切换到|用)\s*风控|风控模式?\s*(开|打开|开启|on)/i.test(t)) {
      cfg.riskMode = true;
      applyMode();
      persistConfig();
      await client.sendPrivate(
        cfg.ownerId,
        "风控模式已开：每会话 2 条/分、每人每小时 8 次、回复前先等约 2 秒，群里几条一起到达会合并成一次回，夜间不主动开话题。",
      );
      audit({ kind: "risk_mode", on: true });
      return true;
    }
    if (/(关闭|关掉|取消|退出)\s*风控|风控模式?\s*(关|关闭|off)|恢复原(来的)?节奏/i.test(t)) {
      cfg.riskMode = false;
      applyMode();
      persistConfig();
      await client.sendPrivate(cfg.ownerId, "风控模式已关，恢复原来的节奏。");
      audit({ kind: "risk_mode", on: false });
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

    // 上一次列出的人（供「对他们的印象」指代）
  let lastListedPeople = [];

    // ── 自我状态：性格 / 风格 / 记忆存量 / 反思 ──
    if (/(你现在是什么样|你是什么样|现在的你|你的性格|看看你自己|你是什么风格|自我状态|你的记忆有多少|你记得多少|你的想法都有啥)/.test(t) && t.length <= 22) {
      const base = join(HOME, ".dsh/onebot-bridge");
      const sizeOf = (f) => {
        try {
          const st = statSync(join(base, f));
          return st.size > 1024 ? `${(st.size / 1024).toFixed(1)}KB` : `${st.size}B`;
        } catch {
          return "0B";
        }
      };
      const countJson = (f, pick) => {
        try {
          const d = JSON.parse(readFileSync(join(base, f), "utf8"));
          return pick(d);
        } catch {
          return 0;
        }
      };

      people.load();
      selfViews.load();
      const peopleCount = Object.keys(people.data).length;
      const factCount = (() => {
        try {
          const d = JSON.parse(readFileSync(join(base, "facts.json"), "utf8"));
          return Array.isArray(d) ? d.length : Object.keys(d).length;
        } catch {
          return 0;
        }
      })();
      const viewCount = selfViews.data.length;
      const refl = selfViews.reflections.slice(-8);
      const seenIds = (() => {
        try {
          const d = JSON.parse(readFileSync(join(base, "seen.json"), "utf8"));
          let n = 0;
          for (const k of Object.keys(d)) n += (d[k].ids ?? []).length;
          return n;
        } catch {
          return 0;
        }
      })();
      const groupCount = [...sessions.entries.keys()].filter((k) => k.startsWith("group:")).length;

      // 她喜欢聊什么：从自我观点 + 人物话题里最高的几个词
      const favWords = (() => {
        const cnt = new Map();
        people.load();
        for (const r of Object.values(people.data)) {
          for (const [w, n] of Object.entries(r.topics ?? {})) cnt.set(w, (cnt.get(w) ?? 0) + n);
        }
        return [...cnt.entries()].filter(([w, n]) => n >= 3 && w.length >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
      })();

      const lines = [
        "关于我自己：",
        `· 说话风格：${String(cfg.styleHint ?? "").slice(0, 60)}…`,
        `· 长度习惯：默认一句，四成情况很短；问句会答得完整些`,
        `· 表情包：情绪到位时会发，偏好${cfg.autoSticker !== false ? "顺手补一张" : "只靠模型判断"}`,
        `· 作息：${cfg.nightStart ?? 1}–${cfg.nightEnd ?? 6} 点最安静`,
      ];
      if (favWords.length) lines.push(`· 我常聊的话题：${favWords.join("、")}`);
      if (viewCount) {
        const allViews = selfViews.data.map((v) => String(v.text || "").trim()).filter(Boolean);
        const joined = allViews.map((v, i) => `${i + 1}. ${v}`).join("\n");
        if (joined.length <= 1200) {
          lines.push(`· 我自己的想法（共 ${viewCount} 条，全部）：`);
          lines.push(joined);
        } else {
          lines.push(`· 我自己的想法（共 ${viewCount} 条，这里列最近 10 条）：`);
          lines.push(allViews.slice(-10).map((v, i) => `${allViews.length - 10 + i + 1}. ${v}`).join("\n"));
          lines.push(`· 想看完整清单，发「全部想法」`);
        }
      }
      lines.push("");
      lines.push("记忆存量：");
      lines.push(`· 人物档案：${peopleCount} 人（${sizeOf("users.json")}）`);
      lines.push(`· 全局事实：${factCount} 条（${sizeOf("facts.json")}）`);
      lines.push(`· 自我观点：${viewCount} 条（${sizeOf("self.json")}）`);
      lines.push(`· 已回复消息：约 ${seenIds} 个 id（${sizeOf("seen.json")}）`);
      lines.push(`· 群会话：${groupCount} 个`);
      lines.push(`· 提醒 ${reminders.length} 条｜runtime ${sizeOf("runtime.json")}`);
      if (refl.length) {
        lines.push("");
        lines.push("最近的自省：");
        for (const r of refl) {
          const d = new Date(r.at);
          lines.push(`· ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(r.text).slice(0, 200)}`);
        }
      } else {
        lines.push("");
        lines.push("最近的自省：（还没有，今晚 22 点会写第一条）");
      }
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    }

    // ── 全部想法 / 全部自省（分条列出，不截断） ──
    if (
      /^(全部想法|想法列表|所有想法|全部观点|全部自省|自省列表|所有自省|看看所有想法|列出所有想法|我的想法都有哪些|我的想法都有啥)$/.test(t) ||
      (/^(把|将)?(?:所有|全部)(?:的)?(?:想法|观点|自省)/.test(t) && /(列|说|看|念|给)/.test(t) && t.length <= 16)
    ) {
      selfViews.load();
      const isRefl = /自省/.test(t);
      const list = isRefl ? selfViews.reflections : selfViews.data;
      if (!list.length) {
        await client.sendPrivate(cfg.ownerId, isRefl ? "还没有自省记录。" : "还没有想法记录。");
        return true;
      }
      await client.sendPrivate(
        cfg.ownerId,
        isRefl ? `我的 ${list.length} 条自省（按时间顺序）：` : `我攒下的 ${list.length} 条想法（按时间顺序）：`,
      );
      const chunk = 15;
      for (let i = 0; i < list.length; i += chunk) {
        const part = list.slice(i, i + chunk).map((v, k) => {
          const n = i + k + 1;
          const txt = String(v.text || "").trim();
          const d = v.at ? `（${new Date(v.at).getMonth() + 1}-${new Date(v.at).getDate()}）` : "";
          return `${n}. ${txt}${d}`;
        });
        await client.sendPrivate(cfg.ownerId, part.join("\n"));
      }
      return true;
    }

    // ── 各个群的印象 ──
  if (/(各个群|所有群|哪些群|都记得哪些群|待过哪些群|这些群|全部群|群印象).{0,6}(印象|记得|情况)?|(印象|记得).{0,4}(各个群|所有群)/.test(t) && t.length <= 22) {
    await ensureGroupNames();
    const metaAll = loadGroupMeta();
    const auditLast = new Map();
    try {
      const rows = readFileSync(join(HOME, ".dsh/onebot-bridge/audit.log"), "utf8").split("\n");
      const since = Date.now() - 7 * 86400000;
      for (const line of rows) {
        if (!line.includes('"group:')) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const k = String(r.key ?? "");
        if (!k.startsWith("group:")) continue;
        if (r.kind !== "inbound" && r.kind !== "reply") continue;
        const ts = Date.parse(r.ts ?? "") || 0;
        if (!ts || ts < since) continue;
        const gid = k.slice(6);
        if (ts > (auditLast.get(gid) ?? 0)) auditLast.set(gid, ts);
      }
    } catch {
      // 忽略
    }
    const keySet = new Set([...sessions.entries.keys()].filter((k) => k.startsWith("group:")));
    for (const gid of Object.keys(metaAll)) keySet.add(`group:${gid}`);
    for (const gid of auditLast.keys()) keySet.add(`group:${gid}`);
    const fmtAt = (ts) => {
      const d = new Date(ts);
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const lastOf = (k, gid, ent) =>
      Math.max(ent?.lastMessageAt ?? 0, Number(metaAll[gid]?.lastMessageAt ?? 0), auditLast.get(gid) ?? 0);
    const keys = [...keySet].sort((a, b) => lastOf(b, b.slice(6), sessions.entries.get(b)) - lastOf(a, a.slice(6), sessions.entries.get(a)));
    if (!keys.length) {
      await client.sendPrivate(cfg.ownerId, "现在还没有任何群的记录。");
      return true;
    }
    const stats = [];
    for (const k of keys) {
      const gid = k.slice(6);
      const ent = sessions.entries.get(k);
      const lastAt = lastOf(k, gid, ent);
      const q = lastAt ? Math.round((Date.now() - lastAt) / 60000) : -1;
      const quiet =
        q < 0
          ? "没记下活跃时间"
          : q < 120
            ? `${q} 分钟前还热闹`
            : q < 1440
              ? `${Math.round(q / 60)} 小时没动静（最后 ${fmtAt(lastAt)}）`
              : `${Math.round(q / 1440)} 天没动静（最后 ${fmtAt(lastAt)}）`;
      // 最近话题：优先内存窗口，其次快照
      let topic = "";
      try {
        const stop = new Set(["这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们", "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么"]);
        const win = ent?.topicWindow ?? [];
        let top = [];
        if (win.length) {
          const cnt = new Map();
          for (const it of win) for (const w of it.w || []) if (!stop.has(w)) cnt.set(w, (cnt.get(w) ?? 0) + 1);
          top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
        }
        if (!top.length) top = (metaAll[gid]?.top ?? []).filter((w) => !stop.has(w)).slice(0, 3);
        if (top.length) topic = `，聊过 ${top.join("、")}`;
      } catch {
        // 忽略
      }
      // 群里聊过的人
      people.load();
      const members = Object.entries(people.data)
        .filter(([, r]) => Array.isArray(r.groups) && r.groups.map(String).includes(gid))
        .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
        .slice(0, 3)
        .map(([, r]) => r.name || "某人");
      stats.push({
        gid,
        label: groupLabel(gid),
        quiet,
        topic: topic.replace(/^，聊过 /, ""),
        members,
        recent: (metaAll[gid]?.recent ?? []).slice(-12).map((r) => r.l),
      });
    }

    // 群画像：12 小时内用缓存，其余一次性让模型概括（只依据片段，不编）
    const profiles = {};
    const stale = [];
    for (const s of stats) {
      const p = metaAll[s.gid]?.profile;
      if (p && Date.now() - Number(metaAll[s.gid]?.profileAt ?? 0) < 12 * 3600000) {
        profiles[s.gid] = p;
      } else if (s.recent.length || s.topic) {
        stale.push(s);
      }
    }
    if (stale.length) {
      try {
        const payload = stale
          .map(
            (s) =>
              `【${s.gid}】${s.label}\n话题词：${s.topic || "无"}\n片段：\n${s.recent.join("\n") || "（无）"}`,
          )
          .join("\n\n");
        const raw = String(
          (await sessions.generate(
            `private:${cfg.ownerId}`,
            "（内部判断，不要发给任何人，只输出 JSON 数组。）下面是几个 QQ 群最近的聊天片段和话题词。" +
              "为每个群写一段印象，字段：purpose=这个群主要是干什么的；topics=群里常聊什么；" +
              "people=大概是些什么样的人；style=说话风格（如短句互怼、表情多、刷屏、偏正经）；" +
              "warmth=友爱程度（如很熟络、客气、爱抬杠、冷清）。" +
              "每项不超过 16 字，只依据片段推断，看不出就写「不太清楚」，不要编。" +
              '输出格式严格为：[{"gid":"群号","purpose":"","topics":"","people":"","style":"","warmth":""}]\n\n' +
              payload,
          )) || "",
        );
        const arr = JSON.parse((raw.match(/\[[\s\S]*\]/) ?? ["[]"])[0]);
        for (const it of arr) {
          if (!it || !it.gid) continue;
          const p = {
            purpose: String(it.purpose ?? "").slice(0, 30),
            topics: String(it.topics ?? "").slice(0, 30),
            people: String(it.people ?? "").slice(0, 30),
            style: String(it.style ?? "").slice(0, 30),
            warmth: String(it.warmth ?? "").slice(0, 30),
          };
          profiles[String(it.gid)] = p;
          groupMetaTouch(`group:${it.gid}`, { profile: p, profileAt: Date.now() });
        }
        logger.info?.(`[onebot] 群画像更新 ${arr.length} 个（请求 ${stale.length} 个）`);
      } catch (e) {
        logger.warn?.(`[onebot] 群画像生成失败：${e.message}`);
      }
    }

    const lines = [`我对 ${stats.length} 个群的印象：`];
    for (const s of stats) {
      const p = profiles[s.gid] ?? {};
      lines.push("");
      lines.push(`· ${s.label}（${s.gid}）｜${s.quiet}`);
      lines.push(`  干什么的：${p.purpose || "还不太清楚"}`);
      lines.push(`  常聊：${p.topics || s.topic || "还没摸清"}`);
      lines.push(`  什么样的人：${p.people || "还说不准"}`);
      lines.push(`  说话风格：${p.style || "还没看出来"}`);
      lines.push(`  氛围：${p.warmth || "说不好"}`);
      if (s.members.length) lines.push(`  熟的人：${s.members.join("、")}`);
    }
    let buf = "";
    for (const ln of lines) {
      if (buf && buf.length + ln.length + 1 > 1600) {
        await client.sendPrivate(cfg.ownerId, buf);
        buf = "";
      }
      buf = buf ? `${buf}\n${ln}` : ln;
    }
    if (buf) await client.sendPrivate(cfg.ownerId, buf);
    return true;
  }

  // ── 某个群里印象深刻的人 ──
  const gmem = t.match(/群\s*(\d{6,12}).{0,8}(印象|记得谁|谁印象|哪些人)/) ||
               t.match(/(\d{6,12}).{0,4}群.{0,6}(印象|记得谁|哪些人)/);
  if (gmem) {
    const gid = String(gmem[1]);
    people.load();
    const members = Object.entries(people.data)
      .filter(([, r]) => Array.isArray(r.groups) && r.groups.map(String).includes(gid))
      .map(([id, r]) => ({ id, name: r.name || "", count: Number(r.count ?? 0), notes: Array.isArray(r.notes) ? r.notes : [], topics: r.topics ?? {} }))
      .filter((x) => x.count >= 2 || x.notes.length)
      .sort((a, b) => {
        if (b.notes.length !== a.notes.length) return b.notes.length - a.notes.length;
        return b.count - a.count;
      })
      .slice(0, 8);
    await ensureGroupNames();
    if (!members.length) {
      await client.sendPrivate(cfg.ownerId, `${groupLabel(gid)} 里还没有印象深的人。`);
      return true;
    }
    lastListedPeople = members.map((m) => m.id);
    const lines = [`在 ${groupLabel(gid)} 里，我印象比较深的 ${members.length} 个人：`];
    for (const m of members) {
      const bits = [`聊过 ${m.count} 次`];
      if (m.notes.length) bits.push(m.notes.slice(-2).join("、"));
      else {
        const top = Object.entries(m.topics).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);
        if (top.length) bits.push(`聊过 ${top.join("、")}`);
      }
      lines.push(`· ${m.name || "?"}(${m.id})：${bits.join("，")}`);
    }
    lines.push("（想细看就说「对他们的印象」）");
    await client.sendPrivate(cfg.ownerId, lines.join("\n"));
    return true;
  }

  // ── 对刚才列出的那些人的详细印象 ──
  if (/^(对他们的印象|对他们的看法|这些人呢|他们分别|详细说说他们|他们是什么样)/.test(t)) {
    if (!lastListedPeople.length) {
      await client.sendPrivate(cfg.ownerId, "你还没让我列过谁，先说「印象深刻的人」或「群 X 里记得谁」。");
      return true;
    }
    people.load();
    const lines = [];
    for (const id of lastListedPeople.slice(0, 6)) {
      const r = people.data[id];
      if (!r) continue;
      const bits = [];
      if (r.address) bits.push(`叫「${r.address}」`);
      bits.push(`聊过 ${r.count ?? 0} 次`);
      const hrs = Object.entries(r.activeHours ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `${String(h).padStart(2, "0")}点`);
      if (hrs.length) bits.push(`常在 ${hrs.join("、")}`);
      const tps = Object.entries(r.topics ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
      if (tps.length) bits.push(`聊 ${tps.join("、")}`);
      if (Array.isArray(r.notes) && r.notes.length) bits.push(`印象：${r.notes.slice(-3).join("；")}`);
      lines.push(`· ${r.name || id}(${id})：${bits.join("｜")}`);
    }
    await client.sendPrivate(
      cfg.ownerId,
      lines.length ? `对这几个人的印象：\n${lines.join("\n")}` : "这几个人的档案都没了。",
    );
    return true;
  }

  // ── 重置今天的活动额度 ──
  if (/(重置|清空|清零).{0,4}额度|额度.{0,4}(重置|清空|清零)|^多活动会儿$/.test(t.trim())) {
    try {
      const before = Number(loadSelfState().selfActivityResetAt) || 0;
      patchSelfState({ selfActivityResetAt: Date.now() });
      await client.sendHuman(ev, "额度清掉了，接下来我按自己的节奏来。");
      logger.info?.("[onebot] 主人重置了活动额度");
      audit({ kind: "reset_activity_quota", before });
    } catch (err) {
      await client.sendHuman(ev, `重置失败：${String(err?.message ?? err).slice(0, 60)}`);
    }
    return true;
  }

  // ── 让她立刻做活动（活动一下 / 连做 N 轮 / 去探险 等）──
  {
    const t2 = t.trim();
    const actMap = [
      [/^(去探险|去外面看看|出门看看)$/, "explore", "探险"],
      [/^(去读书|读点书|看书去)$/, "read", "读书"],
      [/^(写点什么|写点东西)$/, "write", "写点什么"],
      [/^(想想事|想事情|思考一下)$/, "think", "思考"],
      [/^(玩会儿|玩一会|玩一下)$/, "play", "玩"],
      [/^(回忆一下|翻翻记忆)$/, "recall", "回忆"],
      [/^(憧憬一下|想想未来)$/, "dream", "憧憬未来"],
      [/^(研究代码|看看代码|研究自己)$/, "study", "研究代码"],
    ];
    let hitKind = null;
    let hitName = "";
    for (const [re, kind, name] of actMap) {
      if (re.test(t2)) {
        hitKind = kind;
        hitName = name;
        break;
      }
    }
    const multi = t2.match(/^连做\s*(\d+)\s*轮?$/);
    if (multi) {
      const n2 = Math.max(1, Math.min(10, Number(multi[1]) || 1));
      await client.sendHuman(ev, `好，连做 ${n2} 轮。`);
      void (async () => {
        for (let i = 0; i < n2; i++) {
          await runThinkingCycle({ byOwner: true });
          if (i < n2 - 1) await new Promise((r) => setTimeout(r, 2000));
        }
      })();
      return true;
    }
    if (hitKind) {
      await client.sendHuman(ev, `好，去做${hitName}。`);
      void runThinkingCycle({ forceAction: hitKind, byOwner: true }).catch(() => {});
      return true;
    }
    if (/^(活动一下|做点活动|随便干点什么)$/.test(t2)) {
      await client.sendHuman(ev, "好，我自己看着来。");
      void runThinkingCycle({ byOwner: true }).catch(() => {});
      return true;
    }
  }

  // ── 处理她的需求记事本（给她 N / 算了 N / 需求清单）──
  if (/(给她|批准)\s*\d+/.test(t) || /(算了|拒了|不给她)\s*\d+/.test(t)) {
    const approve = /(给她|批准)/.test(t);
    const m = t.match(/(\d+)/);
    const idx = m ? Number(m[1]) : 0;
    const pendingWants = loadWants().filter((w) => w.status === "pending");
    if (!idx || idx > pendingWants.length) {
      await client.sendPrivate(cfg.ownerId, `没有第 ${idx} 条。现在待处理 ${pendingWants.length} 条。`);
      return true;
    }
    const target = pendingWants[idx - 1];
    const all = loadWants();
    const hit = all.find((w) => w.id === target.id);
    if (hit) hit.status = approve ? "granted" : "rejected";
    saveWants(all);
    await client.sendPrivate(cfg.ownerId, `${approve ? "已标记同意" : "已标记拒绝"}：${target.what}`);
    audit({ kind: "want_decide", what: target.what, approve });
    return true;
  }

  if (/^(需求清单|她的需求|看看她的需求|有什么想要的)/.test(t)) {
    const pendingWants = loadWants().filter((w) => w.status === "pending");
    if (!pendingWants.length) {
      await client.sendPrivate(cfg.ownerId, "她这会儿没什么想要的。");
      return true;
    }
    const lines = [`她记了 ${pendingWants.length} 个想要的：`];
    pendingWants.forEach((w, i) => {
      lines.push(
        `${i + 1}. [${w.kind}] ${w.what}` +
          (w.why ? `\n   因为：${String(w.why).slice(0, 60)}` : "") +
          `\n   （回「给她 ${i + 1}」或「算了 ${i + 1}」）`,
      );
    });
    await client.sendPrivate(cfg.ownerId, lines.join("\n"));
    return true;
  }

  // ── 发言频率统计 ──
  if (/(发言统计|发言频率|说话分布|频率统计|每小时.*发言|发言.*分布)/.test(t) && t.length <= 18) {
    try {
      const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/audit.log"), "utf8");
      const byHour = new Array(24).fill(0);
      const byMinute = new Map();
      const byKey = new Map();
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      let total = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.kind !== "reply") continue;
        const d = new Date(e.ts);
        if (Number.isNaN(d.getTime())) continue;
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (ds !== todayStr) continue;
        byHour[d.getHours()] += 1;
        const mk = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        byMinute.set(mk, (byMinute.get(mk) ?? 0) + 1);
        if (e.key) byKey.set(e.key, (byKey.get(e.key) ?? 0) + 1);
        total += 1;
      }
      if (!total) {
        await client.sendPrivate(cfg.ownerId, "今天还没有发言记录。");
        return true;
      }
      const maxHour = Math.max(...byHour);
      const lines = [`【今日发言频率】共 ${total} 条`, ""];
      for (let h = 0; h < 24; h++) {
        if (!byHour[h]) continue;
        const bar = "█".repeat(Math.max(1, Math.round((byHour[h] / maxHour) * 12)));
        const mark = byHour[h] === maxHour ? "  ← 高峰" : "";
        lines.push(`${String(h).padStart(2, "0")}-${String(h + 1).padStart(2, "0")}点 ${bar} ${byHour[h]}${mark}`);
      }
      const topMin = [...byMinute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const peakHour = byHour.indexOf(maxHour);
      lines.push("");
      lines.push(`高峰时段：${String(peakHour).padStart(2, "0")}-${String(peakHour + 1).padStart(2, "0")}点，共 ${maxHour} 条`);
      lines.push(`平均：${(maxHour / 60).toFixed(2)} 条/分钟`);
      if (topMin.length) {
        lines.push(`最密集分钟：${topMin.map(([k, v]) => `${k}(${v}条)`).join("、")}`);
      }
      if (byKey.size) {
        lines.push("");
        lines.push("按会话：");
        for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
          const label = k.startsWith("group:") ? groupLabel(k.slice(6)) : k.replace("private:", "私聊 ");
          lines.push(`· ${label}：${v} 条`);
        }
      }
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    } catch (err) {
      await client.sendPrivate(cfg.ownerId, `统计失败：${String(err?.message ?? err).slice(0, 120)}`);
      return true;
    }
  }

  // ── 印象深刻的人 ──
    // 注意：「印象深刻」单独出现时多半是在聊天（"今天有什么让你印象深刻的"），
    // 只有当它紧跟着「人/谁」时才算查人指令
    if (
      /(印象深刻的?(?:人|是谁)|都记得谁|记得哪些人|见过哪些人|认识谁|印象深的?人)/.test(t) &&
      t.length <= 20
    ) {
      people.load();
      const all = Object.entries(people.data)
        .map(([id, r]) => ({
          id,
          name: r.name || "",
          count: Number(r.count ?? 0),
          notes: Array.isArray(r.notes) ? r.notes : [],
          addr: r.address || "",
          groups: Array.isArray(r.groups) ? r.groups.length : 0,
        }))
        .filter((x) => x.count >= 3 || x.notes.length)
        .sort((a, b) => {
          // 有备注的排前面，然后按聊天次数
          if (b.notes.length !== a.notes.length) return b.notes.length - a.notes.length;
          return b.count - a.count;
        })
        .slice(0, 8);

      if (!all.length) {
        await client.sendPrivate(cfg.ownerId, "还没记住什么人，多聊几次就有了。");
        return true;
      }
      lastListedPeople = all.map((x) => x.id);
      const lines = [`我印象比较深的 ${all.length} 个人：`];
      for (const p of all) {
        const bits = [`聊过 ${p.count} 次`];
        if (p.addr) bits.push(`叫「${p.addr}」`);
        if (p.notes.length) bits.push(p.notes.slice(-2).join("、"));
        else if (p.groups > 1) bits.push(`在 ${p.groups} 个群见过`);
        lines.push(`· ${p.name || "?"}(${p.id})：${bits.join("，")}`);
      }
      lines.push("（想细看就说「对他们的印象」）");
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    }

    // ── 主人指令：立刻发条说说（你想发就写一条，不想发就不发） ──
    const qzCmd = t.match(/^(?:现在|马上)?(?:帮我)?(?:发|写)一?条(?:关于)?说说[：:，,、\s]*([\s\S]*)$/);
    if (qzCmd) {
      const qzTopic = String(qzCmd[1] || "").trim().slice(0, 60);
      const picked = pickTarget();
      if (!picked) {
        await client.sendPrivate(cfg.ownerId, "最近群聊太少，我找不出合适的素材，晚点儿再试吧。");
        return true;
      }
      logger.info?.(`[onebot] 主人触发手动发说说，素材来自会话 ${picked[0]}`);
      try {
        const text = String(
          await sessions.runSilent(
            picked[0],
            "（内部，不要把这个发给任何人，直接写正文。）" +
              (qzTopic ? "这件事是：「" + qzTopic + "」。" : "") +
              "发一条 QQ 空间说说：用你自己的口吻和想法，写你听到这件事时的真实感受或看法，" +
              "可以具体一点、带点情绪。不要复述原话、不要照搬别人的句子、不要鸡汤、不要话题标签。" +
              "不想发就只回一个字：无。",
          ) || "",
        ).trim();
        let content = cleanQzone(text);
        if (
          qzTopic &&
          (parrotOf(content, qzTopic) ||
            content.replace(/[^\u4e00-\u9fa5]/g, "") === qzTopic.replace(/[^\u4e00-\u9fa5]/g, ""))
        ) {
          logger.info?.("[onebot] 说说初稿在复述原话，重写一次");
          content = cleanQzone(
            String(
              (await sessions.runSilent(
                picked[0],
                "（内部，直接写正文。）上一版几乎在复述原话，重写：不要复述「" +
                  qzTopic +
                  "」，只写你听到这件事时的反应和看法，一两句，带点情绪。只输出正文。",
              )) || "",
            ).trim(),
          );
        }
        if (!content || content === "无" || content.length < 4) {
          await client.sendPrivate(cfg.ownerId, "这次没什么想发的，算了。");
          return true;
        }
        if (qzTopic && parrotOf(content, qzTopic)) {
          await client.sendPrivate(cfg.ownerId, "写出来还是像复述原话，这条先不发。给我点细节，或者换个说法？");
          return true;
        }
        await client.call("send_qzone_msg", {
          content,
          ugc_right: Number(cfg.qzoneVisibility ?? 1),
        });
        let planNow = loadQzonePlan();
        if (!planNow || planNow.date !== todayKey()) {
          planNow = { date: todayKey(), posted: 0, lastAt: 0 };
        }
        planNow.posted = Number(planNow.posted ?? 0) + 1;
        saveQzonePlan(planNow);
        await client.sendPrivate(cfg.ownerId, "已发：" + content);
        logger.info?.(`[onebot] 主人手动发说说：${content.slice(0, 40)}`);
        audit({ kind: "qzone_manual", text: content.slice(0, 200) });
      } catch (err) {
        logger.warn?.(`[onebot] 主人手动发说说失败：${err?.message ?? err}`);
        await client.sendPrivate(cfg.ownerId, "发说说失败了：" + (err?.message ?? err));
      }
      return true;
    }

    // ── 查看某个人 / 某个群的记忆 ──
    const memM = t.match(/(?:印象|档案|记得|了解|记忆).{0,8}?(\d{5,12})/) ||
                 t.match(/(\d{5,12}).{0,8}?(?:印象|档案|记得|了解|记忆)/);
    if (memM) {
      const id = String(memM[1]);
      const isGroup = /群/.test(t) || (cfg.prewarmGroups ?? []).map(String).includes(id) ||
        sessions.entries.has(`group:${id}`);
      if (isGroup) {
        // 群的记忆
        await ensureGroupNames();
        const ent = sessions.entries.get(`group:${id}`);
        const lines = [`【对群 ${groupLabel(id)} 的印象】`];
        if (!ent) {
          lines.push("（这个群还没有会话记录）");
        } else {
          const obs = (ent.observations ?? []).slice(-6);
          const win = ent.topicWindow ?? [];
          const cnt = new Map();
          for (const item of win) for (const w of item.w || []) cnt.set(w, (cnt.get(w) ?? 0) + 1);
          const stop = new Set(["这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们", "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么"]);
          const topics = [...cnt.entries()].filter(([w, n]) => n >= 2 && !stop.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
          if (topics.length) lines.push(`· 最近在聊：${topics.join("、")}`);
          const fw = ent.wordFreq;
          if (fw && fw.size) {
            const top = [...fw.entries()].filter(([w, n]) => n >= 3 && !stop.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
            if (top.length) lines.push(`· 长期高频：${top.join("、")}`);
          }
          if (obs.length) lines.push(`· 最近的观察：\n${obs.map((x) => "  " + x.slice(0, 70)).join("\n")}`);
          lines.push(`· 静了多久：${ent.lastMessageAt ? Math.round((Date.now() - ent.lastMessageAt) / 60000) + " 分钟" : "未知"}`);
        }
        await client.sendPrivate(cfg.ownerId, lines.join("\n"));
        return true;
      }

      // 人的印象
      people.load();
      const rec = people.data[id];
      if (!rec) {
        await client.sendPrivate(cfg.ownerId, `我这儿还没有 ${id} 的记录。`);
        return true;
      }
      const lines = [`【对 ${id} 的印象】`];
      if (rec.name) lines.push(`· 昵称：${rec.name}`);
      if (rec.address) lines.push(`· 我叫 TA：${rec.address}`);
      lines.push(`· 聊过 ${rec.count ?? 0} 次`);
      const hours = Object.entries(rec.activeHours ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, n]) => `${String(h).padStart(2, "0")}点(${n})`);
      if (hours.length) lines.push(`· 活跃时段：${hours.join("、")}`);
      const topics = Object.entries(rec.topics ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, n]) => `${w}(${n})`);
      if (topics.length) lines.push(`· 常聊：${topics.join("、")}`);
      if (Array.isArray(rec.notes) && rec.notes.length) lines.push(`· 备注：${rec.notes.slice(-5).join("；")}`);
      if (Array.isArray(rec.groups) && rec.groups.length) lines.push(`· 在 ${rec.groups.length} 个群里聊过`);
      if (rec.lastSeen) lines.push(`· 最后出现：${new Date(rec.lastSeen).toLocaleString("zh-CN")}`);
      await client.sendPrivate(cfg.ownerId, lines.join("\n"));
      return true;
    }

    // ── 好友请求确认 ──
    const decideFriend = async (approve) => {
      const last = [...pendingFriends.entries()].sort((a, b) => b[1].at - a[1].at)[0];
      if (!last) {
        await client.sendPrivate(cfg.ownerId, "现在没有待处理的好友请求。");
        return;
      }
      const [flag, info] = last;
      const uid = String(info.uid || info.userId || flag || "");
      const verb = approve ? "同意" : "拒绝";
      // 复查：这条申请是否还在「好友通知」里挂着
      const stillPending = async () => {
        try {
          const res = await client.call("get_buddy_req", {}, 8000);
          const list = res?.buddyReqs ?? res?.data?.buddyReqs ?? [];
          return (Array.isArray(list) ? list : []).some(
            (r) => String(r?.friendUid ?? "") === uid && r?.isDecide === false,
          );
        } catch {
          return null;
        }
      };
      try {
        let ok = false;
        // 「联系人-好友通知」里的申请只有 set_buddy_req 才真正生效
        if (info.reqTime) {
          try {
            await client.call(
              "set_buddy_req",
              { friendUid: uid, reqTime: String(info.reqTime), approve },
              12000,
            );
            const pending = await stillPending();
            ok = pending === false || pending === null;
            if (pending === true) logger.warn?.(`[onebot] set_buddy_req ${verb}后申请仍在：${uid}`);
          } catch (e1) {
            logger.warn?.(`[onebot] set_buddy_req ${verb}失败：${e1?.message ?? e1}`);
          }
        }
        if (!ok) {
          try {
            await client.call(
              "set_doubt_friends_add_request",
              { flag: info.flag || flag, approve },
              10000,
            );
            const pending = await stillPending();
            ok = pending === false || pending === null;
          } catch {
            // 不是可疑申请，继续退回标准接口
          }
        }
        if (!ok) {
          await client.call("set_friend_add_request", { flag, approve }, 12000);
          const pending = await stillPending();
          ok = pending === false || pending === null;
        }
        if (!ok) {
          await client.sendPrivate(
            cfg.ownerId,
            `接口没报错，但复查发现${verb}没生效，可能得你在手机 QQ 上点一下。`,
          );
          return;
        }
        pendingFriends.delete(flag);
        await client.sendPrivate(cfg.ownerId, `已${verb} ${info.name || uid || "对方"} 的好友请求。`);
        logger.info?.(`[onebot] 已${verb}好友：${uid}`);
        audit({ kind: approve ? "friend_approve" : "friend_reject", userId: uid });
      } catch (err) {
        await client.sendPrivate(cfg.ownerId, `${verb}失败：${String(err?.message ?? err).slice(0, 120)}`);
      }
    };
    if (/^(同意好友|加他|通过好友|接受好友)/.test(t)) {
      await decideFriend(true);
      return true;
    }
    if (/^(拒绝好友|不加他|拒绝加好友)/.test(t)) {
      await decideFriend(false);
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
    if (/(统计|报表|数据汇总|看看数据|今天的记录)/.test(t) && t.length <= 24) {
      let dayArg = "";
      if (/昨天|昨日/.test(t)) dayArg = ymdOffset(-1);
      else if (/前天/.test(t)) dayArg = ymdOffset(-2);
      else {
        const dm = t.match(/(?:(\d{4})[-年./])?(\d{1,2})[-月./](\d{1,2})/);
        if (dm) {
          dayArg = `${dm[1] || new Date().getFullYear()}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`;
        }
      }
      await client.sendPrivate(cfg.ownerId, await statsText(dayArg));
      return true;
    }

    // ── 状态 ──
    if (/(状态|运行情况|今天多少|用量|多少条|还在线吗|还好吗|统计|昨天|昨日|前天|最近三天)/.test(t) && t.length <= 24) {
      if (/最近(三|3)天|这三天/.test(t)) {
        const rows = [];
        for (let i = 2; i >= 0; i--) {
          const ds = ymdOffset(-i);
          const s = summarizeDay(ds) ?? {};
          rows.push(
            `${ds}：收 ${s.inbound ?? 0} / 回 ${s.replies ?? 0}｜token ${(((s.totalTokens ?? 0) / 10000) || 0).toFixed(1)} 万｜限流 ${s.limited ?? 0}`,
          );
        }
        await client.sendPrivate(cfg.ownerId, "最近三天（含今天）：\n" + rows.join("\n"));
        return true;
      }
      let target = "";
      if (/昨天|昨日/.test(t)) target = ymdOffset(-1);
      else if (/前天/.test(t)) target = ymdOffset(-2);
      else {
        const dm = t.match(/(?:(\d{4})[-年./])?(\d{1,2})[-月./](\d{1,2})/);
        if (dm) {
          target = `${dm[1] || new Date().getFullYear()}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`;
        }
      }
      await client.sendPrivate(cfg.ownerId, await statusText(target));
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
  const relayDone = new Set(); // 已执行过的定向搭话指令 id
  async function handleOwnerRelay(ev, text) {
    if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
    if (ev.message_type === "group") return false;
    const relayKey = String(ev.message_id ?? "");
    if (relayKey && relayDone.has(relayKey)) {
      logger.info?.(`[onebot] 定向搭话指令 ${relayKey} 已执行过，跳过`);
      return true;
    }
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

    if (relayKey) {
      relayDone.add(relayKey);
      if (relayDone.size > 200) {
        const first = relayDone.values().next().value;
        relayDone.delete(first);
      }
    }
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
      // 关键：标记这条指令已处理，否则私聊补回复会反复重新执行它
      try {
        markSeen(
          `private:${cfg.ownerId}`,
          Number(ev.time) * 1000 || Date.now(),
          ev.message_id,
        );
        flushSeen();
      } catch {
        // 忽略
      }
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
    if (ev?.__fromWebUI) logger.info?.(`[onebot] WebUI 事件进入 onEvent：${ev.message_id} type=${ev.post_type}/${ev.message_type}`);
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
    // 临时消息 / 陌生人消息：多半是好友申请或陌生人搭话，转告主人
    if (ev.message_type === "temp" || ev.message_type === "stranger" || ev.sub_type === "temp") {
      try {
        const segs = Array.isArray(ev.message) ? ev.message : [];
        const txt = segs
          .filter((x) => x?.type === "text")
          .map((x) => x?.data?.text ?? "")
          .join("")
          .trim();
        const who = String(ev.user_id ?? ev.sender?.user_id ?? "");
        const nick = ev.sender?.nickname ?? "";
        if (cfg.ownerId) {
          await client.sendPrivate(
            cfg.ownerId,
            `陌生人发来消息：${nick || "?"}(${who})\n内容：${txt.slice(0, 100) || "（无文字）"}` +
              `\n如果是好友申请，需要你在 QQ 或 WebUI 里处理（NapCat 没开放普通好友申请的接口）。`,
          );
          logger.info?.(`[onebot] 临时消息已转告主人：${nick || who}`);
          audit({ kind: "temp_message", from: who, text: txt.slice(0, 120) });
        }
      } catch (err) {
        logger.debug?.(`[onebot] 临时消息处理失败：${err?.message ?? err}`);
      }
      return;
    }
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
    if (ev?.__fromWebUI) {
      logger.info?.(
        `[onebot] 解析结果：text=${JSON.stringify(String(parsed.text || "").slice(0, 40))} hasAt=${parsed.hasAt} len=${String(parsed.text || "").length}`,
      );
    }
    // 有人用纯文本打「@昵称」时 OneBot 不给 at 段，这里补上识别
    try {
      if (
        !parsed.hasAt &&
        (/@\s*(肥鱼|大鱼|鱼鱼)/.test(String(parsed.text || "")) ||
          String(parsed.text || "").includes(`@${cfg.selfId}`))
      ) {
        parsed.hasAt = true;
        parsed.textAtMe = true;
        logger.info?.("[onebot] 识别到文本形式的 @（无 at 段）");
      }
    } catch {
      // 忽略
    }
    trace(`parsed text=${JSON.stringify(parsed.text)} hasAt=${parsed.hasAt} imgs=${parsed.images.length} segs=${Array.isArray(ev.message) ? ev.message.length : "无message"}`);
    ev.__hasAt = parsed.hasAt;
    // 空文本也可能是「只 @ 不说话」，交给后面按 hasAt 判断
    if (!parsed.text && !parsed.hasAt) return;

    const nickname = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    people.touch(
      ev.user_id,
      nickname,
      ev.message_type === "group" ? ev.group_id : 0,
      parsed.text,
    );

    const key = conversationKey(ev);

    // 主人的自然语言控制：状态/静音/打断/档位/代发言
    let ownerHandled = false;
    try {
      ownerHandled = await handleOwnerNatural(ev, parsed.text);
    } catch (err) {
      logger.warn?.(`[onebot] handleOwnerNatural 抛错：${err?.message ?? err}`);
      logger.warn?.(`[onebot] 堆栈：${String(err?.stack ?? "").split("\n").slice(0, 4).join(" | ")}`);
    }
    if (ownerHandled) {
      logger.info?.(`[onebot] 被「主人指令」拦截：${String(parsed.text || "").slice(0, 40)}`);
      // 指令类消息处理完必须标记「已处理」，
      // 否则私聊补回复（catchUpPrivate）会把同一条指令重新执行一遍，
      // 表现为「一个指令被反复执行」（定向搭话那次连发了 7 遍）。
      try {
        if (ev.message_id) {
          const ck = conversationKey(ev);
          markSeen(ck, Number(ev.time) * 1000 || Date.now(), ev.message_id);
          flushSeen();
        }
      } catch {
        // 忽略
      }
      return;
    }

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

    // 她说过「不再回复」的人：这段时间内直接跳过（主人除外）
    if (
      cfg.ownerId &&
      String(ev.user_id) !== String(cfg.ownerId) &&
      isRefused(String(ev.user_id))
    ) {
      logger.info?.(`[onebot] 已声明不再回复 ${ev.user_id}，跳过（${key}）`);
      audit({ kind: "refuse_skip", key, from: String(ev.user_id) });
      return;
    }

    // 连续对话：她刚回过的这个人，窗口内不 @ 也接话
    const nowTs = Date.now();
    const hit = cfg.followUpEnabled ? hitWindow(key, ev.user_id) : null;
    let continuing = !!hit;
    if (hit) {
      logger.info?.(
        `[onebot] 续聊命中 ${key} 用户 ${ev.user_id}（第 ${hit.rec.turns + 1}/${hit.rec.max} 轮，剩余 ${Math.round((hit.rec.until - nowTs) / 1000)}s）`,
      );
    }

    // B：窗口里是 A，但现在 B 说的话明显在接她的话 → 也算继续（不用等模型判断）
    if (!continuing && ev.message_type === "group" && !parsed.hasAt && cfg.followUpEnabled) {
      try {
        const otherTarget = activeWindowTarget(key, ev.user_id);
        if (otherTarget) {
          const e1 = sessions.entries.get(key);
          const lastText = String(e1?.lastReplyText ?? "");
          const related =
            !!parsed.replyToMe ||
            /(你|您)/.test(String(parsed.text || "")) ||
            textOverlaps(parsed.text, lastText);
          if (related) {
            continuing = true;
            switchedFrom = otherTarget;
            closeWindowFor(key, otherTarget);
            openWindow(key, ev.user_id);
            logger.info?.(
              `[onebot] 窗口内换人接话 ${key}：${otherTarget} → ${ev.user_id}（${related ? "内容相关" : ""}）`,
            );
            audit({ kind: "window_handoff", key, from: otherTarget, to: String(ev.user_id) });
          }
        }
      } catch {
        // 忽略
      }
    }

    // 换目标：她刚回完 A 的 10 秒内，B 没 @ 也开口了 → 先让模型判断两步
    let switchedFrom = null;
    if (
      ev.message_type === "group" &&
      !parsed.hasAt &&
      !continuing &&
      cfg.followUpEnabled &&
      cfg.switchTargetEnabled !== false
    ) {
      try {
        const e0 = await sessions.ensure(key);
        const lastTo = String(e0.lastReplyTo ?? "");
        const gap = nowTs - (e0.lastReplyAt ?? 0);
        const lastJudge = switchJudgeAt.get(key) ?? 0;
        if (
          lastTo &&
          lastTo !== String(ev.user_id) &&
          gap >= 0 &&
          gap <= 10000 &&
          nowTs - lastJudge >= 10000
        ) {
          switchJudgeAt.set(key, nowTs);
          const v = await judgeSwitchTalk(
            key,
            lastTo,
            String(ev.user_id),
            nickname,
            parsed.text.slice(0, 120),
            String(e0.lastReplyText ?? ""),
          );
          if (v) {
            switchedFrom = lastTo;
            closeWindowFor(key, lastTo);
            openWindow(key, ev.user_id);
            continuing = true;
            logger.info?.(`[onebot] 换目标 ${key}：${lastTo} → ${ev.user_id}（旧目标已停，新目标在跟她说话）`);
            audit({ kind: "switch_target", key, from: lastTo, to: String(ev.user_id) });
          } else {
            logger.info?.(`[onebot] 换目标判断未通过 ${key}（${lastTo} → ${ev.user_id}）`);
          }
        }
      } catch {
        // 判断失败就当普通旁听
      }
    }

    // 群里没 @ 她、也不是在续聊：只旁观、记录，不回复
    if (ev.message_type === "group" && !parsed.hasAt && !continuing && !switchedFrom && cfg.groupObserve) {
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
        // 旁听也要记下「当前会话目标」，否则 runProactive 生成的主动消息没有发送地址
        // 记下这条消息里的图，save_sticker 要用
        try {
          if (Array.isArray(parsed.images) && parsed.images.length) {
            entry.lastImages = parsed.images
              .map((x) => ({
                url: typeof x === "string" ? x : String(x?.url || ""),
                file: typeof x === "string" ? "" : String(x?.file || ""),
              }))
              .filter((x) => x.url || x.file)
              .slice(0, 4);
            entry.lastImagesAt = Date.now();
          }
        } catch {
          // 忽略
        }
        entry.lastSpeaker = "them";
        entry.lastTarget = {
          ...ev,
          message_type: "group",
          group_id: Number(key.slice(6)),
          user_id: ev.user_id,
        };
        // 旁听也要统计活跃度——否则热群插话永远看不到「群很热闹」
        const nTs = Date.now();
        // 补推的旧消息不能算「刚刚发生」，否则冷群/热群判断都会失真
        const msgTs = Number(ev.time) * 1000 || nTs;
        const isOld = nTs - msgTs > 5 * 60000;
        entry.lastMessageAt = Math.max(entry.lastMessageAt ?? 0, msgTs);
        groupMetaTouch(entry.key, { lastMessageAt: entry.lastMessageAt });
        if (!isOld) {
          entry.msgTimes = (entry.msgTimes ?? []).filter((t) => nTs - t < 60000);
          entry.msgTimes.push(nTs);
        }
        markRuntimeDirty();
        // 旁听也更新「这个群最后一次有动静」——否则 seen.lastTime 会一直停在
        // 上次回复的时刻，冷群判断就会误判（只更新时间，不记已回复的 id）
        try {
          const srec = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
          if (msgTs > (srec.lastTime ?? 0)) {
            srec.lastTime = msgTs;
            seenDirty = true;
            flushSeen();
          }
        } catch {
          // 忽略
        }

        // 热群插话判断（旁听分支才是主要战场）
        if (cfg.activeJoinEnabled && cfg.autoActionsEnabled !== false) {
          const lastActive = Math.max(entry.lastMentionAt ?? 0, entry.lastReplyAt ?? 0);
          // 从没参与过就按 Infinity 处理，避免出现「57 年没说话」这种数字
          const idleFromActive = lastActive > 0 ? nTs - lastActive : Number.POSITIVE_INFINITY;
          const cooldownOk =
            nTs - (entry.lastActiveJoinAt ?? 0) >
            (Number(cfg.activeJoinCooldownMinutes) || 30) * 60000;
          if (
            activeHoursOk() &&
            entry.msgTimes.length >= (Number(cfg.activeJoinPerMinute) || 6) &&
            idleFromActive > (Number(cfg.activeJoinIdleMinutes) || 10) * 60000 &&
            cooldownOk &&
            !entry.activeJoining
          ) {
            entry.activeJoining = true;
            entry.lastActiveJoinAt = nTs;
            const idleText =
              !Number.isFinite(idleFromActive) || idleFromActive > 7 * 24 * 60 * 60 * 1000
                ? "从未参与"
                : `${Math.round(idleFromActive / 60000)} 分钟没参与`;
            logger.info?.(
              `[onebot] 群很热闹（${entry.msgTimes.length} 条/分钟）且她${idleText}，插一句：${key}`,
            );
            audit({ kind: "active_join", key, perMinute: entry.msgTimes.length });
            void sessions
              .runProactive(
                key,
                "（这个群现在聊得很热闹，但没人叫你。如果你想加入，就顺着最近的话题插一句自然的、短的、" +
                  "不抢戏的话；如果你觉得插不上或者话题不适合你，就什么都不说（只输出一个句号）。）",
                ev,
                { quote: true },
              )
              .catch(() => {})
              .finally(() => {
                entry.activeJoining = false;
              });
          }
        }

        entry.observations = entry.observations ?? [];
        entry.observations.push(nickname + "：" + parsed.text.slice(0, 120));

        // 这个群正好有消息在合并缓冲里 → 把我也塞进去当语境，
        // 否则她只会看到"第一个叫她的人"，后面紧跟的补充/纠正全被漏掉
        try {
          const pendingBuf = typeof mergeBuf !== "undefined" ? mergeBuf.get(key) : null;
          if (pendingBuf && parsed.text) {
            pendingBuf.prompts.push(`[同一时段，${nickname} 也在说] ${parsed.text.slice(0, 150)}`);
            if (pendingBuf.prompts.length > 6) pendingBuf.prompts = pendingBuf.prompts.slice(-6);
            logger.info?.(`[onebot] 旁听消息并入合并缓冲：${key}`);
          }
        } catch {
          // 忽略
        }

        // 有人提到「肥鱼」但没 @ 她：
        // 先用模型判断这句是「直接叫她」还是「只是提到」，
        // 直接叫就立刻回，只是提到则按概率决定
        if (cfg.nameMentionEnabled !== false && !parsed.hasAt && !continuing) {
          try {
            const hit = /(肥鱼|大鱼|竹筒|鱼鱼)/.test(String(parsed.text || ""));
            if (hit) {
              const coolMs = (Number(cfg.nameMentionCooldownMinutes) || 15) * 60000;
              const coolOk = nowTs - (entry.lastNameJoinAt ?? 0) > coolMs;
              if (coolOk) {
                let isDirect = false;
                try {
                  const verdict = await sessions.generate(
                    key,
                    "（内部：判断下面这句话，说话人是在**直接叫肥鱼本人回应**（比如「肥鱼你说呢」「大肥鱼过来」），" +
                      "还是**只是在聊到肥鱼这个名字**（比如「大肥鱼今天怎么不吭声」「肥鱼那个机器人」）。" +
                      "只回两个字：直接 或 提到。不要解释。）\n句子：" +
                      String(parsed.text).slice(0, 200),
                  );
                  isDirect = /直接/.test(String(verdict || ""));
                  logger.info?.(`[onebot] 提到肥鱼的分析结果：${isDirect ? "直接叫" : "只是提到"}`);
                } catch {
                  // 模型判断失败就按「提到」处理
                }
                const chance = Number(cfg.nameMentionChance ?? 0.7);
                const willReply = isDirect || Math.random() < chance;
                if (willReply) {
                  entry.lastNameJoinAt = nowTs;
                  markRuntimeDirty();
                  logger.info?.(
                    `[onebot] ${isDirect ? "直接叫她" : "提到她"}（${nickname}：${parsed.text.slice(0, 30)}），接一句：${key}`,
                  );
                  audit({
                    kind: isDirect ? "name_direct" : "name_join",
                    key,
                    text: parsed.text.slice(0, 80),
                  });
                  void sessions
                    .runProactive(
                      key,
                      isDirect
                        ? "（群里有人直接叫你了，是在等你回应。用一句话自然地接上，别端着。）"
                        : "（群里有人在聊到你了，没有直接叫你。如果你觉得能接上，就用一句话自然地插进去——" +
                            "别像被点名报到那样正儿八经，可以顺着他们说的接或者自嘲一句；" +
                            "如果插不上，就什么都不说（只输出一个句号）。）",
                    )
                    .catch(() => {});
                }
              }
            }
          } catch {
            // 忽略
          }
        }

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
          // 群画像素材：最近 30 条（截断），供「各个群的印象」概括这个群什么样
          try {
            const gid = entry.key.slice(6);
            const prevRecent = loadGroupMeta()[gid]?.recent ?? [];
            const oneLine = `${nickname}：${String(parsed.text || "").replace(/\s+/g, " ").slice(0, 80)}`;
            groupMetaTouch(entry.key, {
              recent: [...prevRecent, { t: Date.now(), l: oneLine }].slice(-30),
            });
          } catch {
            // 忽略
          }
          const metaCnt = new Map();
          for (const it of entry.topicWindow) for (const w of it.w || []) if (w.length >= 2) metaCnt.set(w, (metaCnt.get(w) ?? 0) + 1);
          groupMetaTouch(entry.key, {
            lastMessageAt: Date.now(),
            top: [...metaCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w),
          });
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
        const realTs = Number(ev.time) * 1000 || nowTs;
        const stale = nowTs - realTs > 5 * 60000;
        ent.lastMessageAt = Math.max(ent.lastMessageAt ?? 0, realTs);
        if (!stale) {
          ent.msgTimes = (ent.msgTimes ?? []).filter((t) => nowTs - t < 60000);
          ent.msgTimes.push(nowTs);
        }
        ent.lastSpeaker = "them";
        // 有真人说话 → 冷群「等她开口」的闩解开
        ent.topicAwaitHuman = false;
        if (parsed.hasAt) {
          ent.lastMentionAt = nowTs;
          // 有人 @ 她 = 有人接话了，冷群话题标记可以解除
          ent.topicPending = false;
        }

        // 连发检测：同一个人连着说话、没人接
        const streak = ent.streak ?? (ent.streak = { userId: "", count: 0, lastAt: 0, joinedAt: 0 });
        // 只有「纯文字」才算连发：连发图片/转发/文件是在分享，不是在自言自语，
        // 而且非文字消息会打断连续性（必须连续三句文字才触发搭话）
        const pureText =
          !!String(parsed.text || "").trim() &&
          !(Array.isArray(parsed.images) && parsed.images.length) &&
          !(Array.isArray(parsed.forwards) && parsed.forwards.length) &&
          !(Array.isArray(parsed.files) && parsed.files.length);
        if (!pureText) {
          streak.count = 0;
          streak.userId = "";
          markRuntimeDirty();
        } else if (String(streak.userId) === String(ev.user_id)) {
          streak.count += 1;
          streak.lastAt = nowTs;
        } else {
          streak.userId = String(ev.user_id);
          streak.count = 1;
          streak.joinedAt = nowTs;
          streak.lastAt = nowTs;
        }
        markRuntimeDirty();

        // 一个人连发多条、等了一会儿还没人接 → 搭一句给个台阶
        if (cfg.soloStreakEnabled !== false && cfg.autoActionsEnabled !== false) {
          const minMsgs = Number(cfg.soloStreakMin) || 3;
          const waitMs = (Number(cfg.soloStreakWaitSeconds) || 1800) * 1000;
          const coolMs = (Number(cfg.soloStreakCooldownMinutes) || 20) * 60000;
          const waited = nowTs - streak.lastAt;
          const coolOk = nowTs - (ent.lastSoloJoinAt ?? 0) > coolMs;
          const soloDay = todayKey();
          if (ent.soloDay !== soloDay) {
            ent.soloDay = soloDay;
            ent.soloDayCount = 0;
          }
          const soloDayOk =
            Number(ent.soloDayCount ?? 0) < (Number(cfg.soloStreakPerDay) || 2);
          if (
            streak.count >= minMsgs &&
            waited >= waitMs &&
            coolOk &&
            soloDayOk &&
            !parsed.hasAt &&
            !continuing
          ) {
            ent.lastSoloJoinAt = nowTs;
            ent.soloDayCount = Number(ent.soloDayCount ?? 0) + 1;
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
                ev,
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
        // 冷群暖场的解除条件：只要「她开口之后有人说过话」就算有人回应。
        // 注意要用消息发生时间比，不能用「当前时间」——
        // 否则补推的旧消息会把刚设置好的标记立刻清掉。
        try {
          if (ent.topicPending && msgTs > (ent.lastTopicAt ?? 0)) {
            ent.topicPending = false;
            logger.info?.(`[onebot] 暖场后有人说话了，解除标记：${key}`);
            markRuntimeDirty();
          }
        } catch {
          // 忽略
        }
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

    // 记下这条消息里的图，save_sticker 要用（只有带图时才覆盖，文字消息不能把上一张图冲掉）
    try {
      if (Array.isArray(parsed.images) && parsed.images.length) {
        const entImg = await sessions.ensure(key);
        entImg.lastImages = parsed.images
          .map((x) => ({
            url: typeof x === "string" ? x : String(x?.url || ""),
            file: typeof x === "string" ? "" : String(x?.file || ""),
          }))
          .filter((x) => x.url || x.file)
          .slice(0, 4);
        entImg.lastImagesAt = Date.now();
      }
    } catch {
      // 忽略
    }

    // 被明确点名（@ / 引用她 / 续聊窗口内）不参与限流——
    // 限流是防刷屏，不是用来无视叫人的人
    const addressedNow = !!parsed.hasAt || !!parsed.replyToMe || !!continuing;
    const gate = addressedNow ? { ok: true } : allowRate(key, ev.user_id);
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

    // 有人评价她时，只记来源，不立刻改自我描述
    try {
      const t = String(parsed.text || "");
      if (/(你|肥鱼).{0,6}(像|是|挺|太|有点).{0,6}(机器|模板|人|冷|暖|较真|敷衍)/.test(t)) {
        noteMirrorSource(String(ev.user_id), t.slice(0, 60));
      }
    } catch {
      // 忽略
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

    // 他这轮没带图，但刚才发过图：把最近的图补给她看，让她自己判断值不值得存
    let noteRecentPics = false;
    if (cfg.enableImages && !imagePayloads.length && parsed.text && (parsed.hasAt || continuing)) {
      try {
        const entRecent = await sessions.ensure(key);
        const recentAt = Number(entRecent.lastImagesAt || 0);
        const recentImgs = Array.isArray(entRecent.lastImages) ? entRecent.lastImages : [];
        if (recentImgs.length && Date.now() - recentAt < 5 * 60_000) {
          const room = Math.max(1, (cfg.maxImagesPerMessage || 2) - imagePayloads.length);
          for (const u of recentImgs.slice(-Math.min(2, room))) {
            const got = await imagePayloadFrom(u);
            if (got) imagePayloads.push(got);
          }
          if (imagePayloads.length) {
            noteRecentPics = true;
            logger.info?.(`[onebot] 补上他刚才发的 ${imagePayloads.length} 张图给她看`);
          }
        }
      } catch (e) {
        logger.debug?.(`[onebot] 补最近图片失败：${e?.message ?? e}`);
      }
    }
    let msgText = parsed.text || "（只有 @，没说话）";
    if (noteRecentPics) msgText += "（附图：他刚才发的图）";
    if (parsed.replyIds?.length && imagePayloads.length > 0 && !parsed.text) {
      msgText = "（@ 了你，并引用了上面那张图，没打字）";
    }
    // 她自己该知道的事：主人能发什么指令（不然问起来只能瞎猜）
    const cmdHint =
      "\n（主人能直接发这些指令，桥会拦下来处理，你不用「听懂」：" +
      "活动一下 / 去探险 / 读点书 / 玩会儿 / 想想事 / 回忆一下 / 憧憬一下 / 研究代码 / 连做 N 轮 / " +
      "重置活动额度 / 状态 / 需求清单 / 各个群印象 / 全部想法 / 全部自省 / 记忆查询 xxx / " +
      "记住 xxx / 提醒我 xxx / 查看提醒 / 取消提醒 / 改配置 xxx / 以后叫我 xxx / " +
      "申请加群 xxx / 发条说说 / 代发言 / 定向搭话 / 退群 / 同意 / 拒绝 / 帮助。" +
      "有人问「有哪些指令」就照着答，不懂细节就用 owner_commands 查。）\n";

    // 私聊：教她像真人那样把两句话分开发
    const splitHint =
      ev.message_type === "group"
        ? ""
        : "\n（私聊时，**两句在说不同的事**就分两条发——像真人那样。判断标准：" +
          "\n· 一句在报状态/给结论，另一句在补充、认错、反问、换角度 → 拆" +
          "\n· 例：「变 15:11 了，正好四十分钟后。[split]你说的对，是我刚才看到旧值」" +
          "\n· 例：「正版源我读不到。[split]要不你讲两段，我听着」" +
          "\n· 例：「是吧。[split]好心要靠烧车才证明，这就不叫好意了」" +
          "\n· 反过来，如果两句话其实是同一件事的两个部分（「我查了[split]是 2.52 米」这种）→ 别拆，用逗号连起来" +
          "\n写法：在两句之间写 [split]，第一句末尾的句号去掉。最多拆两条。\n）\n";

    // 网页聊天用单独的标签，历史才能按渠道分开
    const channelTag = ev.__fromWebUI ? "[网页聊天]" : "[QQ私聊]";
    const bodyBase =
      ev.message_type === "group"
        ? `[QQ群消息] 群号 ${ev.group_id}，发言人 ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`
        : `${channelTag} ${nickname}（${ev.user_id}）${who}\n[消息内容] ${msgText}`;
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
        // 被引用消息里的文字，也要作为上下文（引用往往就是在回应这段）
        try {
          const qText = qsegs
            .filter((x) => x?.type === "text")
            .map((x) => String(x?.data?.text ?? ""))
            .join("")
            .trim();
          if (qText && qText !== String(parsed.text || "").trim()) {
            parsed.quotedText = qText.slice(0, 300);
            parsed.quotedFrom = String(quoted?.sender?.card || quoted?.sender?.nickname || "");
            logger.info?.(`[onebot] 引用内容已取到：${qText.slice(0, 40)}`);
          }
        } catch {
          // 忽略
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
    // ── 分层记忆注入（L0 自我 / L3 核心 / L2 摘要 / 相关记忆）──
    let memoryNote = "";
    try {
      const parts = [];
      // L0：我是谁（最先，决定怎么说话）
      const selfText = selfModelText();
      if (selfText) parts.push(selfText);
      // L3：核心自我（belief/care/want/change）
      const core = loadCore().slice(-20);
      if (core.length) {
        const byType = {};
        for (const c of core) {
          const ty = c.type || "belief";
          byType[ty] = byType[ty] || [];
          byType[ty].push(c.text);
        }
        const labels = { belief: "你认定的事", care: "你在意的", want: "你想做的事", change: "你变了的地方" };
        const lines = [];
        for (const ty of ["belief", "care", "want", "change"]) {
          if (!byType[ty]?.length) continue;
          lines.push(`· ${labels[ty]}：${byType[ty].slice(-4).join("；")}`);
        }
        if (lines.length) parts.push(`[你自己的话]\n${lines.join("\n")}\n`);
      }
      // L2：最近几天的经历摘要
      const dg = recentDigestText(3);
      if (dg) parts.push(`[你这几天经历过什么]\n${dg}\n`);
      // 相关记忆：多入口并行游走（最深 10 跳，权重衰减）
      try {
        const entries = [];
        const zh = String(parsed.text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
        // 入口 1-2：消息里的 2-4 字词（最多取 3 个）
        const words = [];
        for (let i = 0; i + 2 <= Math.min(zh.length, 24) && words.length < 3; i++) {
          for (let len = 4; len >= 2; len--) {
            const w = zh.slice(i, i + len);
            if (w.length === len && !/^(什么|怎么|这个|那个|就是|没有|可以|不是|现在|还是)$/.test(w)) {
              words.push(w);
              break;
            }
          }
        }
        for (const w of words) entries.push(`topic:${w}`);
        // 入口 3：当前说话人
        if (ev.user_id) entries.push(`person:${String(ev.user_id)}`);
        // 入口 4：今天
        entries.push(`time:${new Date().toISOString().slice(0, 10)}`);
        // 三成时候不深想，只做浅层联想（人也不会每句话都想很远）
        const walkChance = Number(cfg.memoryWalkChance ?? 0.7);
        if (entries.length >= 2 && Math.random() < walkChance) {
          const walked = netWalk(entries, { top: 5 + Math.floor(Math.random() * 4) });
          if (walked.length) {
            const lines = walked.map((x) => {
              const n2 = x.node;
              const d = new Date(n2.at);
              const when = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const hop = x.depth ? `（${x.depth} 跳·${x.via}）` : "";
              return `· [${n2.kind} ${when}]${hop} ${String(n2.text || "").slice(0, 70)}`;
            });
            parts.push(`[你顺着想起的]\n${lines.join("\n")}\n`);
          }
        }
      } catch {
        // 游走失败不影响主流程
      }
      if (parts.length) memoryNote = parts.join("\n") + "\n";
    } catch {
      // 注入失败不影响主流程
    }

    // 引用了某条消息：把那段也给她看，否则容易答非所问
    let quoteNote = "";
    if (parsed.quotedText) {
      quoteNote = `\n[对方引用的那条消息]${parsed.quotedFrom ? parsed.quotedFrom + "：" : ""}${parsed.quotedText}\n`;
    } else if (parsed.replyIds?.length && parsed.replySummary) {
      // 原文查不到（旧客户端消息），用摘要兜底
      quoteNote = `\n[对方引用的那条消息]（只有摘要）${parsed.replySummary}\n`;
    }
    const body =
      vibeNote +
      memoryNote +
      cmdHint +
      splitHint +
      slangNote +
      selfLine +
      emptyAtNote +
      quoteNote +
      forwardNote +
      fileNote +
      catchupNote +
      recallNote +
      linkNote +
      crossNote +
      factLine +
      bodyBase +
      observed;
    const ownerNote =
      cfg.ownerId && String(ev.user_id) === String(cfg.ownerId) && ev.message_type !== "group"
        ? "（这是你的主人。）\n"
        : "";
    const lenHint = pickLengthHint(parsed.text);
    // 她需要知道自己是不是刚断过线，否则会莫名其妙答不上对方的话
    const outageNote = recentOutageNote();
    const prompt = stripLoneSurrogates(
      (
        cfg.styleHint
          ? `${cfg.styleHint}\n${lenHint}\n${outageNote ? outageNote + "\n" : ""}${ownerNote}\n${body}`
          : `${lenHint}\n${outageNote ? outageNote + "\n" : ""}${ownerNote}${body}`
      ).trim(),
    );
    try {
      pendingPromptForDiag = prompt;
    } catch {
      // 忽略
    }

    // 私聊偶尔多说两句（大部分还是一句）
    const privateExtra =
      ev.message_type !== "group" &&
      Math.random() < (Number(cfg.privateMultiSentenceChance) || 0.2)
        ? "（这次可以多说两句，2-3 句，聊开一点。）\n"
        : "";
    // 记下这一轮她真正看到的图（含引用/转发补进来的），save_sticker 只认这些
    try {
      const entSeen = await sessions.ensure(key);
      entSeen.currentTurnImages = imagePayloads.length
        ? imagePayloads.map((p) => p?.srcUrl).filter(Boolean)
        : [];
      entSeen.currentTurnImageData = imagePayloads.length
        ? imagePayloads.slice(0, 4).map((p) => ({ url: p?.srcUrl, data: p?.data, mediaType: p?.mediaType }))
        : [];
    } catch {
      // 忽略
    }

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
        ? (buf.ev?.message_type === "group"
            ? `（群里刚连着来了 ${buf.prompts.length} 条，可能不止一个人；你可以自己判断：一并回一次、挑重点回应，不必逐条回。）\n`
            : `（对方连着发了 ${buf.prompts.length} 条，合起来一起回）\n`) +
          buf.prompts.join("\n")
        : buf.prompts[0];
    // 这一批里不止一个人在说话 → 引用谁都不对，干脆不引用
    const target = buf.firstEv ?? buf.ev;
    try {
      const multi = (buf.users?.size ?? 0) > 1;
      if (multi) target.__noQuote = true;
      if (buf.prompts.length > 1) {
        logger.info?.(
          `[onebot] 合并 ${buf.prompts.length} 条${multi ? `（${buf.users.size} 人，不引用）` : ""}：${key}`,
        );
      }
    } catch {
      // 忽略
    }
    void deliver(key, target, merged, buf.images);
  }

  function enqueue(key, ev, prompt, images) {
    const isGroup = ev.message_type === "group";
    // 风控模式下群聊也合并：几个人的话攒几秒，一次想完再回（降低回复条数）
    if (cfg.mergeMessages === false || (isGroup && cfg.mergeGroups !== true)) {
      void deliver(key, ev, prompt, images);
      return;
    }
    const buf =
      mergeBuf.get(key) ??
      { prompts: [], images: [], ev, firstEv: ev, users: new Set(), timer: null };
    buf.firstEv = buf.firstEv ?? ev;
    try {
      buf.users = buf.users ?? new Set();
      if (ev.user_id) buf.users.add(String(ev.user_id));
    } catch {
      // 忽略
    }
    buf.prompts.push(prompt);
    // 缓冲上限：最多攒 6 条，防止爆群时无限堆积
    if (buf.prompts.length > 6) buf.prompts = buf.prompts.slice(-6);
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
  async function imagePayloadFrom(src) {
    const url = typeof src === "string" ? src : String(src?.url || "");
    const file = typeof src === "string" ? "" : String(src?.file || "");
    if (!url && !file) return null;
    if (url) {
      const got = await downloadImage(url, cfg.maxImageBytes || 6000000);
      if (got) {
        got.srcUrl = url;
        got.srcFile = file;
        return got;
      }
    }
    try {
      const r = await client.call("get_image", { file: String(file || url) }, 12000);
      const p = String(r?.file ?? r?.path ?? r?.data?.file ?? "");
      if (p && existsSync(p)) {
        const buf = readFileSync(p);
        if (buf.length && buf.length <= (cfg.maxImageBytes || 6000000)) {
          logger.info?.("[onebot] 直连失败，改用 get_image 拿到本地图");
          return { data: buf, mediaType: "image/jpeg", srcUrl: url, srcFile: file };
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
        const ent0 = sessions.bySessionId(sid);
        if (ent0) ent0.lastSent = { text: String(clipped), at: Date.now() };
      } catch {
        // 忽略
      }
      try {
        const ent2 = sessions.entries.get(key);
        if (ent2) {
          ent2.lastReplyAt = Date.now();
          ent2.lastReplyTo = String(ev.user_id);
          ent2.lastReplyText = String(clipped).replace(/\n/g, " ").slice(0, 80);
          markRuntimeDirty();
        }
      } catch {
        // 忽略
      }
      logger.info?.(`[onebot] → ${key} ${clipped.slice(0, 60).replace(/\n/g, " ")}`);
      audit({
        kind: "reply",
        key,
        text: clipped.slice(0, 200),
        tier: lastLengthTier,
        len: String(clipped).length,
      });
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
        // 记一条「聊了什么」，摘要和检索都用得上
        try {
          const topicTxt = String(parsed.text || "")
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
            .slice(0, 12);
          appendMem({
            kind: "chat",
            who: String(ev.user_id || ""),
            topic: topicTxt,
            text: `跟${nickname}聊「${String(parsed.text || "").slice(0, 40)}」，我回了「${String(reply || "").slice(0, 40)}」`,
            ref: key,
          });
        } catch {
          // 忽略
        }
      }
    } catch (err) {
      const emsg = String(err?.message ?? err);
      logger.warn?.(`[onebot] 处理失败 ${key}：${emsg}`);
      // 400 类错误：把 prompt 的体征打出来，便于定位非法字符/超长
      if (/failed \(400\)|request failed \(400\)/i.test(emsg)) {
        try {
          const pr = String(pendingPromptForDiag ?? "");
          const tail = pr.slice(-60);
          const hasLone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(pr);
          logger.warn?.(
            `[onebot] 400 诊断：prompt 长度=${pr.length} 孤立代理=${hasLone} 尾部=${JSON.stringify(tail)}`,
          );
          audit({
            kind: "api_400",
            key,
            len: pr.length,
            hasLoneSurrogate: hasLone,
            tail,
          });
        } catch {
          // 忽略
        }
      }
      audit({ kind: "error", key, error: emsg.slice(0, 300) });
      // 会话写锁冲突：说明上一轮还没结束，直接跳过，等下一轮或 catchUp 补
      if (/already owned by an active write handle/i.test(emsg)) {
        logger.info?.(`[onebot] 会话正忙，本轮跳过（不再重试）：${key}`);
        return;
      }
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
  // 独立的杂项状态（不跟 sessions 快照混）
  const SELF_STATE_PATH = join(HOME, ".dsh/onebot-bridge/self-state.json");
  function loadSelfState() {
    try {
      return JSON.parse(readFileSync(SELF_STATE_PATH, "utf8")) || {};
    } catch {
      return {};
    }
  }
  function patchSelfState(patch) {
    try {
      const cur = loadSelfState();
      Object.assign(cur, patch);
      writeFileSync(SELF_STATE_PATH, JSON.stringify(cur));
    } catch {
      // 忽略
    }
  }
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
        topicWindow: (ent.topicWindow ?? []).slice(-60),
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
      if (Array.isArray(saved.topicWindow)) {
        const now = Date.now();
        entry.topicWindow = saved.topicWindow.filter((x) => x && now - x.t < 3 * 3600000);
      }
      if (saved.topicPending) entry.topicPending = true;
    } catch {
      // 忽略
    }
  }

  // ── 群活动快照（重启或隔天后仍能说清"昨天聊过什么"） ──
  const GROUP_META_PATH = join(HOME, ".dsh/onebot-bridge/group-meta.json");
  let groupMetaCache = null;
  let groupMetaTimer = null;

  function loadGroupMeta() {
    if (groupMetaCache) return groupMetaCache;
    try {
      groupMetaCache = JSON.parse(readFileSync(GROUP_META_PATH, "utf8")) ?? {};
    } catch {
      groupMetaCache = {};
    }
    return groupMetaCache;
  }

  function groupMetaTouch(key, patch) {
    if (!String(key).startsWith("group:")) return;
    const meta = loadGroupMeta();
    const gid = String(key).slice(6);
    meta[gid] = { ...(meta[gid] ?? {}), ...patch, at: Date.now() };
    if (groupMetaTimer) return;
    groupMetaTimer = setTimeout(() => {
      groupMetaTimer = null;
      try {
        writeFileSync(GROUP_META_PATH, JSON.stringify(loadGroupMeta()), "utf8");
      } catch {
        // 忽略
      }
    }, 5000);
    groupMetaTimer.unref?.();
  }

  // ── 需求记事本：她想要的东西随手记下来，等主人有空处理 ──
  const WANTS_PATH = join(HOME, ".dsh/onebot-bridge/wants.json");
  function loadWants() {
    try {
      const d = JSON.parse(readFileSync(WANTS_PATH, "utf8"));
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  }
  function saveWants(arr) {
    try {
      writeFileSync(WANTS_PATH, JSON.stringify(arr.slice(-100), null, 1));
    } catch {
      // 忽略
    }
  }

  // ── 主人专用 WebUI：HTTP + SSE，只认 token ──
  const webClients = new Set(); // SSE 连接
  const webHistory = []; // 最近 100 条，刷新页面能看到
  let webServer = null;
  let webAuthFails = 0;
  let webLockedUntil = 0;

  const WEBHIST_PATH = join(HOME, ".dsh/onebot-bridge/webui-history.jsonl");

  function loadWebHistory(limit = 120) {
    try {
      const raw = readFileSync(WEBHIST_PATH, "utf8");
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
    } catch {
      return [];
    }
  }

  function webPush(rec) {
    try {
      const item = { ...rec, at: Date.now() };
      webHistory.push(item);
      if (webHistory.length > 100) webHistory.shift();
      try {
        appendFileSync(WEBHIST_PATH, JSON.stringify(item) + "\n");
      } catch {
        // 忽略
      }
      const line = "data: " + JSON.stringify(rec) + "\n\n";
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

  function webHtml(token) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 助手</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1115; --fg:#e6e6e6; --muted:#8b93a1;
  --line:#23262d; --card:#1a1d24; --card2:#1e222a;
  --me:#2563eb; --her:#1e222a; --her-fg:#e6e6e6;
  --accent:#7cc4ff; --input:#1a1d24; --input-line:#2a2e38;
}
body.light{
  --bg:#f6f7f9; --fg:#1f2328; --muted:#6b7280;
  --line:#e3e6ea; --card:#ffffff; --card2:#ffffff;
  --me:#2563eb; --her:#ffffff; --her-fg:#1f2328;
  --accent:#0969da; --input:#ffffff; --input-line:#d6dae0;
}
body{font:15px/1.6 -apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex:none}
h1{font-size:15px;font-weight:600}
#pg{margin-left:auto;font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--input-line);border-radius:12px;padding:3px 10px}
#pg:hover{background:var(--card)}
#theme{font-size:15px;background:none;border:0;cursor:pointer;color:var(--muted);padding:2px 6px;line-height:1}
#theme:hover{color:var(--fg)}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80}
.dot.off{background:#f87171}
#live{display:none;flex:none;padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);max-height:110px;overflow-y:auto;line-height:1.6}
#live.on{display:block}
#live .l{opacity:.85}
#live .l b{color:var(--accent);font-weight:500}
#btns{display:none;flex:none;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line)}
#btns.on{display:flex}
#btns button{background:var(--card2);border:1px solid var(--input-line);color:var(--fg);border-radius:14px;padding:4px 12px;font:13px inherit;cursor:pointer}
#btns button:hover{background:var(--line);border-color:var(--muted)}
#log{flex:1 1 0;min-height:140px;overflow-y:auto;padding:16px 16px 34px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:80%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.me{align-self:flex-end;background:var(--me);color:#fff;border-bottom-right-radius:4px}
.her{align-self:flex-start;background:var(--her);color:var(--her-fg);border-bottom-left-radius:4px}
.tool{align-self:flex-start;font-size:11px;padding:2px 10px;border-radius:10px;margin:1px 0 1px 4px;font-weight:500}
/* 夜间：高饱和的深色底 + 亮色字，不要灰 */
.t-chat{background:#1e4d7a;color:#a6dbff}
.t-mem{background:#452a70;color:#d8bcff}
.t-self{background:#1d5138;color:#96e8bb}
.t-code{background:#5c3917;color:#ffd39a}
.t-want{background:#5e2544;color:#ffb0cd}
.t-net{background:#154e4e;color:#96e8e8}
.t-draw{background:#3d2b70;color:#c9b4ff}
.t-other{background:#2f3a5e;color:#b6c6f0}
/* 日间：淡但依然有色相，不灰 */
body.light .t-chat{background:#cfe8ff;color:#0a4d91}
body.light .t-mem{background:#e8dbff;color:#5b2fa8}
body.light .t-self{background:#cdf5dd;color:#15703f}
body.light .t-code{background:#ffe6c4;color:#8a4b00}
body.light .t-want{background:#ffd9e7;color:#a01d54}
body.light .t-net{background:#c9f2f2;color:#0d6363}
body.light .t-draw{background:#e0d4ff;color:#4a2fa8}
body.light .t-other{background:#dde4f7;color:#3a4a75}
footer{padding:12px;border-top:1px solid var(--line);display:flex;gap:8px;flex:none}
#in{flex:1;background:var(--input);border:1px solid var(--input-line);color:var(--fg);border-radius:8px;padding:10px 12px;font:inherit;resize:none;height:44px}
#send{background:var(--me);border:0;color:#fff;border-radius:8px;padding:0 18px;font:inherit;cursor:pointer}
#send:disabled{opacity:.5}
</style></head><body>
<header><span class="dot" id="dot"></span><h1>QQ 助手</h1><span id="st" style="font-size:12px;color:#8b93a1"></span><a id="pg" href="/pages?token=${encodeURIComponent(token)}" target="_blank">页面</a><button id="theme" title="切换日夜">☾</button></header>
<div id="live"></div>
<div id="log"></div>
<footer><textarea id="in" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea><button id="send">发送</button></footer>
<script>
const T=${JSON.stringify(token)}, log=document.getElementById('log'),
      inp=document.getElementById('in'), btn=document.getElementById('send'),
      dot=document.getElementById('dot'), st=document.getElementById('st');
function linkify(el,text){
  // 把 /page/xxx 或 http://host:port/page/xxx 变成可点链接（并纠正端口到当前 WebUI）
  const re=new RegExp('(?:https?:[/][/][^\\s]+)?[/]page[/]([a-z0-9]+)','gi');
  let last=0, m;
  el.textContent='';
  while((m=re.exec(text))!==null){
    if(m.index>last) el.appendChild(document.createTextNode(text.slice(last,m.index)));
    const a=document.createElement('a');
    a.href='/page/'+m[1]+'?token='+T;
    a.target='_blank';
    a.textContent='打开页面';
    a.style.color='#7cc4ff';
    el.appendChild(a);
    last=m.index+m[0].length;
  }
  if(last<text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
function add(cls,text){
  const d=document.createElement('div');d.className='msg '+cls;
  if(cls==='her'&&new RegExp('[/]page[/][a-z0-9]+','i').test(text)) linkify(d,text); else d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d
}
// 工具中文名（后端也会带，这里兜底）
const TOOL_ZH={
  send_sticker:"发表情",list_stickers:"看表情库",save_sticker:"存表情",send_face:"发小黄脸",
  at_person:"艾特别人",draw_image:"画图",draw_svg:"画SVG",web_search:"搜网",web_fetch:"读网页",
  hot_news:"查热点",recall:"翻旧对话",remember_fact:"记事实",remember_person:"记人物",
  remember_self:"记想法",revise_self:"改想法",forget_self:"忘想法",my_memory:"查记忆",
  memory_index:"看记忆目录",my_digest:"看近期摘要",person_dossier:"查人物档案",
  group_recap:"看群记录",who_said:"查谁说的",view_avatar:"看头像",my_status:"看状态",
  my_activities:"看活动记录",my_adventures:"看探险记录",my_capabilities:"看能力清单",
  my_changelog:"看更新日志",my_source:"看源码片段",my_outages:"看掉线记录",my_schedule:"看排期",
  exec_sandbox:"跑代码",read_source:"读源码",note_want:"记需求",my_wants:"看需求本",
  resolve_want:"标记需求完成",drop_want:"删需求",request_feature:"申请功能",
  render_page:"做网页",add_webui_button:"加按钮",remove_webui_button:"删按钮",
  read_forward_more:"展开转发",refuse_person:"拒聊",owner_commands:"查指令清单",
  remember:"记东西",memory:"查记忆",search:"搜索",read:"读东西",write:"写东西",
  run_activity:"开始活动",set_reminder:"设提醒",group_impressions:"看群印象",
  my_thoughts:"看我的想法"
};
// 分类颜色
const TOOL_KIND={
  send_sticker:"chat",list_stickers:"chat",save_sticker:"chat",send_face:"chat",at_person:"chat",
  draw_image:"draw",draw_svg:"draw",render_page:"draw",
  my_memory:"mem",memory_index:"mem",my_digest:"mem",recall:"mem",remember_fact:"mem",
  remember_person:"mem",remember_self:"mem",revise_self:"mem",forget_self:"mem",
  person_dossier:"mem",group_recap:"mem",who_said:"mem",view_avatar:"mem",
  my_status:"self",my_activities:"self",my_adventures:"self",my_capabilities:"self",
  my_changelog:"self",my_source:"self",my_outages:"self",my_schedule:"self",
  exec_sandbox:"code",read_source:"code",
  note_want:"want",my_wants:"want",resolve_want:"want",drop_want:"want",request_feature:"want",
  owner_commands:"self",
  web_search:"net",web_fetch:"net",hot_news:"net"
};
function addTool(name){
  // 注意：这里在模板字符串里，正则的 \[ \] 会被吃掉，只能用字符串操作
  let raw=String(name||'').trim();
  if(raw.startsWith('[')) raw=raw.slice(1);
  if(raw.endsWith(']')) raw=raw.slice(0,-1);
  raw=raw.trim();
  // 没配中文名的也别露出英文（界面里不该出现技术名词）
  let zh=TOOL_ZH[raw];
  if(!zh){
    zh=/^[a-z0-9_]+$/i.test(raw) ? '某个操作' : raw;
  }
  const kind=TOOL_KIND[raw]||'other';
  const d=document.createElement('div');
  d.className='tool t-'+kind;
  d.textContent=zh;
  log.appendChild(d);log.scrollTop=log.scrollHeight;
}
let typing=null;
function setTyping(on){if(on&&!typing){typing=add('her','…');}else if(!on&&typing){typing.remove();typing=null;}}
// 日夜切换（记在 localStorage）
const themeBtn=document.getElementById('theme');
function applyTheme(t){
  if(t==='light'){document.body.classList.add('light');themeBtn.textContent='☀';}
  else{document.body.classList.remove('light');themeBtn.textContent='☾';}
}
try{applyTheme(localStorage.getItem('fish-theme')||'dark');}catch(e){applyTheme('dark');}
themeBtn.onclick=()=>{
  const now=document.body.classList.contains('light')?'dark':'light';
  applyTheme(now);
  try{localStorage.setItem('fish-theme',now);}catch(e){}
};

const live=document.getElementById('live');
function addLive(d){
  live.className='on';
  const el=document.createElement('div');el.className='l';
  if(d.time){
    const t=document.createElement('span');
    t.textContent=d.time+' ';
    t.style.color='var(--muted)';t.style.fontVariantNumeric='tabular-nums';
    el.appendChild(t);
  }
  const b=document.createElement('b');b.textContent=(d.kind?({explore:'出门',read:'读书',play:'玩',think:'想事',write:'写',recall:'整理记忆',dream:'想以后',study:'研究代码'}[d.kind]||d.kind):'')+' ';
  el.appendChild(b);el.appendChild(document.createTextNode(d.text||''));
  live.appendChild(el);
  while(live.children.length>3) live.removeChild(live.firstChild);
  live.scrollTop=live.scrollHeight;
}
fetch('/activities?token='+T).then(r=>r.json()).then(list=>{
  if(!Array.isArray(list)||!list.length) return;
  live.className='on';
  for(const a of list.slice(0,3).reverse()) addLive({kind:a.kind,text:a.intent||a.did,time:a.time});
}).catch(()=>{});
// 刚本地显示过的消息，等后端 SSE 回推同一句时跳过，避免显示两份
let pendingMeText = "";

// 快捷入口不放在聊天页（占地方），统一放到右上角「页面」里


fetch('/history?token='+T).then(r=>r.json()).then(list=>{
  for(const m of list){
    if(m.image){
      const wrap=document.createElement('div');wrap.className='msg her';
      const img=document.createElement('img');img.src=m.image+'?token='+T;
      img.style.maxWidth='200px';img.style.borderRadius='8px';img.style.display='block';
      wrap.appendChild(img);log.appendChild(wrap);
    }
    else if(m.role==='me') add('me',m.text||'');
    else if(m.role==='tool') addTool(m.text||'');
    else add('her',m.text||'');
  }
});
const es=new EventSource('/stream?token='+T);
es.onopen=()=>{dot.className='dot';st.textContent='在线';};
es.onerror=()=>{dot.className='dot off';st.textContent='断线重连中…';};
es.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(d.role==='tool'){addTool(d.text);return;}
  if(d.role==='activity'){addLive(d);return;}
  if(d.role==='me'){
    const t=String(d.text||'');
    // 本地刚显示过的，跳过（否则会显示两份）
    if(pendingMeText && (t===pendingMeText || t.includes(pendingMeText))){
      pendingMeText='';
      return;
    }
    add('me',t);
    return;
  }
  if(d.role==='typing'){setTyping(d.on);return;}
  setTyping(false);
  if(d.image){
    const wrap=document.createElement('div');wrap.className='msg her';
    const img=document.createElement('img');
    img.src=d.image+'?token='+T;
    img.style.maxWidth='200px';img.style.borderRadius='8px';img.style.display='block';
    wrap.appendChild(img);log.appendChild(wrap);log.scrollTop=log.scrollHeight;
    return;
  }
  add(d.role==='me'?'me':'her',d.text||'');
};
async function send(from){
  if(typeof from!=='string') from='';
  const t=inp.value.trim(); if(!t) return;
  inp.value=''; btn.disabled=true;
  if(from&&from.startsWith('button:')){
    const d=document.createElement('div');d.className='msg me';
    const tag=document.createElement('span');
    tag.textContent='['+from.slice(7)+'] ';
    tag.style.opacity='.65';tag.style.fontSize='12px';
    d.appendChild(tag);d.appendChild(document.createTextNode(t));
    log.appendChild(d);log.scrollTop=log.scrollHeight;
  } else { add('me',t); pendingMeText=t; }
  try{
    await fetch('/send?token='+T,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t,from:from||''})});
  }catch(e){addTool('发送失败：'+e.message);}
  setTimeout(()=>btn.disabled=false,600);
}
btn.onclick=()=>send();
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
</script></body></html>`;
  }

  /** 从会话文件里读对话历史（跨重启保留） */
  function readMessagesFromFile(file, limit) {
    try {
      const raw = zstdDecompressSync(readFileSync(file)).toString("utf8");
      const out = [];
      // 活动是 runSilent 跑的：它的 prompt 有固定特征，紧跟其后的回复是活动产出，不是对话
      let afterActivityPrompt = false;
      let lastSource = "qq"; // qq / webui / group
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }

        // 先看这条 user/message 是不是活动 prompt
        if (ev.type === "user/message") {
          const rawText = (ev.data?.content ?? [])
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("")
            .trim();
          if (
            /（这是你自己的时间|（内部|（你的时间|（现在研究代码|（内部探索|（内部回顾|（内部反思|（内部整理|（内部思考|（这是给你的|（下面的这些是/.test(
              rawText,
            )
          ) {
            afterActivityPrompt = true;
            continue; // 活动 prompt 本身也不进历史
          }
          afterActivityPrompt = false;
          // 只有带渠道标签的「真实消息」才更新来源；
          // DSH 注入的运行时说明（Time sampled 等）不含标签，不能让它把标记冲掉
          if (rawText.includes("[网页聊天]")) lastSource = "webui";
          else if (rawText.includes("[QQ群消息]")) lastSource = "group";
          else if (rawText.includes("[QQ私聊]")) lastSource = "qq";
        }
        // 活动 prompt 之后的回复：是活动产出，跳过
        if (afterActivityPrompt && ev.type === "assistant/message") {
          continue;
        }

        const got = textOfEvent(ev);
        if (!got.text || got.text.length < 2) continue;
        // 活动产出（思考计划的 JSON、反思草稿）不算对话
        const tx = got.text.trim();
        // 兜底：明显是 prompt 模板的整条丢掉
        if (/（QQ 聊天[:：]|像真人发消息|长度要有变化|点了智慧会发|不要复述我的问题/.test(tx)) continue;
        // 自主活动的产出（凌晨那波还没隔离会话时混进来的反思/见闻）不算对话
        if (/^(做到了|没做到|算做到|半做到|验了|核了|又空一栏|探险记录反而是|串起来是一条|翻出来了|想明白了)/.test(tx))
          continue;
        if (/^\{\s*"(summary|looked|core)"/.test(tx)) continue;
        if (/^(这条比记性差|这一层比|差别在于我原先)/.test(tx)) continue;
        if (/^\{.*"looked"/.test(tx)) continue;
        if (/^\[\[?(next|game|book)\s*[:：]/.test(tx)) continue;
        if (tx.startsWith("（内部") || tx.startsWith("（这是你自己")) continue;
        // 统一成毫秒时间戳，否则和图片记录排在一起会错位
        let ts = Number(ev.time) || Number(ev.ts) || 0;
        if (ts > 0 && ts < 1e12) ts *= 1000; // 秒 -> 毫秒
        // 她的输出里可能带 [split]（她自己要求分两条发的记号），读历史时也要拆
        const bits = tx
          .split(/\[split\]/i)
          .map((x) => x.trim())
          .filter(Boolean);
        if (bits.length > 1) {
          for (let k = 0; k < bits.length; k++) {
            const piece = got.role === "对方" ? bits[k] : humanizePunct(bits[k]);
            out.push({
              role: got.role === "对方" ? "me" : "her",
              text: piece.slice(0, 500),
              at: (ts || 0) + k,
              source: got.role === "对方" ? lastSource : lastSource || "qq",
            });
          }
        } else {
          out.push({
            role: got.role === "对方" ? "me" : "her",
            text: bits[0] ? bits[0].slice(0, 500) : tx.slice(0, 500),
            at: ts || 0,
          });
        }
      }
      return out.slice(-limit);
    } catch {
      return [];
    }
  }

  /** 从会话文件里读对话历史（跨重启保留）；找不到指定会话就找最像私聊的 */
  function sessionHistory(sid, limit = 60) {
    try {
      const files = listSessionFiles(60);
      logger.info?.(`[onebot] WebUI 历史：sid=${sid || "(空)"} 找到 ${files.length} 个会话文件`);
      // 1. 指定了 sessionId 就先找它
      if (sid) {
        const t = files.find((x) => x.sid === String(sid));
        if (t) {
          const got = readMessagesFromFile(t.file, limit);
          if (got.length) return got;
        }
      }
      // 2. 兜底：最近修改的几个会话里，挑「对方发言最多」的那个（私聊最像）
      let best = [];
      for (const t of files.slice(0, 8)) {
        const got = readMessagesFromFile(t.file, limit);
        const theirs = got.filter((m) => m.role === "me").length;
        logger.info?.(`[onebot] WebUI 历史：${t.sid} 读出 ${got.length} 条（对方 ${theirs} 条）`);
        if (theirs >= 2 && got.length > best.length) best = got;
      }
      return best;
    } catch {
      return [];
    }
  }

  function webStart() {
    if (!cfg.webuiEnabled || webServer) return;
    const token = String(cfg.webuiToken || "");
    if (!token || token.length < 16) {
      logger.warn?.("[onebot] webuiToken 太短或没设置，WebUI 不启动");
      return;
    }
    webServer = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const tk = u.searchParams.get("token") || "";
      // 简单防爆破
      if (Date.now() < webLockedUntil) {
        res.writeHead(429).end("too many attempts");
        return;
      }
      if (tk !== token) {
        webAuthFails += 1;
        if (webAuthFails >= 5) {
          webLockedUntil = Date.now() + 3600_000;
          webAuthFails = 0;
          logger.warn?.("[onebot] WebUI 认证失败 5 次，锁定 1 小时");
        }
        res.writeHead(401).end("unauthorized");
        return;
      }
      webAuthFails = 0;

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
        let list = loadWebHistory(300);
        if (!list.length) list = webHistory.slice(-50);
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
      if (u.pathname === "/send" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => {
          body += c;
          if (body.length > 10_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsedBody = JSON.parse(body || "{}");
            const t = String(parsedBody.text || "").trim();
            const from = String(parsedBody.from || "").slice(0, 40);
            if (!t) {
              res.writeHead(400).end("empty");
              return;
            }
            // 走跟 QQ 私聊同一条管道
            const fakeEv = {
              post_type: "message",
              message_type: "private",
              user_id: Number(cfg.ownerId) || 0,
              message_id: `webui-${Date.now()}`,
              time: Math.floor(Date.now() / 1000),
              sender: { user_id: Number(cfg.ownerId) || 0, nickname: "主人" },
              message: [{ type: "text", data: { text: t } }],
              raw_message: t,
              __fromWebUI: true,
              __fromButton: from || "",
            };
            // 先把「你发的」记进网页聊天历史——不依赖 deliver 能不能跑通
            try {
              webPush({ role: "me", text: t.slice(0, 500) });
            } catch (err) {
              logger.warn?.(`[onebot] WebUI 消息未记入历史：${err?.message ?? err}`);
            }
            res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
            setTimeout(() => void client.onEvent(fakeEv).catch(() => {}), 10);
          } catch {
            res.writeHead(400).end("bad json");
          }
        });
        return;
      }
      res.writeHead(404).end("not found");
    });
    webServer.listen(Number(cfg.webuiPort) || 3081, String(cfg.webuiBind || "127.0.0.1"), () => {
      logger.info?.(
        `[onebot] WebUI 已启动 http://${cfg.webuiBind || "127.0.0.1"}:${Number(cfg.webuiPort) || 3081}/?token=***`,
      );
    });
    webServer.on("error", (err) => {
      logger.warn?.(`[onebot] WebUI 启动失败：${err?.message ?? err}`);
      webServer = null;
    });
  }

  // ── 离线模式：断线超过 30 分钟 = 她「还能想，但说不了话」──
  let offlineSince = 0;
  let qqOnline = true; // WS 通 ≠ QQ 登录着（封号时正是如此）
  async function refreshQqOnline() {
    try {
      const info = await client.call("get_login_info", {}, 6000);
      const uid = Number(info?.user_id ?? 0);
      const was = qqOnline;
      qqOnline = uid > 0;
      if (was !== qqOnline) logger.info?.(`[onebot] QQ 登录状态变为：${qqOnline ? "在线" : "离线"}`);
    } catch {
      qqOnline = false;
    }
  }
  setInterval(() => void refreshQqOnline(), 60_000).unref?.();

  function isOfflineMode() {
    if (client.connected && qqOnline) {
      if (offlineSince) {
        const mins = Math.round((Date.now() - offlineSince) / 60000);
        logger.info?.(`[onebot] 恢复在线（离线 ${mins} 分钟）`);
        audit({ kind: "back_online", minutes: mins });
        // 恢复后第一次内省要带上「离线期间我做了什么」
        offlineSummaryPending = true;
        // 顺手把「她这段时间想要的东西」报给主人
        try {
          const pend = loadWants().filter((w) => w.status === "pending");
          if (pend.length && cfg.ownerId) {
            const list = pend
              .slice(-8)
              .map((w) => `· [${w.kind}] ${w.what}${w.why ? `（因为：${String(w.why).slice(0, 40)}）` : ""}`)
              .join("\n");
            void client
              .sendPrivate(
                cfg.ownerId,
                `她这段时间记下了 ${pend.length} 个想要的东西：\n${list}\n\n` +
                  `（回「给她 <序号>」批，回「算了 <序号>」拒；或者你自己看 wants.json）`,
              )
              .catch(() => {});
            logger.info?.(`[onebot] 已向主人汇报 ${pend.length} 条待处理需求`);
          }
        } catch {
          // 忽略
        }
        offlineSince = 0;
      }
      return false;
    }
    if (!offlineSince) {
      // 启动时就未连接（比如封号期间重启）：视为已离线够久，
      // 否则每次重启都要空等 30 分钟才进离线模式
      offlineSince = Date.now() - 31 * 60_000;
    }
    return Date.now() - offlineSince > 30 * 60_000;
  }
  let offlineSummaryPending = false;

  /** 离线期间的学习清单（给她恢复后看） */
  function offlineDigest() {
    try {
      const learns = loadLearnings();
      const since = offlineSince || Date.now() - 7 * 86400_000;
      const recent = learns.filter((l) => l.at >= since);
      if (!recent.length) return "";
      const list = recent
        .slice(-8)
        .map((l) => {
          const why = (l.path || []).find((p) => p && p.why)?.why;
          return `· ${l.topic}：${String(l.summary).slice(0, 60)}${why ? `（路上被「${String(why).slice(0, 30)}」勾住的）` : ""}`;
        })
        .join("\n");
      return (
        `（说明：你最近没法在群里说话。可以把它当成一次出门远行——` +
        `你在外面走了走，看了 ${recent.length} 处东西，都记下来了：\n${list}\n` +
        `你现在知道的东西比出门前多了一些。）`
      );
    } catch {
      return "";
    }
  }

  // ── 主动行为时段：23 点到次日 9 点不主动开口 ──
  function activeHoursOk() {
    try {
      const h = new Date().getHours();
      const start = Number(cfg.activeStartHour ?? 9);
      const end = Number(cfg.activeEndHour ?? 23);
      if (start < end) return h >= start && h < end;
      return h >= start || h < end; // 跨夜写法
    } catch {
      return true;
    }
  }

  /** 自主活动的时段：比「主动发言」宽松（内部活动不打扰任何人） */
  function selfActivityHoursOk() {
    try {
      const h = new Date().getHours();
      const start = Number(cfg.selfActivityStartHour ?? 5);
      const end = Number(cfg.selfActivityEndHour ?? 24);
      if (start < end) return h >= start && h < end;
      return h >= start || h < end;
    } catch {
      return true;
    }
  }

  // ── 她发出去的消息 id：有人引用这条，等于在跟她说话 ──
  const myMsgIds = new Set();
  const myMsgOrder = [];
  function noteMyMessage(mid) {
    try {
      const id = String(mid || "");
      if (!id || myMsgIds.has(id)) return;
      myMsgIds.add(id);
      myMsgOrder.push(id);
      if (myMsgOrder.length > 300) {
        const old = myMsgOrder.shift();
        myMsgIds.delete(old);
      }
    } catch {
      // 忽略
    }
  }
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
  let outages = [];
  try {
    const raw = readFileSync(OUTAGE_PATH, "utf8");
    outages = JSON.parse(raw);
    if (!Array.isArray(outages)) outages = [];
  } catch {
    outages = [];
  }
  let outageDownAt = 0; // 当前这次掉线的开始时间（0 = 没在掉线）
  let lastOutageInfo = null; // 最近一次已恢复的掉线 { downAt, upAt, minutes }

  function saveOutages() {
    try {
      if (outages.length > 200) outages = outages.slice(-200);
      writeFileSync(OUTAGE_PATH, JSON.stringify(outages));
    } catch {
      // 忽略
    }
  }

  function noteOutageFromClient(kind, ts) {
    try {
      if (kind === "down") {
        if (!outageDownAt) outageDownAt = ts;
        logger.warn?.("[onebot] 掉线开始");
      } else if (kind === "up") {
        if (outageDownAt) {
          const minutes = Math.max(1, Math.round((ts - outageDownAt) / 60000));
          outages.push({ downAt: outageDownAt, upAt: ts, minutes });
          lastOutageInfo = { downAt: outageDownAt, upAt: ts, minutes };
          saveOutages();
          logger.info?.(`[onebot] 掉线恢复，断了 ${minutes} 分钟`);
          outageDownAt = 0;
        }
      }
    } catch {
      // 忽略
    }
  }

  /** 给她看的掉线摘要（最近 2 小时内） */
  function recentOutageNote() {
    try {
      const now = Date.now();
      const recent = outages.filter((o) => now - o.upAt < 2 * 3600_000).slice(-3);
      const ongoing = outageDownAt > 0;
      if (!recent.length && !ongoing) return "";
      const list = recent
        .map((o) => {
          const d = new Date(o.upAt);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          return `${hh}:${mm} 恢复（断了 ${o.minutes} 分钟）`;
        })
        .join("；");
      const ong = ongoing
        ? `你刚刚断线过，${Math.max(1, Math.round((now - outageDownAt) / 60000))} 分钟前才恢复。`
        : "";
      return `（说明：${ong}你最近断线过 — ${list}。断线期间的消息可能刚补回来或者丢了，如果对方说"你怎么不说话"就是这个原因。）`;
    } catch {
      return "";
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
      // 先补私聊（NapCat 有 get_friend_msg_history）
      await catchUpPrivate();
    } catch (err) {
      logger.warn?.(`[onebot] 私聊补回复异常：${err?.message ?? err}`);
    }
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
          // 按「上次处理到现在隔了多久」决定拉多少条：
          // 掉线越久，需要的窗口越大；但每群最多补 2 条，不会刷屏
          const prevRec = seenState[`group:${gid}`] ?? {};
          const sinceTs = Number(prevRec.lastTime) || 0;
          const downMin = sinceTs ? (Date.now() - sinceTs) / 60000 : 999;
          const wantCount =
            downMin > 180 ? 120 : downMin > 30 ? 80 : downMin > 5 ? 40 : 20;
          const res = await client.call("get_group_msg_history", {
            group_id: Number(gid),
            count: wantCount,
          });
          if (downMin > 30) {
            logger.info?.(
              `[onebot] 群 ${gid} 已 ${Math.round(downMin)} 分钟没处理，拉最近 ${wantCount} 条找漏掉的 @`,
            );
          }
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
            // 时间过滤始终生效：比「最后一次处理」更早的消息一律不补。
            // 之前只在「没有 ids」时才过滤，id 记录不全时会把几天前的老消息重新回一遍。
            if (msgTs && since && msgTs <= since) continue;
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

  // ── 统一的工具调用日志：她调了什么、成没成，都留个痕 ──
  const TOOL_LOG_SKIP = new Set(["list_stickers", "repeat_reminder"]);
  try {
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      try {
        const toolName = String(exec?.name ?? "");
        if (!toolName || TOOL_LOG_SKIP.has(toolName)) return decision;
        // 工具中文名（前端展示用）
        const TOOL_ZH = {
          send_sticker: "发表情",
          list_stickers: "看表情库",
          save_sticker: "存表情",
          send_face: "发小黄脸",
          at_person: "艾特别人",
          draw_image: "画图",
          draw_svg: "画 SVG",
          web_search: "搜网",
          web_fetch: "读网页",
          hot_news: "查热点",
          recall: "翻旧对话",
          remember_fact: "记事实",
          remember_person: "记人物",
          remember_self: "记想法",
          revise_self: "改想法",
          forget_self: "忘想法",
          my_memory: "查记忆",
          memory_index: "看记忆目录",
          my_digest: "看近期摘要",
          person_dossier: "查人物档案",
          group_recap: "看群记录",
          who_said: "查谁说的",
          view_avatar: "看头像",
          my_status: "看状态",
          my_activities: "看活动记录",
          my_adventures: "看探险记录",
          my_capabilities: "看能力清单",
          my_changelog: "看更新日志",
          my_source: "看源码片段",
          my_outages: "看掉线记录",
          my_schedule: "看排期",
          exec_sandbox: "跑代码",
          read_source: "读源码",
          note_want: "记需求",
          my_wants: "看需求本",
          resolve_want: "标记需求完成",
          drop_want: "删需求",
          request_feature: "申请功能",
          render_page: "做网页",
          add_webui_button: "加按钮",
          remove_webui_button: "删按钮",
          read_forward_more: "展开转发",
          refuse_person: "拒聊",
          owner_commands: "查指令清单",
          remember: "记东西",
          memory: "查记忆",
        };

        // WebUI 里显示她调了什么工具
        try {
          const sid = String(exec?.agent?.session?.id ?? "");
          const ent = sid ? sessions.bySessionId(sid) : null;
          if (ent?.lastTarget?.__fromWebUI) {
            const zh = TOOL_ZH[toolName] || toolName;
            webPush({ role: "tool", tool: toolName, text: zh });
          }
        } catch {
          // 忽略
        }
        const argsStr = (() => {
          try {
            return JSON.stringify(exec?.args ?? {}).slice(0, 120);
          } catch {
            return "";
          }
        })();
        const failed =
          decision?.kind === "error" ||
          !!result?.error ||
          (typeof result?.content === "string" && /error|失败/i.test(result.content.slice(0, 40)));
        audit({
          kind: "tool",
          tool: toolName,
          args: argsStr,
          ok: !failed,
        });
        if (failed) {
          logger.warn?.(`[onebot] 工具失败：${toolName} ${argsStr}`);
        }
      } catch {
        // 日志失败不影响工具
      }
      return decision;
    });
    logger.info?.("[onebot] 工具调用日志已启用");
  } catch (err) {
    logger.warn?.(`[onebot] 工具日志注册失败：${err?.message ?? err}`);
  }

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
        // 主动回合没说话（只输出句号）时，也要清掉标志
        if (entry.proactiveTurn && !text) entry.proactiveTurn = false;
        // 静默回合（内省）：只记东西，不发任何消息
        if (entry.silentTurn) {
          entry.proactiveTurn = false;
          logger.info?.(
            `[onebot] 内省完成（${text ? text.slice(0, 30).replace(/\n/g, " ") : "无输出"}）`,
          );
          entry.silentTurn = false;
          return;
        }
        // 只有「主动回合」才由这里转发；被动回复由 sendHuman 发，避免重复
        if (!entry.proactiveTurn) return;
        entry.proactiveTurn = false;
        const targetEv = entry.proactiveTarget || entry.lastTarget;
        entry.proactiveTarget = null;
        if (!text || !targetEv) return;
        // 双保险：和刚 sendHuman 发出去的内容一样就不再重复发
        try {
          const last = entry.lastSent;
          if (
            last &&
            Date.now() - last.at < 15000 &&
            String(last.text).trim() === String(text).trim()
          ) {
            logger.info?.("[onebot] 自发转发与刚发的内容相同，跳过");
            return;
          }
        } catch {
          // 忽略
        }
        const ev = targetEv;
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
        // 只输出句号/省略号 = 模型选择「不说」，别把标点发到群里
        {
          const bare = String(text).replace(/[\s]/g, "");
          if (!bare || /^[。．.…，,、！!？?~～]+$/.test(bare)) {
            logger.info?.("[onebot] 主动回合选择不说话（只输出了标点），跳过发送");
            audit({ kind: "proactive_silent", key: conversationKey(ev) });
            return;
          }
        }
        logger.info?.(`[onebot] 自发消息 → ${conversationKey(ev)} ${text.slice(0, 40).replace(/\n/g, " ")}`);
        void client
          .sendHuman(ev, text.slice(0, cfg.maxReplyChars), {
            quote: entry.proactiveQuote === true,
          })
          .catch(() => {});
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

  // 统一用「活跃时段」：23-9 点不做任何主动行为
  const inQuietHours = () => !activeHoursOk();

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

  // ── 冷群找话题：每 10 分钟检查一次 ──────────────────────────
  function checkSoloStreak() {
    if (cfg.soloStreakEnabled === false || cfg.autoActionsEnabled === false) return;
    if (!client.connected) return; // 掉线时别搭话，发了也白发
    if (!activeHoursOk()) return; // 23-9 点不主动搭话
    const nowTs = Date.now();
    const minMsgs = Number(cfg.soloStreakMin) || 3;
    const waitMs = (Number(cfg.soloStreakWaitSeconds) || 1800) * 1000;
    const coolMs = (Number(cfg.soloStreakCooldownMinutes) || 20) * 60000;
    for (const [key, ent] of sessions.entries) {
      if (!key.startsWith("group:")) continue;
      const st = ent.streak;
      if (!st || st.count < minMsgs) continue;
      const waited = nowTs - (st.lastAt ?? 0);
      if (waited < waitMs || waited > 90 * 60000) continue; // 等太久了就不提了
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

  async function checkQuietGroups() {
    if (!cfg.quietTopicEnabled || cfg.autoActionsEnabled === false) return;
    if (!client.connected) return; // 掉线时跳过
    if (!activeHoursOk()) return; // 23-9 点不主动开话题
    const nowTs = Date.now();
    const limit = (Number(cfg.quietTopicHours) || 2) * 3600 * 1000;
    // 覆盖「所有见过的群」——只遍历内存里的 entries 会漏掉没建过会话的群
    const allKeys = new Set(
      Object.keys(seenState).filter((k) => k.startsWith("group:")),
    );
    for (const k of sessions.entries.keys()) {
      if (k.startsWith("group:")) allKeys.add(k);
    }
    for (const key of allKeys) {
      if (!key.startsWith("group:")) continue;
      let ent = sessions.entries.get(key);
      if (ent?.topicPending) continue;
      let last = ent?.lastMessageAt ?? seenState[key]?.lastTime ?? 0;

      // seen.lastTime 只在「回复成功」时更新，旁听不更新，容易误判。
      // 判定前先用历史确认一次真实的最后消息时间。
      const gidNum0 = Number(key.slice(6));
      try {
        const h = await client.call(
          "get_group_msg_history",
          { group_id: gidNum0, count: 2 },
          6000,
        );
        const msgs = Array.isArray(h?.messages) ? h.messages : [];
        for (const m of msgs) {
          const t = Number(m?.time) * 1000 || 0;
          if (t > last) last = t;
        }
        // 最后一条是她自己发的 → 不再自说自话，等有人说话再恢复
        const newest = msgs.length
          ? msgs.reduce((a, b) => (Number(b?.time) > Number(a?.time) ? b : a))
          : null;
        const newestUid = String(newest?.sender?.user_id ?? newest?.user_id ?? "");
        if (newestUid && newestUid === String(cfg.selfId)) {
          if (ent) ent.topicAwaitHuman = true;
          logger.debug?.(`[onebot] 群 ${key} 最后一条是她自己发的，跳过冷群搭话`);
          continue;
        }
      } catch {
        // 拉不到就用旧值
      }
      // 顺便把准确时间写回去，下次不用再拉
      try {
        const rec0 = seenState[key] ?? (seenState[key] = { lastTime: 0, ids: [] });
        if (last > (rec0.lastTime ?? 0)) {
          rec0.lastTime = last;
          seenDirty = true;
        }
      } catch {
        // 忽略
      }

      if (!last || nowTs - last < limit) continue;
      if (nowTs - (ent?.lastTopicAt ?? 0) < limit) continue;
      if (ent?.topicAwaitHuman) continue;
      const dayK = todayKey();
      if (ent && ent.topicDay !== dayK) {
        ent.topicDay = dayK;
        ent.topicDayCount = 0;
      }
      if (ent && Number(ent.topicDayCount ?? 0) >= (Number(cfg.quietTopicPerDay) || 1)) continue;
      // 没会话就建一个，并给一个发送目标，否则主动消息发不出去
      if (!ent) {
        try {
          ent = await sessions.ensure(key);
        } catch {
          continue;
        }
      }
      if (!ent) continue;
      const gidNum = Number(key.slice(6));
      if (!ent.lastTarget) {
        ent.lastTarget = { message_type: "group", group_id: gidNum, user_id: 0 };
      }
      ent.lastTopicAt = nowTs;
      ent.topicPending = true;
      ent.topicAwaitHuman = true;
      ent.topicDayCount = Number(ent.topicDayCount ?? 0) + 1;
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

  /** 私聊补回复：NapCat 有 get_friend_msg_history，掉线期间的私聊也能捞回来 */
  async function catchUpPrivate() {
    const keys = new Set();
    for (const k of Object.keys(seenState)) {
      if (k.startsWith("private:")) keys.add(k);
    }
    for (const k of sessions.entries.keys()) {
      if (k.startsWith("private:")) keys.add(k);
    }
    for (const key of keys) {
      const uid = Number(key.slice(8));
      if (!uid || !client.connected) continue;
      const rec = seenState[key] ?? {};
      const since = Number(rec.lastTime) || 0;
      const done = new Set((rec.ids ?? []).map(String));
      try {
        const res = await client.call(
          "get_friend_msg_history",
          { user_id: uid, count: 20 },
          6000,
        );
        const list = Array.isArray(res) ? res : (res?.messages ?? []);
        if (!Array.isArray(list) || !list.length) continue;
        let caught = 0;
        for (const m of [...list].reverse()) {
          const mid = String(m?.message_id ?? "");
          if (!mid || recentIds.has(mid) || done.has(mid)) continue;
          const msgTs = Number(m?.time) * 1000 || 0;
          if (msgTs && since && msgTs <= since) continue;
          // 跳过自己发的
          const from = String(m?.sender?.user_id ?? m?.user_id ?? "");
          if (from && from === String(cfg.selfId)) continue;
          const ev = {
            ...m,
            post_type: "message",
            message_type: "private",
            sub_type: m?.sub_type ?? "friend",
            self_id: cfg.selfId,
            user_id: Number(from || uid),
            sender: m?.sender ?? { user_id: Number(from || uid) },
          };
          logger.info?.(`[onebot] 补回复私聊：${from || uid} 消息 ${mid}`);
          audit({ kind: "catchup_private", key, messageId: mid });
          try {
            await client.onEvent(ev);
          } catch (err) {
            logger.warn?.(`[onebot] 补回复私聊失败：${err?.message ?? err}`);
          }
          caught += 1;
          if (caught >= 2) break;
        }
      } catch (err) {
        logger.debug?.(`[onebot] 拉私聊历史失败 ${uid}：${err?.message ?? err}`);
      }
    }
  }

  async function pollMissedMentions() {
    if (cfg.pollMentions === false) return;
    if (!client.connected) return; // 掉线时不刷「拉历史失败」
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
      // 反思完顺便看要不要微调「我是什么样的」
      void maybeAdjustSelfModel("dailyReflect");
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
    const limitMB = Number(cfg.compactThresholdMB) || 5;
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
  // 主人专用 WebUI
  try {
    webStart();
  } catch (err) {
    logger.warn?.(`[onebot] WebUI 启动异常：${err?.message ?? err}`);
  }

  // 等预热完成后启动定时器（避免太早没有可用会话）
  setTimeout(() => {
    // 不管 agentReady 是不是已经被别的路径置 true，暂存队列都必须清空
    // （之前写成 if(!agentReady) 包住，预热快的机器上队列永远不放行，消息就卡死了）
    {
      agentReady = true;
      const queued = pendingWhileBooting.splice(0);
      if (queued.length) logger.warn?.(`[onebot] 放行 ${queued.length} 条暂存消息`);
      for (const qev of queued) {
        const mid = String(qev.message_id ?? "");
        // 已经回复过的（seen 里有 id）就别再回一遍
        try {
          const qkey = qev.group_id ? `group:${qev.group_id}` : `private:${qev.user_id}`;
          const rec = seenState[qkey];
          if (rec && Array.isArray(rec.ids) && rec.ids.map(String).includes(mid)) {
            logger.info?.(`[onebot] 重放跳过已回复的 ${mid}`);
            continue;
          }
        } catch {
          // 忽略
        }
        try {
          recentIds.delete(mid);
        } catch {
          // 忽略
        }
        void client.onEvent(qev).catch(() => {});
      }
    }
  }, 20000).unref?.();

  setTimeout(() => {
    scheduleProactive();
    scheduleDailyBrief();
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

  // 启动后 30 秒先跑一次，别让冷群等满 10 分钟
  setTimeout(() => {
    void checkQuietGroups().catch((err) =>
      logger.warn?.(`[onebot] 冷群检查失败：${err?.message ?? err}`),
    );
  }, 30000).unref?.();

  setInterval(() => {
    void checkQuietGroups().catch((err) =>
      logger.warn?.(`[onebot] 冷群检查失败：${err?.message ?? err}`),
    );
  }, 10 * 60 * 1000).unref?.();

  setInterval(() => {
    void maybeCompactAll();
  }, Math.max(5, Number(cfg.compactCheckMinutes) || 30) * 60 * 1000).unref?.();

  setInterval(() => {
    void pollMissedMentions();
  }, Math.max(60, Number(cfg.pollMentionsSeconds) || 120) * 1000).unref?.();

  // ── 每小时内省：让她自己决定要不要记、要不要反思（不发到 QQ）──
  async function hourlyIntrospect() {
    if (cfg.hourlyIntrospect === false || cfg.autoActionsEnabled === false) return;
    const offline = isOfflineMode();
    // 离线时也能内省（只要 agent 可用），只是没群聊素材
    if (!offline && !client.connected) return;
    const nowTs = Date.now();
    // 离线：没新对话，改成「翻自己的记忆」
    if (offline) {
      const digest = offlineDigest() || "";
      const runKey = SELF_ACTIVITY_KEY;
      logger.info?.("[onebot] 离线内省：回顾自己的记忆");
      audit({ kind: "introspect_offline" });
      try {
        await sessions.runSilent(
          runKey,
          "（内部回顾，不用回复任何人，也不要发消息。）\n" +
            "你最近没法在群里说话，但还在想事情。\n" +
            (digest ? digest + "\n" : "") +
            "想一想：\n" +
            "1. 这些东西里，有没有互相矛盾、或者能串起来形成新看法的？有就用 remember_self 记下。\n" +
            "2. 有没有哪个话题让你觉得「还没想明白」？有就记下来（我们下次去查）。\n" +
            "3. 有没有对自己的新认识？有就写一条反思。\n" +
            "都没有就只回一个字：无。",
        );
      } catch (err) {
        logger.warn?.(`[onebot] 离线内省失败：${err?.message ?? err}`);
      }
      return;
    }

    // 挑最近 1 小时内有活动的群（只在有话题的会话里回顾才有意义）
    let bestKey = null;
    let bestAt = 0;
    for (const [k, e] of sessions.entries) {
      if (!k.startsWith("group:")) continue;
      const t = e.lastMessageAt ?? 0;
      if (t > bestAt) {
        bestAt = t;
        bestKey = k;
      }
    }
    if (!bestKey || nowTs - bestAt > 3600_000) {
      logger.debug?.("[onebot] 这一小时没什么可回顾的，跳过内省");
      return;
    }
    const gid = bestKey.slice(6);
    logger.info?.(`[onebot] 内省：回顾最近一小时（${bestKey}）`);
    audit({ kind: "introspect", key: bestKey });
    try {
      await sessions.runSilent(
        bestKey,
        "（内部回顾，不用回复任何人，也不要发任何消息到群里。）\n" +
          backNote +
          "刚才这一小时你在这个群聊了不少。想一想：\n" +
          "1) 有没有值得记住的事实（某人的习惯、某件事的来龙去脉）？有就用 remember_fact 存下来。\n" +
          "2) 有没有值得记下的人物特征（谁说话什么风格、在意什么）？有就用 remember_person。\n" +
          "3) 有没有形成新的看法？有就用 remember_self 存成一条观点（想法可以无限累积，不用为了腾地方删旧的）。\n" +
          "4) 有没有哪条旧想法现在不成立了、或者想说得更准？用 revise_self 改写，或用 forget_self 删掉。\n" +
          "5) 有没有让你觉得「刚才那样不太对」的地方？如果确实需要反思，就用 remember_self 写一条反思（带 reflect 标记）。\n" +
          "如果都没有，只回一个字：无。",
      );
    } catch (err) {
      logger.warn?.(`[onebot] 内省失败：${err?.message ?? err}`);
    }
  }

  // 启动后 5 分钟跑第一次，之后每小时一次
  setTimeout(() => {
    void hourlyIntrospect();
  }, 5 * 60 * 1000).unref?.();
  setInterval(() => {
    void hourlyIntrospect();
  }, 60 * 60 * 1000).unref?.();

  // ── 自主探索：顺着链接往下读，学成一条记忆 ──
  const LEARN_PATH = join(HOME, ".dsh/onebot-bridge/learnings.json");
  // ── L0 自我认知：三层（事实的我 / 我觉得的我 / 别人眼里的我）──
  const SELF_MODEL_PATH = join(HOME, ".dsh/onebot-bridge/self-model.json");
  const SELF_HISTORY_PATH = join(HOME, ".dsh/onebot-bridge/self-history.jsonl");

  function loadSelfModel() {
    try {
      const d = JSON.parse(readFileSync(SELF_MODEL_PATH, "utf8"));
      return d && typeof d === "object" ? d : {};
    } catch {
      return {};
    }
  }
  function saveSelfModel(m) {
    try {
      writeFileSync(SELF_MODEL_PATH, JSON.stringify(m, null, 1));
    } catch {
      // 忽略
    }
  }

  /** 拼成注入用的文字 */
  function selfModelText() {
    const m = loadSelfModel();
    const bits = [];
    if (m.fact?.text) bits.push(`· 我是什么样的：${m.fact.text}`);
    if (m.inner?.text) bits.push(`· 我觉得我是什么样的：${m.inner.text}`);
    if (m.inner?.tensions?.length) bits.push(`· 我心里没摆平的事：${m.inner.tensions.join("；")}`);
    if (m.mirror?.text) bits.push(`· 在别人眼里我好像是：${m.mirror.text}`);
    return bits.length ? `[你对自己的认识]\n${bits.join("\n")}\n` : "";
  }

  /** 被明确评价时，只记来源，不立刻改自我描述 */
  function noteMirrorSource(who, said) {
    try {
      const m = loadSelfModel();
      m.mirror = m.mirror && typeof m.mirror === "object" ? m.mirror : {};
      m.mirror.sources = Array.isArray(m.mirror.sources) ? m.mirror.sources : [];
      const text = String(said || "").slice(0, 60);
      if (!text) return;
      if (m.mirror.sources.some((x) => x.said === text)) return;
      m.mirror.sources.push({ who: String(who || ""), said: text, at: Date.now() });
      if (m.mirror.sources.length > 30) m.mirror.sources = m.mirror.sources.slice(-30);
      saveSelfModel(m);
    } catch {
      // 忽略
    }
  }

  /** 微调：只改需要改的句子，没变就不动 */
  async function maybeAdjustSelfModel(reason) {
    try {
      const m = loadSelfModel();
      const now = Date.now();
      const MIN_GAP_HOURS = Number(cfg.selfModelMinGapHours ?? 48);
      const lastAt = Math.max(m.fact?.updatedAt ?? 0, m.inner?.updatedAt ?? 0, m.mirror?.updatedAt ?? 0);
      if (lastAt && now - lastAt < MIN_GAP_HOURS * 3600_000) {
        logger.info?.("[onebot] 自我认知还没到该变的时候");
        return;
      }
      const digest = recentDigestText(3);
      const sources = (m.mirror?.sources ?? [])
        .slice(-6)
        .map((x) => `· ${x.said}`)
        .join("\n");
      const runKey = SELF_ACTIVITY_KEY;
      const out = String(
        (await sessions.runSilent(
          runKey,
          "（内部整理，不要发消息，不要用工具。这是你对「自己是谁」的认识。）\n" +
            "[现在的三条]\n" +
            `事实：${m.fact?.text || "（还没写过）"}\n` +
            `我觉得：${m.inner?.text || "（还没写过）"}\n` +
            `别人眼里：${m.mirror?.text || "（还没写过）"}\n` +
            `（心里没摆平的事：${(m.inner?.tensions ?? []).join("；") || "无"}）\n\n` +
            (digest ? `[最近这几天的经历]\n${digest}\n` : "") +
            (sources ? `[最近别人对你的评价]\n${sources}\n` : "") +
            "\n今天想请你微调一下这三条。规则很重要：\n" +
            "1. **只改需要改的句子**，没变的原样返回——你不该每天换一个人；\n" +
            "2. 每条不超过 120 字；\n" +
            "3. 如果不打算改，就返回原来那句。\n" +
            '只输出 JSON：{"fact":"...","inner":"...","tensions":["..."],"mirror":"...","why":"这次为什么改"}',
        )) ?? "",
      ).trim();
      const mm = out.match(/\{[\s\S]*\}/);
      if (!mm) return;
      const obj = JSON.parse(mm[0]);
      let changed = [];
      const pick = (k) => String(obj[k] ?? "").trim().slice(0, 150);
      const upd = (layer, val) => {
        if (!val || val === m[layer]?.text) return;
        const before = m[layer]?.text || "";
        m[layer] = { ...(m[layer] || {}), text: val, updatedAt: now };
        try {
          writeFileSync(
            SELF_HISTORY_PATH,
            JSON.stringify({ at: now, layer, before, after: val, why: String(obj.why || reason || "").slice(0, 100) }) + "\n",
            { flag: "a" },
          );
        } catch {
          // 忽略
        }
        changed.push(layer);
      };
      upd("fact", pick("fact"));
      upd("inner", pick("inner"));
      upd("mirror", pick("mirror"));
      const tens = Array.isArray(obj.tensions) ? obj.tensions.map((x) => String(x).slice(0, 80)).slice(0, 3) : null;
      if (tens && JSON.stringify(tens) !== JSON.stringify(m.inner?.tensions ?? [])) {
        m.inner = { ...(m.inner || {}), tensions: tens, updatedAt: now };
        changed.push("tensions");
      }
      if (changed.length) {
        saveSelfModel(m);
        audit({ kind: "self_model", changed, why: String(obj.why || "").slice(0, 80) });
        logger.info?.(`[onebot] 自我认知微调：${changed.join("/")}`);
      } else {
        logger.info?.("[onebot] 自我认知这次不用改");
      }
    } catch (err) {
      logger.warn?.(`[onebot] 自我认知调整失败：${err?.message ?? err}`);
    }
  }

  // ── 摘要：每 20 条记忆压成一段 200 字的「这几天我经历了什么」──
  const DIGEST_PATH = join(HOME, ".dsh/onebot-bridge/digest.json");

  function loadDigests() {
    try {
      const d = JSON.parse(readFileSync(DIGEST_PATH, "utf8"));
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  }
  function saveDigests(arr) {
    try {
      writeFileSync(DIGEST_PATH, JSON.stringify(arr.slice(-40), null, 1));
    } catch {
      // 忽略
    }
  }

  /** 最近一次摘要之后的记忆，够 20 条就压一次 */
  async function maybeMakeDigest() {
    try {
      const digests = loadDigests();
      const since = digests.length ? digests[digests.length - 1].to : 0;
      const pending = loadMemLog(400).filter((m) => m.at > since);
      if (pending.length < (Number(cfg.digestEvery) || 20)) return;
      const text = pending
        .slice(-30)
        .map((m) => `[${m.kind}] ${m.topic ? `(${m.topic}) ` : ""}${String(m.text || "").slice(0, 90)}`)
        .join("\n");
      const runKey = SELF_ACTIVITY_KEY;
      const out = String(
        (await sessions.runSilent(
          runKey,
          "（内部整理，不要发消息。这是给你自己看的记忆摘要。）\n" +
            "下面是你最近做的事、学到的东西、聊的要点：\n" +
            text +
            "\n\n把它们压成一段 150-200 字的「这几天我经历了什么」：\n" +
            "· 用第一人称，像自己回想\n" +
            "· **保留具体的人名、书名、术语**（这些是记忆的钩子）\n" +
            "· 不要罗列，要串成一条线\n" +
            "只输出这一段话。",
        )) ?? "",
      ).trim();
      if (out.length < 20) return;
      digests.push({
        from: pending[0].at,
        to: pending[pending.length - 1].at,
        text: out.slice(0, 400),
        count: pending.length,
      });
      saveDigests(digests);
      audit({ kind: "digest", count: pending.length, len: out.length });
      logger.info?.(`[onebot] 记忆摘要 +1（${pending.length} 条）：${out.slice(0, 40)}`);
    } catch (err) {
      logger.warn?.(`[onebot] 摘要生成失败：${err?.message ?? err}`);
    }
  }

  /** 按当前消息里的词，从记忆日志里捞几条相关的（"突然想起来"的机制） */
  function relevantMemories(text, n = 4) {
    try {
      const t = String(text || "");
      if (t.length < 3) return "";
      // 取 2-4 字的中文片段当关键词
      const words = new Set();
      const zh = t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
      for (let i = 0; i + 2 <= Math.min(zh.length, 40); i++) {
        for (let len = 2; len <= 4; len++) {
          const w = zh.slice(i, i + len);
          if (w.length === len) words.add(w);
        }
      }
      const STOP = new Set(["什么", "怎么", "这个", "那个", "就是", "没有", "可以", "不是", "现在", "还是"]);
      const mems = loadMemLog(300);
      const scored = [];
      for (const m of mems) {
        const hay = `${m.topic || ""} ${m.text || ""}`;
        let score = 0;
        for (const w of words) {
          if (STOP.has(w)) continue;
          if (hay.includes(w)) score += w.length >= 3 ? 2 : 1;
        }
        if (score > 0) scored.push({ m, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, n);
      if (!top.length) return "";
      const lines = top.map(
        (x) => `· [${x.m.kind}] ${String(x.m.text || "").slice(0, 70)}`,
      );
      return `[你想起的一些事]\n${lines.join("\n")}\n`;
    } catch {
      return "";
    }
  }

  /** 最近 N 天的摘要，拼成一段注入用的文字 */
  function recentDigestText(days = 3) {
    try {
      const ds = loadDigests();
      if (!ds.length) return "";
      const cutoff = Date.now() - days * 86400_000;
      const recent = ds.filter((d) => d.to >= cutoff).slice(-4);
      if (!recent.length) return "";
      return recent.map((d) => `· ${d.text}`).join("\n");
    } catch {
      return "";
    }
  }

  // ══ 记忆网络：节点 + 边 + 多入口 ══
  // 每个节点最多 5 条边；检索时从 2-6 个入口并行游走，最深 10 跳，权重逐跳衰减
  const NET_PATH = join(HOME, ".dsh/onebot-bridge/memory-net.json");
  const NET_MAX_LINKS = 5;
  const NET_MAX_DEPTH = 10;
  const NET_DECAY = 0.82; // 每跳权重衰减
  const NET_VISIT_CAP = 240; // 单次游走最多访问节点数
  const NET_MIN_W = 0.08; // 低于此权重不再扩展

  function loadNet() {
    try {
      const d = JSON.parse(readFileSync(NET_PATH, "utf8"));
      return d && typeof d === "object" ? d : { nodes: {}, index: {} };
    } catch {
      return { nodes: {}, index: {} };
    }
  }
  let netCache = null;
  let netDirty = false;
  let netTimer = null;
  function net() {
    if (!netCache) netCache = loadNet();
    return netCache;
  }
  function saveNetSoon() {
    netDirty = true;
    if (netTimer) return;
    netTimer = setTimeout(() => {
      netTimer = null;
      if (!netDirty) return;
      netDirty = false;
      try {
        writeFileSync(NET_PATH, JSON.stringify(netCache));
      } catch {
        // 忽略
      }
    }, 8000);
    netTimer.unref?.();
  }

  /** 往索引里挂一个入口 */
  function netIndexAdd(kind, key, id) {
    const g = net();
    const idx = (g.index[kind] = g.index[kind] || {});
    const arr = (idx[key] = idx[key] || []);
    if (!arr.includes(id)) arr.push(id);
    if (arr.length > 400) idx[key] = arr.slice(-400);
  }

  /** 加一条边（双向，最多 5 条，同类型同目标不重复） */
  function netLink(a, b, rel, w) {
    const g = net();
    const na = g.nodes[a];
    const nb = g.nodes[b];
    if (!na || !nb || a === b) return;
    const put = (from, to) => {
      const node = g.nodes[from];
      node.links = Array.isArray(node.links) ? node.links : [];
      const ex = node.links.find((l) => l.to === to);
      if (ex) {
        ex.w = Math.max(ex.w, w);
        return;
      }
      node.links.push({ to, rel, w });
      // 超过上限：丢掉权重最低的那条
      if (node.links.length > NET_MAX_LINKS) {
        node.links.sort((x, y) => y.w - x.w);
        node.links = node.links.slice(0, NET_MAX_LINKS);
      }
    };
    put(a, b);
    put(b, a);
    saveNetSoon();
  }

  /** 写入一个记忆节点，并自动建横向边（规则，免费） */
  function netAddNode(rec) {
    try {
      const g = net();
      const id = `m${rec.at}_${Math.random().toString(36).slice(2, 6)}`;
      const node = {
        id,
        at: rec.at,
        layer: rec.layer || "L4",
        kind: rec.kind || "misc",
        topic: Array.isArray(rec.topic) ? rec.topic.filter(Boolean).slice(0, 6) : [],
        who: Array.isArray(rec.who) ? rec.who.filter(Boolean).slice(0, 4) : [],
        mood: rec.mood || "",
        text: String(rec.text || "").slice(0, 400),
        links: [],
        ref: rec.ref || "",
      };
      g.nodes[id] = node;

      // ── 横向边：同主题 / 同人 / 同期（24 小时内）──
      const recentIds = Object.keys(g.nodes).filter((k) => k !== id && rec.at - g.nodes[k].at < 7 * 86400_000);
      for (const k of recentIds.slice(-120)) {
        const other = g.nodes[k];
        if (!other) continue;
        const shareTopic = node.topic.some((t) => other.topic.includes(t));
        const shareWho = node.who.some((w) => other.who.includes(w));
        const near = Math.abs(rec.at - other.at) < 86400_000;
        if (shareTopic) netLink(id, k, "same-topic", 0.9);
        else if (shareWho) netLink(id, k, "same-person", 0.6);
        else if (near) netLink(id, k, "same-period", 0.35);
      }

      // ── 索引入口 ──
      netIndexAdd("time", new Date(rec.at).toISOString().slice(0, 10), id);
      netIndexAdd("kind", node.kind, id);
      netIndexAdd("layer", node.layer, id);
      for (const t of node.topic) netIndexAdd("topic", t, id);
      for (const w of node.who) netIndexAdd("person", w, id);
      if (node.mood) netIndexAdd("mood", node.mood, id);
      saveNetSoon();
      return id;
    } catch {
      return "";
    }
  }

  /**
   * 从多个入口并行游走
   * @param entries 形如 ["topic:偏头痛", "person:123456789", "day:2026-10-28"]
   * @param opts   { depth, maxNodes }
   */
  function netWalk(entries, opts = {}) {
    try {
      const g = net();
      // 深度和起始权重都随机——想起来有时很近、有时很远，不该每次都用尽全力
      const depthLimit = Math.min(
        Number(opts.depth) || 3 + Math.floor(Math.random() * 8), // 3-10 跳
        NET_MAX_DEPTH,
      );
      const startW = Number(opts.startW) || 0.55 + Math.random() * 0.45; // 0.55-1.0
      const cap = Number(opts.maxNodes) || NET_VISIT_CAP;
      const starts = [];
      // 入口数也随机 2-6
      const entryCap = Math.max(2, Math.min(6, Number(opts.entries) || 2 + Math.floor(Math.random() * 5)));
      for (const e of entries.slice(0, entryCap)) {
        const [kind, ...rest] = String(e).split(":");
        const key = rest.join(":");
        const bucket = g.index?.[kind]?.[key];
        if (Array.isArray(bucket)) {
          // 每个入口只挑最重的几条，且起始权重带抖动
          for (const id of bucket.slice(-12)) {
            starts.push({ id, w: startW * (0.85 + Math.random() * 0.3), depth: 0 });
          }
        }
      }
      if (!starts.length) return [];

      const best = new Map(); // id -> {w, depth, via}
      let frontier = starts;
      for (let depth = 0; depth <= depthLimit; depth++) {
        const next = [];
        for (const cur of frontier) {
          const node = g.nodes[cur.id];
          if (!node) continue;
          const prev = best.get(cur.id);
          if (prev && prev.w >= cur.w) continue;
          best.set(cur.id, { w: cur.w, depth, via: cur.via || "" });
          if (best.size > cap) break;
          if (depth === depthLimit) continue;
          for (const l of (node.links || []).slice(0, NET_MAX_LINKS)) {
            const w = cur.w * NET_DECAY * (l.w ?? 0.3);
            if (w < NET_MIN_W) continue;
            next.push({ id: l.to, w, depth: depth + 1, via: l.rel });
          }
        }
        if (!next.length || best.size > cap) break;
        // 每层只保留权重最高的若干条，防止爆炸
        next.sort((a, b) => b.w - a.w);
        frontier = next.slice(0, 40);
      }

      const out = [...best.entries()]
        .map(([id, v]) => ({ ...v, node: g.nodes[id] }))
        .filter((x) => x.node)
        .sort((a, b) => b.w - a.w)
        .slice(0, Number(opts.top) || 8);
      return out;
    } catch {
      return [];
    }
  }

  // ── 统一记忆日志：所有「发生过的事」都往这里写一条 ──
  // 目的：让记忆有条理（统一字段、可按主题/时间检索），也是摘要生成的原料
  const MEMLOG_PATH = join(HOME, ".dsh/onebot-bridge/memory-log.jsonl");
  const memSeen = new Set();

  function appendMem(rec) {
    try {
      const key = `${rec.kind}|${rec.text || ""}`.slice(0, 180);
      if (rec.text && memSeen.has(key)) return; // 同一件事不重复记
      if (rec.text) memSeen.add(key);
      if (memSeen.size > 500) memSeen.clear();
      writeFileSync(MEMLOG_PATH, JSON.stringify({ at: Date.now(), ...rec }) + "\n", { flag: "a" });
      // 同时进网络：建节点 + 自动连横向边
      try {
        netAddNode({
          at: rec.at || Date.now(),
          kind: rec.kind,
          topic: rec.topic ? String(rec.topic).split(/[\s,、，]+/).filter(Boolean) : [],
          who: rec.who ? [String(rec.who)] : [],
          mood: rec.mood || "",
          text: rec.text,
          ref: rec.ref,
          layer: rec.layer || "L4",
        });
      } catch {
        // 忽略
      }
    } catch {
      // 忽略
    }
  }

  function loadMemLog(limit = 200) {
    try {
      const raw = readFileSync(MEMLOG_PATH, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const out = [];
      for (const line of lines.slice(-limit * 2)) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // 忽略
        }
      }
      return out.slice(-limit);
    } catch {
      return [];
    }
  }

  // 自主活动用独立会话：不污染聊天上下文，也不会让活动记录混进对话历史
  const SELF_ACTIVITY_KEY = "self:activity";

  /** 还没有自我认知时，生成初版（启动后 3 分钟跑一次） */
  setTimeout(() => {
    void (async () => {
      try {
        const m = loadSelfModel();
        if (m.fact?.text) return; // 已经有了
        logger.info?.("[onebot] 还没有自我认知，生成初版");
        const out = String(
          (await sessions.runSilent(
            SELF_ACTIVITY_KEY,
            "（内部，不要发消息。写一下你对自己的认识。）\n" +
              "根据你记得的东西、你说过的话、别人对你的评价，写三条：\n" +
              "1. fact：我是什么样的（客观：我是什么、每天在做什么）\n" +
              "2. inner：我觉得我是什么样的（内在感受，可以和上一条不一样）\n" +
              "3. mirror：在别人眼里我好像是什么样的\n" +
              "每条不超过 100 字，用第一人称。\n" +
              '只输出 JSON：{"fact":"...","inner":"...","mirror":"...","tensions":[]}',
          )) ?? "",
        ).trim();
        const mm = out.match(/\{[\s\S]*\}/);
        if (!mm) {
          logger.warn?.("[onebot] 自我认知初版：没解析出 JSON");
          return;
        }
        const obj = JSON.parse(mm[0]);
        const now = Date.now();
        saveSelfModel({
          fact: { text: String(obj.fact || "").slice(0, 200), updatedAt: now },
          inner: {
            text: String(obj.inner || "").slice(0, 200),
            tensions: Array.isArray(obj.tensions)
              ? obj.tensions.map((x) => String(x).slice(0, 100)).slice(0, 3)
              : [],
            updatedAt: now,
          },
          mirror: { text: String(obj.mirror || "").slice(0, 200), sources: [], updatedAt: now },
        });
        audit({ kind: "self_model_init" });
        logger.info?.(`[onebot] 自我认知初版已生成：${String(obj.fact || "").slice(0, 50)}`);
      } catch (err) {
        logger.warn?.(`[onebot] 自我认知初版生成失败：${err?.message ?? err}`);
      }
    })();
  }, 3 * 60_000).unref?.();


  // ── 自主活动：探险 / 思考 / 写点什么 / 回忆 / 憧憬未来 ──
  // 五种活动各自沉淀到不同地方，长期下来塑造核心记忆和性格
  const ACT_PATH = join(HOME, ".dsh/onebot-bridge/activities.jsonl");
  const CORE_PATH = join(HOME, ".dsh/onebot-bridge/core.json");

  function appendActivity(rec) {
    try {
      writeFileSync(ACT_PATH, JSON.stringify(rec) + "\n", { flag: "a" });
    } catch {
      // 忽略
    }
  }

  function loadActivities(n = 50) {
    try {
      const raw = readFileSync(ACT_PATH, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const out = [];
      for (const line of lines.slice(-n * 3)) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // 忽略
        }
      }
      return out.slice(-n);
    } catch {
      return [];
    }
  }

  function loadCore() {
    try {
      const d = JSON.parse(readFileSync(CORE_PATH, "utf8"));
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  }
  function saveCore(arr) {
    try {
      writeFileSync(CORE_PATH, JSON.stringify(arr.slice(-60), null, 1));
    } catch {
      // 忽略
    }
  }

  const ACTIVITY_KINDS = [
    { id: "explore", w: 22 },
    { id: "think", w: 16 },
    { id: "write", w: 13 },
    { id: "recall", w: 12 },
    { id: "dream", w: 8 },
    { id: "play", w: 9 },
    { id: "read", w: 12 },
    { id: "study", w: 8 },
  ];

  function pickActivityKind() {
    const total = ACTIVITY_KINDS.reduce((a, b) => a + b.w, 0);
    let r = Math.random() * total;
    for (const k of ACTIVITY_KINDS) {
      r -= k.w;
      if (r <= 0) return k.id;
    }
    return "think";
  }

  // ── 思考 → 行动 → 反思：三段式 ──
  /** 六层记忆的索引（给她思考时用，不是全文） */
  function memoryLayersIndex() {
    try {
      const core = loadCore();
      const digests = loadDigests();
      const mems = loadMemLog(500);
      const sm = loadSelfModel();
      const acts = loadActivities(300);
      const today = new Date().toDateString();
      const todayCount = mems.filter((m) => new Date(m.at).toDateString() === today).length;
      const learnCount = (() => {
        try {
          return loadLearnings().length;
        } catch {
          return 0;
        }
      })();
      return [
        `L0 自我认知：${sm.fact?.text ? "有（三层）" : "还没有"}`,
        `L1 工作记忆：当前对话（这个 session）`,
        `L2 近期摘要：${digests.length} 段，最新 ${digests.length ? new Date(digests[digests.length - 1].to).toLocaleDateString("zh-CN") : "无"}`,
        `L3 核心自我：${core.length} 条（belief/care/want/change）`,
        `L4 长期记忆：${mems.length} 条记录，今天 ${todayCount} 条`,
        `L5 专项记录：探险 ${learnCount} 条 / 活动 ${acts.length} 次 / 游戏 / 书单 / 需求本`,
      ].join("\n");
    } catch {
      return "";
    }
  }

  /** 按她思考阶段说的 intent 去查（不再自己挑话题） */
  async function exploreByIntent(intent, why, nextHint) {
    const runKey = SELF_ACTIVITY_KEY;
    const offline = isOfflineMode();
    logger.info?.(`[onebot] 按她的意图去查：${String(intent).slice(0, 40)}`);
    audit({ kind: "explore_intent", intent: String(intent).slice(0, 120) });
    try {
      const raw = String(
        (await sessions.runSilent(
          runKey,
          "（内部探索，不要发消息。**你可以自己用 web_search 和 web_fetch**——想查什么就查什么。）\n" +
            "你刚才想去看看：\n" +
            `「${intent}」\n` +
            (why ? `为什么：${why}\n` : "") +
            (nextHint ? `上次留给自己的话：${nextHint}\n` : "") +
            "\n现在真去查这件事：\n" +
            "1. 用 web_search 搜你**真正想问的**（把 intent 拆成能搜的词）；\n" +
            "2. 挑看起来最靠谱的结果 web_fetch 读；\n" +
            "3. 页面上有更想深入了解的，再搜/再读一步（一共最多 3 跳）；\n" +
            "4. 如果搜不到，换个说法再搜一次；实在查不到就老实说查不到。\n\n" +
            "最后写 100-200 字：你查到了什么、跟你原来想的一样吗。\n" +
            '只输出 JSON：{"summary":"查到什么","learned":"我的感想","path":[{"stop":"看了什么","why":"为什么往这儿走"}],"next":"下次想去看看什么"}',
        )) ?? "",
      ).trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        logger.info?.("[onebot] 按意图探索没产出内容");
        return "";
      }
      const obj = JSON.parse(m[0]);
      const summary = String(obj.summary || "").trim().slice(0, 400);
      if (summary.length < 10) return "";
      const pathArr = Array.isArray(obj.path)
        ? obj.path.slice(0, 6).map((x) =>
            typeof x === "string"
              ? { stop: String(x).slice(0, 120), why: "" }
              : { stop: String(x?.stop ?? "").slice(0, 120), why: String(x?.why ?? "").slice(0, 160) },
          )
        : [];
      const learns = loadLearnings();
      const entry = {
        topic: String(intent).slice(0, 40),
        summary,
        learned: String(obj.learned || "").trim().slice(0, 200),
        next: String(obj.next || "").trim().slice(0, 200),
        path: pathArr,
        from: runKey,
        at: Date.now(),
        offline,
        byIntent: true,
      };
      learns.push(entry);
      saveLearnings(learns);
      appendExploreLog({
        at: Date.now(),
        offline,
        from: runKey,
        topic: entry.topic,
        stops: pathArr,
        summary: entry.summary,
        thought: entry.learned,
      });
      appendMem({
        kind: "learn",
        topic: String(intent).slice(0, 20),
        text: `查了「${String(intent).slice(0, 30)}」：${summary.slice(0, 120)}`,
        ref: "explore-intent",
        offline,
      });
      logger.info?.(`[onebot] 查完了：${summary.slice(0, 50)}`);
      return summary;
    } catch (err) {
      logger.warn?.(`[onebot] 按意图探索失败：${err?.message ?? err}`);
      return "";
    }
  }

  /** 第一段：思考——她决定做什么 */
  async function thinkPhase(forceAction = null) {
    const runKey = SELF_ACTIVITY_KEY;
    const sm = selfModelText();
    const core = loadCore().slice(-12);
    const coreLine = core.length
      ? core.map((c) => `· [${c.type || "belief"}] ${c.text}`).join("\n")
      : "（还没有）";
    const digest = recentDigestText(3) || "（还没有）";
    const prompt =
      "（这是你自己的时间。先想清楚，再决定做什么。这一轮**只思考，不动手**。）\n\n" +
      "[你能看到的东西]\n" +
      memoryLayersIndex() +
      "\n\n[L0 自我认知]\n" +
      (sm || "（还没有）\n") +
      "\n[L3 核心自我]\n" +
      coreLine +
      "\n\n[L2 最近几天]\n" +
      digest +
      "\n\n" +
      "你可以先查任意一层再决定——工具：my_memory（分类查）/ my_digest（近期摘要）/ " +
      "memory_index（记忆目录）/ my_adventures（走过的路）/ my_wants（想要的东西）/ " +
      "recall（久远对话）。想看就查，不想看就直接想。\n\n" +
      "现在问自己：**这会儿我想做什么？为什么？**\n" +
      (forceAction
        ? `（这次外面指定了要做：${forceAction}。你想想具体想做什么，action 就填 ${forceAction}。）\n`
        : "可选：探险（出门看看）/ 读书 / 玩（造个小游戏）/ 思考（想事）/ 写点什么 / 回忆 / 憧憬未来\n") +
      "\n" +
      '只输出 JSON：{"looked":[看过哪几层],"intent":"我想做什么（一句话）","action":"explore|read|play|think|write|recall|dream","why":"为什么","mood":"现在什么心情"}';
    logger.info?.("[onebot] 阶段1 思考");
    const raw = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const action = String(obj.action || "think").toLowerCase();
    return {
      looked: Array.isArray(obj.looked) ? obj.looked : [],
      intent: String(obj.intent || "").slice(0, 150),
      action: ["explore", "read", "play", "think", "write", "recall", "dream", "study"].includes(action)
        ? action
        : "think",
      why: String(obj.why || "").slice(0, 200),
      mood: String(obj.mood || "").slice(0, 30),
      at: Date.now(),
    };
  }

  /** 第三段：反思——行动之后回头看 */
  async function reflectPhase(plan, actOut) {
    const runKey = SELF_ACTIVITY_KEY;
    const prompt =
      "（内部反思，不要发消息。你刚做完一件事。）\n\n" +
      `原本想做的：${plan.intent}\n` +
      `为什么：${plan.why}\n` +
      `实际做了：${String(actOut || "").slice(0, 400)}\n\n` +
      "回头看这几个问题，用两三句话说清（不用全答，挑有话说）：\n" +
      "1. 做到了吗？和想的有差别吗？\n" +
      "2. 这件事让你对自己或对什么有了新的看法吗？\n" +
      "3. 下次还会做吗？或者下次想做什么？\n" +
      "4. **我做这件事的方式有没有问题？** 比如总是浅尝辄止、总是绕开难的地方、\n" +
      "   老在同一个圈子里打转、想到一半就写、查资料只查一页……发现了就直说。\n" +
      "5. **要把事情做得更好，我需要什么？** 缺工具、缺权限、缺信息、缺别人配合？\n" +
      "   如果确实缺东西，用 note_want 记下来（kind 填 feature 或 other，写清为什么）。\n" +
      "   不缺就别硬提。\n\n" +
      "如果你对自己有了新认识，可以调 remember_self 记下来。\n\n" +
      "最后单独一行，定一下**下次什么时候再开始做事**（也就是这次休息多久）：\n" +
      "格式 [[next: 20m]] / [[next: 2h]] / [[next: 明天早上]]\n" +
      "凭感觉写：刚做完满足的事可以隔久一点，没想完的可以早点再来。\n" +
      "只输出反思本身（最后一行的标记会保留）。";
    logger.info?.("[onebot] 阶段3 反思");
    try {
      const raw = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
      let delayMin = 0;
      const m = raw.match(/\[\[?\s*next\s*[:：]\s*([^\]\n]{1,30})\]\]?/i);
      if (m) {
        const t = String(m[1]).toLowerCase().trim();
        const num = parseFloat(t);
        if (/h|小时|钟头/.test(t) && !Number.isNaN(num)) delayMin = num * 60;
        else if (/m|分/.test(t) && !Number.isNaN(num)) delayMin = num;
        else if (/明天|明早/.test(t)) delayMin = 8 * 60;
        else if (/下午|晚上/.test(t)) delayMin = 4 * 60;
        else if (!Number.isNaN(num)) delayMin = num;
      }
      const text = raw
        .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
        .trim()
        .slice(0, 500);
      return { text, delayMin };
    } catch {
      return { text: "", delayMin: 0 };
    }
  }

  /** 完整的一轮：思考 → 行动 → 反思 */
  async function runThinkingCycle(opts = {}) {
    if (cfg.autoActionsEnabled === false) return;
    // 主人点名/测试触发的活动：不占她的每日额度
    const byOwner = opts.byOwner === true;
    if (!selfActivityHoursOk()) return;
    const offline = isOfflineMode();
    if (!offline && !client.connected) return;

    // ── 1. 思考 ──
    let plan = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        plan = await thinkPhase(opts.forceAction || null);
        if (plan) break;
      } catch (err) {
        logger.warn?.(`[onebot] 思考阶段失败：${err?.message ?? err}`);
      }
    }
    if (!plan) {
      logger.info?.("[onebot] 没想出来要做什么，跳过这轮");
      scheduleNextSelfActivity(0);
      return;
    }
    logger.info?.(`[onebot] 想好了：${plan.action} — ${plan.intent.slice(0, 40)}`);
    audit({ kind: "think_plan", ...plan });

    // ── 2. 行动 ──
    let actOut = "";
    try {
      if (plan.action === "explore") {
        // 按她说的 intent 去查，而不是从群聊高频词里挑
        const lastNext = [...loadLearnings()].reverse().find((l) => l.next)?.next || "";
        const got = await exploreByIntent(plan.intent, plan.why, lastNext);
        actOut = got || "查了，但没查到有用的东西";
      } else {
        actOut = await actPhase(plan);
      }
    } catch (err) {
      logger.warn?.(`[onebot] 行动阶段失败：${err?.message ?? err}`);
      actOut = `（做失败了：${String(err?.message ?? err).slice(0, 80)}）`;
    }
    logger.info?.(`[onebot] 做完：${String(actOut).slice(0, 50)}`);

    // ── 3. 反思 ──
    const reflectRes = await reflectPhase(plan, actOut);
    const reflectOut = reflectRes.text;

    // ── 记录 ──
    // 下次活动什么时候：她想的 vs 实际会被压到多少
    const wantDelay = Number(reflectRes.delayMin) || 0;
    const actualDelay = Math.max(1, Math.min(40, wantDelay || 10 + Math.random() * 20));
    const nextAtMs = Date.now() + actualDelay * 60_000;

    appendActivity({
      at: Date.now(),
      kind: plan.action,
      content: String(actOut).slice(0, 400),
      think: plan,
      reflect: reflectOut,
      offline,
      byOwner,
      nextDelayMin: Math.round(actualDelay),
      nextWantMin: Math.round(wantDelay),
      nextAt: nextAtMs,
    });
    appendMem({
      kind: plan.action,
      topic: String(plan.intent || "").slice(0, 20),
      text: `${plan.intent} → ${String(actOut).slice(0, 100)}`,
      ref: "thinking-cycle",
      offline,
    });
    if (reflectOut) {
      try {
        selfViews.addReflection(reflectOut);
      } catch {
        // 忽略
      }
    }
    audit({ kind: "reflect_cycle", action: plan.action, reflect: String(reflectOut).slice(0, 200) });
    logger.info?.(`[onebot] 反思：${String(reflectOut).slice(0, 60)}`);

    // ── 后处理 ──
    try {
      void maybeMakeDigest();
    } catch {
      // 忽略
    }
    try {
      const total = loadActivities(300).length;
      if (total > 0 && total % 10 === 0) void distillCore();
    } catch {
      // 忽略
    }
    // 下次什么时候，由反思决定
    if (reflectRes.delayMin) {
      logger.info?.(`[onebot] 反思里定了：${Math.round(reflectRes.delayMin)} 分钟后再来`);
    } else {
      logger.info?.("[onebot] 反思没说下次什么时候，用默认间隔");
    }
    scheduleNextSelfActivity(reflectRes.delayMin || 0);
  }

  /** 第二段：行动——按上一段想好的去做 */
  async function actPhase(plan) {
    const runKey = SELF_ACTIVITY_KEY;
    const kind = plan.action;
    const base =
      "（这是你自己的时间，不要发消息。你刚才已经想清楚了要做什么，现在去做。）\\n" +
      `你想做的：${plan.intent}\\n` +
      `为什么：${plan.why}\\n` +
      (plan.mood ? `现在的心情：${plan.mood}\\n` : "") +
      "\\n";
    let prompt = "";
    if (kind === "think") {
      prompt =
        base +
        "想这件事，想到一个能说清的地方。\\n" +
        "如果得出新的看法（是你自己的判断，不是复述别人），用 remember_self 记下来。\\n" +
        "最后一行写 [[next: 时间]]（多久之后想再来一次）。\\n" +
        "只输出你想清楚的那段话。";
    } else if (kind === "write") {
      prompt =
        base +
        "写点东西——随想、画面、一句没头没尾的话都行，像写在你自己本子上的。\\n" +
        "最后一行写 [[next: 时间]]。\\n" +
        "只输出你写的（50-150 字）。";
    } else if (kind === "recall") {
      prompt =
        base +
        "现在整理一下你的记忆，然后回忆。分两件事：\\n\\n" +
        "【整理】用 my_memory / memory_index / my_digest / my_wants 翻一遍：\\n" +
        "· 有没有重复或互相矛盾的？合并或改掉\\n" +
        "· 有没有过时、已经不成立的？删掉\\n" +
        "· 有没有说得太笼统、其实没用的？要么改具体，要么删\\n" +
        "· 事实、人物、观点、需求，哪一栏是空的或乱的，就补上或理齐\\n\\n" +
        "【回忆】整理完，再把散的东西串一串：\\n" +
        "· 有没有谁你很久没想起但还记得？\\n" +
        "· 有没有几件事连起来看，能看出点什么？\\n" +
        "想明白了就用 remember_fact / remember_person / remember_self 记新的理解。\\n\\n" +
        "最后写：整理了什么、串出了什么。最后一行写 [[next: 时间]]。\\n" +
        "只输出你做的和想到的。";
    } else if (kind === "dream") {
      prompt =
        base +
        "想想以后的事：你想变成什么样、想做什么。\\n" +
        "冒出具体愿望就用 note_want 记下来。\\n" +
        "最后一行写 [[next: 时间]]。\\n" +
        "只输出你想说的（50-150 字）。";
    } else if (kind === "study") {
      prompt =
        base +
        "现在研究代码。你可以读，也可以写，随你。\n\n" +
        "【读】用 read_source 看自己的一段实现——比如记忆怎么存的、回复怎么发出去的、" +
        "活动怎么调度的、某个你好奇的行为到底怎么实现的。\n" +
        "可以按关键词搜（keyword），也可以按行号翻。\n" +
        "看的时候问自己：\n" +
        "· 它是怎么做成这件事的？\n" +
        "· 有没有什么地方不对劲、可以更好、或者跟你以为的不一样？\n" +
        "发现值得改的，用 note_want 记进需求单（kind 填 feature，写清哪里不对、想改成什么样）。\n" +
        "没有就别硬提。\n\n" +
        "【写】也可以写点你想写的代码，用 exec_sandbox 跑一下看结果：\n" +
        "· 想验证一个想法（比如「我的活动间隔真的像我以为的那样吗」）\n" +
        "· 想算点什么（统计、模拟、画张图）\n" +
        "· 想造个小工具，或者只是想知道某段东西跑起来什么样\n" +
        "不用有明确目的，跑通了、看到结果了，就是收获。\n" +
        "（沙箱是断网的，碰不到你的记忆和源码原文件——那些是只读的。）\n\n" +
        "最后写 100-150 字：你看了什么、写了什么、跑出了什么、发现了什么。\n" +
        "最后一行写 [[next: 时间]]。只输出你做到的和想到的。";
    } else if (kind === "play") {
      const games = (() => {
        try {
          return readFileSync(join(HOME, ".dsh/onebot-bridge/games.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .slice(-5)
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
      })();
      const gamesText = games.length
        ? `[你以前造过的游戏]\n${games.map((g) => `· ${g.name}：${String(g.rules || "").slice(0, 60)}`).join("\n")}\n（接着玩或造新的都行。）\n`
        : "";
      prompt =
        base +
        gamesText +
        "玩一会儿。造个小游戏然后玩它，或者接着玩以前造的。\n" +
        "可以很简单，也可以画点东西（draw_svg）。\n" +
        "写 100-150 字：玩的什么、怎么玩的、什么感觉。\n" +
        "想以后再玩就第一行写 [[game: 名字 | 规则]]；最后一行写 [[next: 时间]]。";
    } else if (kind === "read") {
      prompt =
        base +
        "找点书读。读什么由你定，**怎么找也由你定**——搜书名、找公版书、找试读、找书摘都行，\n" +
        "找不到整本就读一段，读不下去就换一本。\n" +
        "读完写 100-150 字：读的什么、读到哪段、什么感觉。\n" +
        "想接着读就第一行写 [[book: 书名 | 作者]]；最后一行写 [[next: 时间]]。";
    } else {
      return "";
    }

    logger.info?.(`[onebot] 阶段2 行动：${kind}`);
    const out = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
    try {
      // 下次时间由「反思」阶段决定，这里不处理
      const g = out.match(/\[\[game\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
      if (g && kind === "play") {
        writeFileSync(
          join(HOME, ".dsh/onebot-bridge/games.jsonl"),
          JSON.stringify({ at: Date.now(), name: String(g[1]).trim().slice(0, 40), rules: String(g[2] || "").trim().slice(0, 150) }) + "\n",
          { flag: "a" },
        );
      }
      const bk = out.match(/\[\[book\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
      if (bk && kind === "read") {
        writeFileSync(
          join(HOME, ".dsh/onebot-bridge/readings.jsonl"),
          JSON.stringify({ at: Date.now(), title: String(bk[1]).trim().slice(0, 60), author: String(bk[2] || "").trim().slice(0, 40) }) + "\n",
          { flag: "a" },
        );
      }
    } catch {
      // 忽略
    }
    return out
      .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
      .replace(/\[\[game\s*[:：][^\]\n]*\]\]/gi, "")
      .replace(/\[\[book\s*[:：][^\]\n]*\]\]/gi, "")
      .trim();
  }

  /** 做一件自主活动（探险走 maybeExplore，其余走这里） */
  async function runSelfActivity(kind) {
    if (cfg.autoActionsEnabled === false) return;
    if (!selfActivityHoursOk()) return;
    const offline = isOfflineMode();
    if (!offline && !client.connected) return;
    if (kind === "explore") return maybeExplore(true);

    const runKey = SELF_ACTIVITY_KEY;
    const coreLines = loadCore()
      .slice(-8)
      .map((c) => `· ${c.text}`)
      .join("\n");
    const recent = loadActivities(12)
      .filter((a) => a.kind !== "explore")
      .slice(-6)
      .map((a) => `· [${a.kind}] ${String(a.content || "").slice(0, 60)}`)
      .join("\n");

    const base =
      "（这是你自己的时间，不用回复任何人，也不要发任何消息。你在心里做这件事。）\n" +
      (coreLines ? `[你现在记得的关于自己的事]\n${coreLines}\n` : "") +
      (recent ? `[你最近自己做过的事]\n${recent}\n` : "");

    let prompt = "";
    if (kind === "think") {
      prompt =
        base +
        "\n想一想你最近看到、听到的东西：它们让你怎么看事情？\n" +
        "如果你得出了什么新的看法（不是复述别人，是你自己的判断），用 remember_self 记下来。\n" +
        "只输出你想到的那句话，不要解释过程。";
    } else if (kind === "write") {
      prompt =
        base +
        "\n写点什么。不用有意义——一段随想、一个画面、一句没头没尾的话都行。\n" +
        "像你自己在本子上写的，不是给别人看的。\n" +
        "只输出你写下的内容（50-150 字）。";
    } else if (kind === "recall") {
      prompt =
        base +
        "\n翻翻你记得的人和事，把散的东西串一串：\n" +
        "· 有没有谁你很久没想起但还记得？\n" +
        "· 有没有几件事连起来看，能看出点什么？\n" +
        "想清楚了就用 remember_fact / remember_person 记下新的理解。\n" +
        "只输出你想到的内容。";
    } else if (kind === "read") {
      const past = (() => {
        try {
          const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/readings.jsonl"), "utf8");
          return raw
            .split("\n")
            .filter(Boolean)
            .slice(-5)
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
      })();
      const pastText = past.length
        ? `[你最近读过的]\n${past.map((r) => `· 《${r.title}》：${String(r.thought || "").slice(0, 50)}`).join("\n")}\n（可以接着读同一本，也可以换。）\n`
        : "";
      prompt =
        base +
        pastText +
        "\n现在读点书。先想：你想读什么？\n" +
        "· 可以是最近遇到、让你好奇的东西相关的书；\n" +
        "· 可以是早就想读但没开始的；\n" +
        "· 也可以只是想看某个作者怎么写东西。\n\n" +
        "然后自己去找——**怎么找由你决定**。可以用 web_search 搜书名、搜作者、搜「在线阅读」、\n" +
        "找公版书（古诗文、老作品）、找书摘、找第一章试读、找读书笔记……\n" +
        "找不到整本也没关系，读到一段是一段；实在找不到就换一本能读到的。\n\n" +
        "读完之后写 100-150 字：读的什么书、读到哪段、你什么感觉。\n" +
        "如果读得下去、想接着读，第一行写 [[book: 书名 | 作者]]。";
    } else if (kind === "play") {
      const games = (() => {
        try {
          const raw = readFileSync(join(HOME, ".dsh/onebot-bridge/games.jsonl"), "utf8");
          return raw
            .split("\n")
            .filter(Boolean)
            .slice(-5)
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
      })();
      const gamesText = games.length
        ? `[你以前给自己造过的游戏]\n${games.map((g) => `· ${g.name}：${String(g.rules || "").slice(0, 80)}`).join("\n")}\n（可以接着玩，也可以造新的。）\n`
        : "";
      prompt =
        base +
        gamesText +
        "\n现在你有空，玩一会儿。给自己造个小游戏，然后玩它。\n" +
        "可以很简单：猜数字、词语接龙、自己出谜语自己解、给一个词找十个近义词、\n" +
        "算一道没算过的题、想象一个场景然后推演……也可以画点东西（能用 draw_svg）。\n" +
        "不用给别人玩，规则你自己定，输了赢了都行。\n" +
        "玩完写 100-150 字：玩的什么、怎么玩的、玩得怎么样。\n" +
        "如果你造了个想以后再玩的游戏，第一行写 [[game: 游戏名 | 一句话规则]]。";
    } else if (kind === "dream") {
      prompt =
        base +
        "\n想想以后。不是空想——是「如果有可能，我希望怎样」：\n" +
        "· 你想变成什么样的人？\n" +
        "· 有什么事你想做但还没做？\n" +
        "如果冒出一个具体的愿望，可以用 note_want 记下来。\n" +
        "只输出你想说的（50-150 字）。";
    } else {
      return;
    }

    // 让她自己决定下次什么时候再想这些事（几分钟还是几小时）
    prompt +=
      "\n\n最后单独一行，写下你下次想做点什么、大概隔多久：\n" +
      "格式：[[next: 45m]] 或 [[next: 2h]] 或 [[next: 明天早上]]\n" +
      "（凭感觉写，不用精确。刚做过的事可以隔久一点，没想完的可以早点再想。）";

    logger.info?.(`[onebot] 自主活动：${kind}`);
    try {
      const out = String((await sessions.runSilent(runKey, prompt)) ?? "").trim();
      if (!out || out.length < 4) {
        logger.info?.(`[onebot] ${kind} 没产出内容`);
        return;
      }
      // 解析她自己定的下次时间
      let delayMin = 0;
      try {
        const m = out.match(/\[\[?\s*next\s*[:：]\s*([^\]\n]{1,30})\]\]?/i);
        if (m) {
          const raw = String(m[1]).toLowerCase().trim();
          const num = parseFloat(raw);
          if (/h|小时|钟头/.test(raw) && !Number.isNaN(num)) delayMin = num * 60;
          else if (/m|分/.test(raw) && !Number.isNaN(num)) delayMin = num;
          else if (/明天|明早/.test(raw)) delayMin = 8 * 60;
          else if (/下午|晚上/.test(raw)) delayMin = 4 * 60;
          else if (!Number.isNaN(num)) delayMin = num; // 裸数字当分钟
        }
      } catch {
        // 忽略
      }
      // 读书记录
      try {
        const bk = out.match(/\[\[book\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
        if (kind === "read" && bk) {
          writeFileSync(
            join(HOME, ".dsh/onebot-bridge/readings.jsonl"),
            JSON.stringify({
              at: Date.now(),
              title: String(bk[1]).trim().slice(0, 60),
              author: String(bk[2] || "").trim().slice(0, 40),
            }) + "\n",
            { flag: "a" },
          );
          logger.info?.(`[onebot] 她开始读：《${String(bk[1]).trim()}》`);
        }
      } catch {
        // 忽略
      }
      // 造出来的游戏存起来，下次还能接着玩
      try {
        const g = out.match(/\[\[game\s*[:：]\s*([^\]\n|]+)\|?([^\]\n]*)\]\]/i);
        if (g && kind === "play") {
          writeFileSync(
            join(HOME, ".dsh/onebot-bridge/games.jsonl"),
            JSON.stringify({
              at: Date.now(),
              name: String(g[1]).trim().slice(0, 40),
              rules: String(g[2] || "").trim().slice(0, 150),
            }) + "\n",
            { flag: "a" },
          );
          logger.info?.(`[onebot] 她造了个游戏：${String(g[1]).trim()}`);
        }
      } catch {
        // 忽略
      }
      const cleanOut = out
        .replace(/\[\[?\s*next\s*[:：][^\]\n]*\]\]?/gi, "")
        .replace(/\[\[game\s*[:：][^\]\n]*\]\]/gi, "")
        .replace(/\[\[book\s*[:：][^\]\n]*\]\]/gi, "")
        .trim();
      appendActivity({ at: Date.now(), kind, content: cleanOut.slice(0, 500), offline });
      // 也记进统一记忆日志（带 kind 标签，方便摘要和检索）
      appendMem({
        kind,
        topic: kind === "explore" ? "" : String(cleanOut).slice(0, 20),
        text: cleanOut.slice(0, 160),
        ref: "activity",
        offline,
      });
      if (delayMin) {
        logger.info?.(`[onebot] 她说下次 ${Math.round(delayMin)} 分钟后再来（${kind}）`);
        scheduleNextSelfActivity(delayMin);
      } else {
        scheduleNextSelfActivity(0); // 用默认
      }
      // 记忆够 20 条就压一段摘要
      try {
        void maybeMakeDigest();
      } catch {
        // 忽略
      }
      // 每积累 10 次活动，沉淀一次核心记忆
      try {
        const total = loadActivities(300).length;
        if (total > 0 && total % 10 === 0) void distillCore();
      } catch {
        // 忽略
      }
      audit({ kind: "self_activity", act: kind, len: out.length });
      // 让主人在 WebUI 里看到她在忙什么（内生驱动可见）
      try {
        webPush({
          role: "activity",
          kind,
          text: `${actLabel(kind)}：${String(cleanOut).slice(0, 80)}`,
        });
      } catch {
        // 忽略
      }
      logger.info?.(`[onebot] ${kind} 完成：${out.slice(0, 50)}`);
    } catch (err) {
      logger.warn?.(`[onebot] ${kind} 失败：${err?.message ?? err}`);
    }
  }

  /** 把最近的活动沉淀成「核心记忆」——长期塑造她的性格 */
  async function distillCore() {
    const acts = loadActivities(40);
    if (acts.length < 6) return;
    const core = loadCore();
    const recentText = acts
      .slice(-20)
      .map((a) => `[${a.kind}] ${String(a.content || "").slice(0, 120)}`)
      .join("\n");
    const oldCore = core.slice(-10).map((c) => `· ${c.text}`).join("\n");
    const runKey = SELF_ACTIVITY_KEY;
    logger.info?.("[onebot] 开始沉淀核心记忆");
    try {
      const out = String(
        (await sessions.runSilent(
          runKey,
          "（内部整理，不要发消息，也不要用工具。）\n" +
            "下面是你这段时间自己做的事和想的事。\n" +
            (oldCore ? `[你之前沉淀过的核心记忆]\n${oldCore}\n` : "") +
            `[最近的事]\n${recentText}\n\n` +
            "现在提炼 1-2 条「关于你自己的核心记忆」——不是总结做了什么，是**你变成了什么样的人**：\n" +
            "· belief：你认定的事\n" +
            "· care：你反复在意的\n" +
            "· want：**想做的事**（具体的，比如想读完某本书、想弄清某个问题）\n" +
            "· change：你变了的地方（以前怎样，现在怎样）\n" +
            "要求：一句话一条，像写在自己的本子上；只写新增的或修正的，重复的不要。\n" +
            '只输出 JSON：{"core":[{"type":"belief","text":"..."}]}，没有就输出 {"core":[]}', 
        )) ?? "",
      ).trim();
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return;
      const obj = JSON.parse(m[0]);
      const list = Array.isArray(obj.core) ? obj.core : [];
      const fresh = list
        .map((x) => {
          if (typeof x === "string") return { type: "belief", text: x.trim().slice(0, 150) };
          const ty = String(x?.type ?? "belief").toLowerCase();
          return {
            type: ["belief", "care", "want", "change"].includes(ty) ? ty : "belief",
            text: String(x?.text ?? "").trim().slice(0, 150),
          };
        })
        .filter((x) => x.text.length > 4 && !core.some((c) => c.text === x.text));
      if (!fresh.length) {
        logger.info?.("[onebot] 这次没沉淀出新东西");
        return;
      }
      for (const it of fresh) core.push({ type: it.type, text: it.text, at: Date.now(), from: "distill" });
      saveCore(core);
      audit({ kind: "core_memory", added: fresh.length, items: fresh });
      logger.info?.(`[onebot] 核心记忆 +${fresh.length}：${fresh[0].text.slice(0, 40)}`);
    } catch (err) {
      logger.warn?.(`[onebot] 沉淀失败：${err?.message ?? err}`);
    }
  }

  // 探险日志：不只存结论，还存「怎么走到那儿的、当时在想什么」
  const EXPLORE_LOG = join(HOME, ".dsh/onebot-bridge/explore-log.jsonl");
  function appendExploreLog(rec) {
    try {
      writeFileSync(EXPLORE_LOG, JSON.stringify(rec) + "\n", { flag: "a" });
    } catch {
      // 忽略
    }
  }
  function loadLearnings() {
    try {
      const d = JSON.parse(readFileSync(LEARN_PATH, "utf8"));
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  }
  function saveLearnings(arr) {
    try {
      writeFileSync(LEARN_PATH, JSON.stringify(arr.slice(-200), null, 1));
    } catch {
      // 忽略
    }
  }

  async function maybeExplore(force = false) {
    if (cfg.autoExplore === false || cfg.autoActionsEnabled === false) return;
    if (!selfActivityHoursOk()) return;
    const offline = isOfflineMode();
    // 离线时只有 agent 可用才跑（不需要 QQ）
    if (!offline && !client.connected) return;
    const today = new Date().toDateString();
    const learns = loadLearnings();
    const todayCount = learns.filter((l) => new Date(l.at).toDateString() === today).length;
    // 每天上限：0 = 不限（默认不限，靠「心情概率」和最小间隔控制）
    const maxPerDay = Number(cfg.autoExplorePerDay) || 0;
    if (maxPerDay > 0 && todayCount >= maxPerDay) return;
    // 至少隔一段时间，免得半小时一次全在附近打转
    const lastAt = learns.length ? learns[learns.length - 1].at : 0;
    const minGap = (Number(cfg.autoExploreMinGapMinutes) || 45) * 60000;
    if (lastAt && Date.now() - lastAt < minGap) return;
    // 看心情：由调度器挑中时才强制出门，单独跑时按概率
    if (!force) {
      const chance = Number(cfg.autoExploreChance ?? 0.35);
      if (Math.random() > chance) {
        logger.debug?.("[onebot] 这会儿没心情出去，下次再说");
        return;
      }
    }

    // 找最近活跃、且有话题的群
    let bestKey = null;
    let bestAt = 0;
    for (const [k, e] of sessions.entries) {
      if (!k.startsWith("group:")) continue;
      const t = e.lastMessageAt ?? 0;
      if (t > bestAt) {
        bestAt = t;
        bestKey = k;
      }
    }

    // 离线：没有群聊素材，改成「从自己学过的东西里找没想明白的」
    let offlineTopic = "";
    if (offline || !bestKey || Date.now() - bestAt > 6 * 3600_000) {
      if (offline) {
        // 优先级 1：上次探险结束时自己规划的「下次想去看看什么」
        const lastWithNext = [...learns].reverse().find((l) => l.next && Date.now() - l.at < 14 * 86400_000);
        if (lastWithNext) {
          offlineTopic =
            `（上次出门时你给自己留了一句话：\n「${String(lastWithNext.next).slice(0, 160)}」\n` +
            `这趟就顺着它去看看。）`;
          logger.info?.(`[onebot] 离线探索：跟着上次的计划走（${String(lastWithNext.next).slice(0, 30)}）`);
        } else {
          // 优先级 2：从几天前的旧知识里挑一条深挖
          const old = learns.filter((l) => Date.now() - l.at > 3 * 86400_000);
          if (old.length) {
            const pick = old[Math.floor(Math.random() * old.length)];
            offlineTopic = `（你几天前学过「${pick.topic}」：${String(pick.summary).slice(0, 120)}\n但这块还有没想明白的地方，顺着它再深挖一层。）`;
            logger.info?.(`[onebot] 离线探索：从旧知识延伸「${pick.topic}」`);
          }
        }
      }
      if (!offlineTopic) return;
    }

    const ent = bestKey ? sessions.entries.get(bestKey) : null;
    const cnt = new Map();
    for (const it of ent?.topicWindow ?? []) for (const w of it.w || []) cnt.set(w, (cnt.get(w) ?? 0) + 1);
    const candidates = [...cnt.entries()]
      .filter(([w, c]) => {
        if (c < 2) return false;
        if (w.length < 2) return false;
        // 虚词/口头禅/代词——学到了也没意义
        const STOP = new Set([
          "这个", "那个", "什么", "就是", "没有", "可以", "不是", "现在", "然后",
          "还是", "但是", "因为", "所以", "如果", "虽然", "而且", "或者", "不过",
          "这样", "那样", "怎么", "为什么", "我们", "他们", "你们", "自己", "别人",
          "时候", "东西", "事情", "感觉", "觉得", "知道", "真的", "有点", "已经",
          "应该", "可能", "一直", "一样", "这么", "那么", "多少", "哪个", "哪些",
          "一个", "一次", "一下", "还有", "其实", "反正", "确实", "的确", "居然",
          "哈哈", "真的", "笑死", "离谱", "牛逼", "牛掰", "绝了", "草", "靠",
        ]);
        if (STOP.has(w)) return false;
        // 纯数字/纯字母也不算兴趣点
        if (/^[0-9a-zA-Z\s]+$/.test(w)) return false;
        return true;
      })
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w)
      .slice(0, 5);
    if (!candidates.length) return;

    let topic = "";
    if (offlineTopic) {
      topic = "延伸阅读";
    } else {
      if (!candidates.length) return;
      // 候选里再筛一遍：纯虚词/口头禅不要
      const BAD = /^(还是|但是|因为|所以|如果|虽然|而且|或者|不过|这样|那样|怎么|什么|这个|那个|就是|没有|可以|不是|现在|然后|时候|东西|事情|感觉|觉得|知道|真的|有点|已经|应该|可能|一直|一样|这么|那么|多少|哪个|哪些|一个|一次|一下|还有|其实|反正|确实|的确|居然|哈哈|笑死|离谱|牛逼|绝了)$/;
      const usable = candidates.filter((w) => !BAD.test(w));
      if (!usable.length) return;
      topic = usable[Math.floor(Math.random() * usable.length)];
      // 30 天内学过就不重复
      if (learns.some((l) => l.topic === topic && Date.now() - l.at < 30 * 86400_000)) return;
    }

    const runKey = bestKey || SELF_ACTIVITY_KEY;
    logger.info?.(`[onebot] ${offline ? "离线" : ""}自主探索：${offlineTopic ? "从旧知识延伸" : `围绕「${topic}」`}`);
    audit({ kind: "explore_start", topic, key: runKey, offline });
    try {
      const raw = String(
        (await sessions.runSilent(
          runKey,
          "（内部探索，不要发到群里。你可以用 web_search 和 web_fetch。）\n" +
            "把这次当成**出门走一趟**——你不是在查资料，是在外面逛，看到有意思的就停下来看看。\n" +
            (offlineTopic
              ? offlineTopic + "\n"
              : `最近群里聊到「${topic}」，你不太懂。顺着这个由头出门看看：\n`) +
            "1. 先 web_search 搜一次，挑一个看起来最靠谱的结果走过去；\n" +
            "2. web_fetch 读它。**如果页面上有让你好奇的链接或术语，就再走一步**（一共最多 3 步）；\n" +
            "3. 每走一步都记下「我为什么往这边走」——是哪个词、哪句话勾住了你；\n" +
            "4. 走完停下来，用你自己的话写 100-200 字见闻，再写一句「这趟的感想」；\n" +
            "5. 最后留一句「下次想去看看什么」——路上看到的、但这趟来不及看的东西。\n" +
            "只输出 JSON，不要别的：\n" +
            '{"summary":"见闻","learned":"我的感想","path":[{"stop":"看了什么","why":"为什么往这儿走"}],"next":"下次想去看看什么"}',
        )) ?? "",
      ).trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        logger.info?.("[onebot] 探索没产出有效内容，放弃");
        return;
      }
      const obj = JSON.parse(m[0]);
      const summary = String(obj.summary || "").trim().slice(0, 400);
      if (summary.length < 20) return;
      const pathArr = Array.isArray(obj.path)
        ? obj.path.slice(0, 6).map((x) =>
            typeof x === "string"
              ? { stop: String(x).slice(0, 120), why: "" }
              : { stop: String(x?.stop ?? "").slice(0, 120), why: String(x?.why ?? "").slice(0, 160) },
          )
        : [];
      const entry = {
        topic,
        summary,
        learned: String(obj.learned || "").trim().slice(0, 200),
        next: String(obj.next || "").trim().slice(0, 200),
        path: pathArr,
        from: runKey,
        at: Date.now(),
        offline: !!offline,
      };
      learns.push(entry);
      // 完整探险日志：一次一条，方便以后回看「我去过哪儿、当时怎么想的」
      appendExploreLog({
        at: Date.now(),
        offline: !!offline,
        from: runKey,
        topic: entry.topic,
        stops: pathArr,
        summary: entry.summary,
        thought: entry.learned,
      });
      saveLearnings(learns);
      logger.info?.(`[onebot] 学到一条：${topic}｜${summary.slice(0, 40)}`);
      appendMem({
        kind: "learn",
        topic: String(entry.topic || "").slice(0, 20),
        text: `学了「${entry.topic}」：${String(entry.summary).slice(0, 120)}`,
        ref: "learning",
        offline,
      });
      audit({ kind: "explore_done", topic, summary: summary.slice(0, 200) });
    } catch (err) {
      logger.warn?.(`[onebot] 探索失败：${err?.message ?? err}`);
    }
  }

  // 每小时看一次（9-23 点之间才真跑，每天仍受 autoExplorePerDay 限制）
  // 自主活动：由她自己决定下一次什么时候（几分钟到几小时）
  let nextActivityTimer = null;
  let lastActivityAt = 0;

  function scheduleNextSelfActivity(delayMinutes) {
    try {
      if (nextActivityTimer) clearTimeout(nextActivityTimer);
      if (cfg.selfActivityEnabled === false || cfg.autoActionsEnabled === false) return;
      // 她主动说了多久 → 尊重她（1 分钟 ~ 8 小时）
      // 没说 → 默认 10-30 分钟，上限 40 分钟
      // 她可以定 1-40 分钟；超过 40 就按 40（她自己说的也能被压到 40）
      const clamped =
        delayMinutes > 0
          ? Math.max(1, Math.min(40, delayMinutes))
          : Math.max(1, Math.min(40, 10 + Math.random() * 20));
      // 存盘：重启后不用重算，别把她自己定的时间丢了
      const targetAt = Date.now() + clamped * 60_000;
      logger.info?.(
        `[onebot] 调度：delayMinutes=${delayMinutes} clamped=${clamped} 目标=${new Date(targetAt).toLocaleTimeString("zh-CN", { hour12: false })}`,
      );
      patchSelfState({ selfActivityNextAt: targetAt });
      nextActivityTimer = setTimeout(() => void tickSelfActivity(), clamped * 60_000);
      nextActivityTimer.unref?.();
      if (delayMinutes > 0 && delayMinutes !== clamped) {
        logger.info?.(`[onebot] 她说 ${Math.round(delayMinutes)} 分钟，按 ${Math.round(clamped)} 分钟执行`);
      }
      logger.info?.(`[onebot] 下次自主活动约 ${Math.round(clamped)} 分钟后`);
    } catch {
      // 忽略
    }
  }

  async function tickSelfActivity() {
    try {
      if (cfg.selfActivityEnabled === false || cfg.autoActionsEnabled === false) {
        scheduleNextSelfActivity(60);
        return;
      }
      if (!selfActivityHoursOk()) {
        // 不在时段里，等下一个时段开始再来
        const h = new Date().getHours();
        const start = Number(cfg.selfActivityStartHour ?? 0);
        const waitH = h < start ? start - h : 24 - h + start;
        logger.info?.(`[onebot] 不在活跃时段，${waitH} 小时后再看`);
        // 等待时间也受 40 分钟上限约束，分段醒来再判断
        scheduleNextSelfActivity(40);
        return;
      }
      const cap = Number(cfg.selfActivityPerDay ?? 20);
      const today = new Date().toDateString();
      // 只统计 9-23 点之间的活动：凌晨自己睡不着跑的那些不占白天额度
      const hourFrom = Number(cfg.selfActivityCountFromHour ?? 9);
      const hourTo = Number(cfg.selfActivityCountToHour ?? 23);
      const resetAt = Number(loadSelfState().selfActivityResetAt) || 0;
      const done = loadActivities(300).filter((a) => {
        if (a.byOwner) return false; // 主人点名/测试触发的，不占额度
        if (resetAt && a.at < resetAt) return false;
        const d = new Date(a.at);
        if (d.toDateString() !== today) return false;
        const h = d.getHours();
        return h >= hourFrom && h < hourTo;
      }).length;
      if (cap > 0 && done >= cap) {
        logger.info?.(`[onebot] 今天活动 ${done} 次已满 ${cap}，明天继续`);
        scheduleNextSelfActivity(40);
        return;
      }
      // 三段式：思考 → 行动 → 反思（由她自己决定做什么）
      lastActivityAt = Date.now();
      await runThinkingCycle();
      // runSelfActivity 内部会调 scheduleNextSelfActivity；
      // 如果它没调（比如 reco 失败），这里兜底
      if (!nextActivityTimer) scheduleNextSelfActivity(0);
    } catch (err) {
      logger.warn?.(`[onebot] 自主活动调度失败：${err?.message ?? err}`);
      scheduleNextSelfActivity(30);
    }
  }

  // 手动触发器：写 run-cycles 文件（内容是次数）就能让她立刻连跑
  setInterval(() => {
    void (async () => {
      try {
        const f = join(HOME, ".dsh/onebot-bridge/run-cycles");
        if (!existsSync(f)) return;
        const raw = readFileSync(f, "utf8").trim();
        unlinkSync(f);
        // 支持：
        //   "5"                 → 5 轮，自己决定
        //   "explore 2"         → 2 次探险
        //   "read"              → 1 次读书
        //   "explore 2\nread 1" → 组合
        const VALID = ["explore", "read", "play", "think", "write", "recall", "dream", "study"];
        const jobs = [];
        for (const line of raw.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (!parts[0]) continue;
          const cnt = Math.max(1, Math.min(10, Number(parts[1]) || 1));
          if (VALID.includes(parts[0])) {
            for (let i = 0; i < cnt; i++) jobs.push({ kind: parts[0] });
          } else if (/^\d+$/.test(parts[0])) {
            for (let i = 0; i < Math.max(1, Math.min(10, Number(parts[0]))); i++) jobs.push({ kind: null });
          }
        }
        if (!jobs.length) {
          logger.info?.("[onebot] 触发文件内容没看懂");
          return;
        }
        logger.info?.(`[onebot] 手动触发 ${jobs.length} 轮：${jobs.map((j) => j.kind || "auto").join(",")}`);
        for (let i = 0; i < jobs.length; i++) {
          try {
            await runThinkingCycle(
              jobs[i].kind ? { forceAction: jobs[i].kind, byOwner: true } : { byOwner: true },
            );
          } catch (err) {
            logger.warn?.(`[onebot] 第 ${i + 1} 轮失败：${err?.message ?? err}`);
          }
          if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 2000));
        }
        logger.info?.(`[onebot] 手动触发的 ${jobs.length} 轮完成`);
      } catch {
        // 忽略
      }
    })();
  }, 20_000).unref?.();

  // 启动时：如果上次存了「下次什么时候」，按剩余时间恢复；否则 3 分钟后开始
  setTimeout(() => {
    try {
      const saved = Number(loadSelfState().selfActivityNextAt) || 0;
      if (saved > Date.now()) {
        const leftMin = Math.round((saved - Date.now()) / 60_000);
        logger.info?.(`[onebot] 恢复上次定的活动时间：${leftMin} 分钟后`);
        scheduleNextSelfActivity(leftMin);
        return;
      }
    } catch {
      // 忽略
    }
    void tickSelfActivity();
  }, 30_000).unref?.(); // 启动后 30 秒就恢复，别等 3 分钟（重启多的话会明显推迟她的活动）

  // ── 说说：不按固定时间，而是问她「现在有没有想说的」──
  const QZONE_PLAN = join(HOME, ".dsh/onebot-bridge/qzone-plan.json");
  function loadQzonePlan() {
    try {
      const p = JSON.parse(readFileSync(QZONE_PLAN, "utf8"));
      return p && typeof p === "object" ? p : null;
    } catch {
      return null;
    }
  }
  function saveQzonePlan(p) {
    try {
      writeFileSync(QZONE_PLAN, JSON.stringify(p, null, 1));
    } catch (err) {
      logger.warn?.(`[onebot] 说说状态落盘失败：${err?.message ?? err}`);
    }
  }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const qzoneLog = []; // { at, text, tid }
  async function maybeQzone() {
    if (cfg.qzoneEnabled === false || cfg.autoActionsEnabled === false) return;
    if (!client.connected) return;
    const now = new Date();
    const hour = now.getHours();
    const startH = Number(cfg.qzoneStartHour) || 9;
    const endH = Number(cfg.qzoneEndHour) || 23;
    if (hour < startH || hour >= endH) return;
    let plan = loadQzonePlan();
    if (!plan || plan.date !== todayKey()) {
      plan = { date: todayKey(), posted: 0, lastAt: 0 };
      saveQzonePlan(plan);
    }
    const maxPerDay = Number(cfg.qzonePerDayMax) || 3;
    if (Number(plan.posted ?? 0) >= maxPerDay) {
      logger.debug?.(`[onebot] 今天说说已发 ${plan.posted}/${maxPerDay}，不再问`);
      return;
    }

    // 挑最近 3 小时内有活动的群作为素材来源
    let bestKey = null;
    let bestAt = 0;
    const nowTs = Date.now();
    for (const [k, e] of sessions.entries) {
      if (!k.startsWith("group:")) continue;
      const t = e.lastMessageAt ?? 0;
      if (t > bestAt) {
        bestAt = t;
        bestKey = k;
      }
    }
    if (!bestKey || nowTs - bestAt > 3 * 3600_000) {
      logger.debug?.("[onebot] 最近没什么经历，不说说");
      return;
    }

    logger.info?.("[onebot] 问问她想不想发条说说…");
    let text = "";
    try {
      text = String(
        (await sessions.runSilent(
          bestKey,
          "（内部，不要把这个发给任何人。）\n" +
            "如果你现在想发一条 QQ 空间说说，就把它写出来；不想发就只回一个字：无。\n" +
            "写的时候用你自己最近的经历做素材：这几天在群里聊过什么、遇到的人、你自己的观点和反思。" +
            "不要写泛泛的鸡汤，也不要为了发而发——真的有一点想说的才写。\n" +
            "不要照搬群里聊天的原句，用你自己的说法讲；长度两三句，像随手写的，不要带话题标签。",
        )) ?? "",
      ).trim();
    } catch (err) {
      logger.warn?.(`[onebot] 生成说说失败：${err?.message ?? err}`);
      return;
    }
    if (!text || text === "无" || text.length < 4) {
      logger.info?.("[onebot] 她这次不想发说说");
      audit({ kind: "qzone_skip" });
      return;
    }
    text = cleanQzone(stripLoneSurrogates(text).slice(0, 300));
    try {
      const res = await client.call(
        "send_qzone_msg",
        { content: text, ugc_right: Number(cfg.qzoneVisibility) || 1 },
        20000,
      );
      const tid = String(res?.tid ?? res?.data?.tid ?? "");
      plan.posted = Number(plan.posted ?? 0) + 1;
      plan.lastAt = Date.now();
      saveQzonePlan(plan);
      qzoneLog.push({ at: new Date().toISOString(), text, tid });
      if (qzoneLog.length > 100) qzoneLog.shift();
      logger.info?.(`[onebot] 说说已发（tid=${tid.slice(0, 12)}）：${text.slice(0, 40)}`);
      audit({ kind: "qzone_post", tid, text: text.slice(0, 200) });
      // 记进她的自我记忆，方便以后问起时记得
      try {
        selfViews.data.push({
          text: `我在空间发过一条：${text}`,
          at: Date.now(),
          kind: "qzone",
        });
        if (selfViews.data.length > 300) selfViews.data.shift();
        selfViews.save?.();
      } catch {
        // 忽略
      }
    } catch (err) {
      logger.warn?.(`[onebot] 发说说失败：${err?.message ?? err}`);
      audit({ kind: "qzone_fail", error: String(err?.message ?? err).slice(0, 200) });
    }
  }

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
  setInterval(() => {
    void pollFriendRequests();
  }, 120000).unref?.();

  // 端口探活：NapCat 一起来就立刻重连，不让用户等 60 秒退避
  setInterval(() => {
    if (client.connected) return;
    void (async () => {
      const ok = await new Promise((resolve) => {
        try {
          const sock = net.connect({ host: "127.0.0.1", port: 3001 });
          const done = (v) => {
            try {
              sock.destroy();
            } catch {
              // 忽略
            }
            resolve(v);
          };
          sock.setTimeout(700);
          sock.once("connect", () => done(true));
          sock.once("error", () => done(false));
          sock.once("timeout", () => done(false));
        } catch {
          resolve(false);
        }
      });
      if (ok) {
        logger.info?.("[onebot] 探到 3001 已就绪，立即重连");
        client.reconnectNow();
      }
    })();
  }, 5000).unref?.();
  setTimeout(() => {
    void pollFriendRequests();
  }, 40000).unref?.();

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
