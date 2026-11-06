// OneBot 客户端：连接、收发、打字模型。
import { sleep } from "../util/time.js";
import { splitMessage, humanizePunct } from "../util/text.js";
import { audit } from "../core/audit.js";
import { conversationKey } from "./parse.js";
import { noteSent, SEND_STATE, OUT_SENT, OUT_REPLIED, DUP_TEXT_MS, DUP_MSG_MS, normOut } from "../util/send-state.js";
import { recordOutbound } from "../store/msglog.js";
import { readFileSync } from "node:fs";

/** 全局打字锁：一次只有一条消息在「打字」 */
let __typingMutex = Promise.resolve();

class OneBotClient {
  constructor(cfg, logger) {
    this.sessions = null;
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
    // 分档退避：前 10 次快速追（可能只是网络抖），
    // 11-50 次降到 5 分钟，50 次以后 30 分钟——保持存在感但不再空转。
    // 原来是 2^retry 上限 60 秒，QQ 掉登录后一直每分钟撞一次，日志刷了 800 条。
    let delay;
    if (this.retry <= 10) delay = Math.min(60000, 1000 * Math.pow(2, Math.min(this.retry, 6)));
    else if (this.retry <= 50) delay = 300000;
    else delay = 1800000;
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
    // 她可以选择不回。输出 [skip] 就一条都不发——
    // 这不是失败，是她的时间。日志写「选择不回」，不写「回复失败」。
    try {
      const raw = String(text || "").trim();
      if (/^\[\[?\s*skip\s*\]?\]$/i.test(raw) ||
          (/\[\[?\s*skip\s*\]?\]/i.test(raw) && raw.length < 40)) {
        this.logger?.info?.(`[onebot] 她选择不回（正常）：${conversationKey(ev)}`);
        audit({ kind: "silent_skip", key: conversationKey(ev), raw: raw.slice(0, 60) });
        return;
      }
    } catch {
      // 忽略
    }
    // 私聊防纠缠：上一句已经是她说的、对方还没出声，就不再追加
    // （正常回复时 lastSpeaker 刚被 onEvent 置为 "them"，不会误拦）
    if (ev.message_type !== "group" && !opts.force) {
      try {
        const k = conversationKey(ev);
        const ent = this.sessions?.entries.get(k);
        if (ent && ent.lastSpeaker === "me") {
          this.logger?.info?.(`[onebot] 私聊里她刚说完、对方还没回，跳过追加：${k}`);
          audit({ kind: "dm_no_piggyback", key: k, text: String(text).slice(0, 80) });
          return;
        }
      } catch {
        // 忽略
      }
    }
    // 打字时间模型：按字数算，像人一样（不再用配额限流）
    const len = String(text || "").length;
    const perChar = (Number(this.cfg.typingSecPerChar) || 0.45)
                  + (Number(this.cfg.thinkingPerCharSec) || 0.05);
    const baseSec = Number(this.cfg.thinkingBaseSec) || 1.5;
    const jr = this.cfg.replyJitterSec || [0.3, 1.2];
    const jitterSec = jr[0] + Math.random() * (jr[1] - jr[0]);
    const rawDelay = (baseSec + len * perChar + jitterSec) * 1000;
    // 封顶：再长的回复也不等超过这么久（真人不会一次打 300 字）
    const capMs = (Number(this.cfg.maxTypingDelaySec) || 15) * 1000;
    const delay = Math.max(200, Math.min(rawDelay, capMs));
    this.logger?.debug?.(
      "[onebot] 打字 len=" + len + " raw=" + Math.round(rawDelay) + "ms 封顶后=" + Math.round(delay) + "ms",
    );
    // 单线程：等前一条打完再打这一条（私聊和群聊共享同一把锁）
    {
      const prevLock = __typingMutex;
      let releaseLock;
      __typingMutex = new Promise((r) => { releaseLock = r; });
      await prevLock;
      try {
        await sleep(delay);
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
      const ent0 = this.sessions?.entries.get(k0);
      if (ent0) ent0.lastSpeaker = "me";
    } catch {
      // 忽略
    }
    let lastResult = null;
    for (let i = 0; i < parts.length; i++) {
      // 她自己拆的段落之间多等一会儿（像打完一条想一下），机器切的多等少
      const isSelfSplit = Array.isArray(segs) && segs.length > 1;
      if (i > 0) await sleep(isSelfSplit ? 1000 + Math.random() * 2000 : 500 + Math.random() * 900);
      const sent = await this.sendText(ev, parts[i], {
        part: i > 0,
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
      lastResult = sent;
      noteSent();
    }
    return lastResult;
      } finally {
        releaseLock();
      }
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
        // 带上收件人：不然 WebUI 那边分不清这话是跟谁说的，也不知道该不该展示正文
        this.onOfflineText?.(txt, String(userId || ""));
      } catch {
        // 忽略
      }
      this.logger?.warn?.(`[onebot] QQ 离线，这条没发出去（已转 WebUI）：${txt.slice(0, 40)}`);
      return Promise.resolve({ message_id: `offline-${Date.now()}`, offline: true });
    }
    const dupKey = `private:${userId}|` + normOut(text);
    if (!text || (String(text).length >= 8 && Date.now() - (OUT_SENT.get(dupKey) || 0) < DUP_TEXT_MS)) {
      if (text) {
        this.logger?.info?.(`[onebot] 出口去重：私聊刚发过，跳过（${userId}）`);
        return Promise.resolve({
          message_id: `dup-${Date.now()}`,
          duplicate: true,
          note: "这条刚发过，没有重复发。",
        });
      }
    }
    return this.call("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "text", data: { text } }],
    }).then((r) => {
      try {
        OUT_SENT.set(dupKey, Date.now());
      } catch {
        // 忽略
      }
      try {
        recordOutbound(
          { message_type: "private", user_id: Number(userId) },
          text,
          { selfId: this.cfg?.selfId, messageId: String(r?.message_id ?? "") },
        );
      } catch {
        // 落盘失败不影响发送
      }
      return r;
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
    // ── 单一出口去重：同一会话刚发过同样的话、或刚回过同一条消息，就不再发 ──
    const convKey = (() => {
      try {
        return conversationKey(ev);
      } catch {
        return "";
      }
    })();
    const normText = normOut(text);
    const inboundMid = String(ev?.message_id ?? "");
    if (!opts.part && convKey) {
      const tKey = convKey + "|" + normText;
      if (normText.length >= 8 && Date.now() - (OUT_SENT.get(tKey) || 0) < DUP_TEXT_MS) {
        this.logger?.info?.(`[onebot] 出口去重：这条刚发过，跳过（${convKey}）`);
        return Promise.resolve({
          message_id: `dup-${Date.now()}`,
          duplicate: true,
          note: "这条刚发过，没有重复发。",
        });
      }
      if (inboundMid && opts.quote) {
        const mKey = convKey + "|" + inboundMid;
        if (Date.now() - (OUT_REPLIED.get(mKey) || 0) < DUP_MSG_MS) {
          this.logger?.info?.(`[onebot] 出口去重：这条消息已经回过，跳过（${convKey}）`);
          return Promise.resolve({
            message_id: `dup-${Date.now()}`,
            duplicate: true,
            note: "这条消息已经回过了，没有重复回复。",
          });
        }
      }
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
    // 发到 QQ 的也和 WebUI 同步一份——但只同步「发给主人」和「群聊」。
    // 她和别人的私聊是私事，不该出现在主人的界面上。
    try {
      const owner = String(this.cfg?.ownerId ?? "");
      const uid = String(ev?.user_id ?? "");
      const isPrivateToOther = ev?.message_type !== "group" && uid !== owner;
      this.logger?.info?.(
        "[onebot] sendText 推送判断：type=" + (ev?.message_type ?? "?") +
        " user=" + uid + " owner=" + owner + " 推=" + (!isPrivateToOther) +
        " fromWebUI=" + !!ev?.__fromWebUI,
      );
      if (!isPrivateToOther) {
        // 带上「这条是发到哪儿」：群聊和私聊混在同一条流里，面板上分不出她在跟谁说话
        const isGroupEv = ev?.message_type === "group";
        const ch = isGroupEv ? "group" : "private";
        const peer = String(isGroupEv ? (ev?.group_id ?? "") : (ev?.user_id ?? ""));
        const rawText = String(text ?? "");
        for (const p of rawText.split(/\[split\]/i).map((x) => x.trim()).filter(Boolean)) {
          this.logger?.info?.("[onebot] sendText 推 WebUI：" + p.slice(0, 40));
          this.onWebReply?.(p, ch, peer);
        }
      }
    } catch (err) {
      this.logger?.warn?.("[onebot] sendText 推送异常：" + (err?.message ?? err));
    }
    // 群临时会话（群友私聊、非好友）必须用 send_group_temp_msg + 来源群号。
    // 用 send_private_msg 发非好友会失败；把来源群号当 group_id 又会发进群。
    const isGroup = ev.message_type === "group";
    const tempGroup = Number(ev.__groupTemp) || 0;
    let method, params;
    if (isGroup) {
      method = "send_group_msg";
      params = { group_id: ev.group_id, message: segs };
    } else if (tempGroup > 0) {
      // 群临时会话优先走专用接口；有些 NapCat 版本不实现它（1404 不支持的API），
      // 那时退回普通私聊——总比整条消息发不出去好。
      // sendText 不是 async，这里用 .catch 链，不引 await。
      return this.call("send_group_temp_msg", {
        group_id: tempGroup,
        user_id: ev.user_id,
        message: segs,
      })
        .then((r) => this._markSent(convKey, normText, inboundMid, r, ev, text, opts))
        .catch((err) => {
          this.logger?.warn?.(
            "[onebot] send_group_temp_msg 失败（" + (err?.message ?? err) + "），回退 send_private_msg",
          );
          return this.call("send_private_msg", { user_id: ev.user_id, message: segs }).then((r) =>
            this._markSent(convKey, normText, inboundMid, r, ev, text, opts),
          );
        });
    } else {
      method = "send_private_msg";
      params = { user_id: ev.user_id, message: segs };
    }
    return this.call(method, params).then((r) => this._markSent(convKey, normText, inboundMid, r, ev, text, opts));
  }

  /** 出口统一收尾：记下这次发了什么，供去重判断 */
  _markSent(convKey, normText, inboundMid, result, ev, text, opts = {}) {
    try {
      if (convKey && normText) OUT_SENT.set(convKey + "|" + normText, Date.now());
      if (convKey && inboundMid) OUT_REPLIED.set(convKey + "|" + inboundMid, Date.now());
    } catch {
      // 忽略
    }
    // 出站也落盘：这样「她和某人的对话」能双向还原
    try {
      if (ev && (ev.message_type === "group" || ev.message_type === "private")) {
        recordOutbound(ev, text, {
          selfId: this.cfg?.selfId,
          qid: opts?.quote ? inboundMid : "",
          to: ev.message_type === "group" ? ev.user_id : "",
          messageId: String(result?.message_id ?? result?.data?.message_id ?? ""),
        });
      }
    } catch {
      // 落盘失败不影响发送
    }
    return result;
  }
}

export { __typingMutex, OneBotClient };
