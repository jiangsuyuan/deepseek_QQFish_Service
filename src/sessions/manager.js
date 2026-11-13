import { noteError } from "../core/error-watch.js";
import { CORE_TOOLS } from "../core/constants.js";
// 会话注册表：每个群/私聊一个 DSH 会话。
import { withTimeout } from "../util/time.js";
import { conversationKey, sessionIdBase } from "../onebot/parse.js";
import { audit } from "../core/audit.js";
import { extractReply } from "../util/misc.js";
import { mkdirSync } from "node:fs";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

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
      const handle = await resume();
      // 只把核心工具常驻给她；其余走 tool_catalog / describe_tool / call_tool
      try {
        const agentCtx = handle?.agent?.ctx ?? handle?.ctx ?? null;
        const tools = agentCtx?.get?.("tools") ?? agentCtx?.tools ?? null;
        if (tools?.restrict && tools?.schemas) {
          const all = (tools.schemas() || []).map((x) => x.name);
          const keep = [...new Set([...CORE_TOOLS, ...all.filter((n) => String(n).startsWith("x_"))])];
          tools.restrict({ allow: keep });
          this.logger?.info?.(`[onebot] 工具表已精简：常驻 ${keep.length} 个，其余走目录（共 ${all.length} 个）`);
        }
      } catch {
        // 拿不到 agent 作用域就算了，不影响对话
      }
      return handle;
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
        const sn = noteError(err, "manager.turn");
        this.logger?.warn?.(
          `[onebot] 常驻轮失败（${msg.slice(0, 120)}），重建 agent 后重试${sn ? ` ｜ 程序错误 ${sn.key}×${sn.count}` : ""}`,
        );
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
      // 只读统计：回合结束时量一次上下文构成（不要影响任何返回值）
      try {
        this.onTurnUsage?.(entry?.handle?.agent?.session, entry?.key);
      } catch {
        // 统计失败不影响对话
      }
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
          blocks.push({
            type: "text",
            text:
              "[这张图太大，没能直接塞进上下文" +
              (img?.srcUrl ? `；需要时可以用 look_image({url:"${img.srcUrl}"}) 再看` : "") +
              "]",
          });
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

  /**
   * 用临时会话看一张图并描述（不占用当前对话的 agent）
   *
   * 原来这里直接 `agents.create()` 然后 `agent.session` —— 但 create 返回的是
   * { agent, ... } 包装对象，不是 agent 本身，所以 .session 永远是 undefined，
   * 报 "Cannot read properties of undefined (reading 'seq')"，看图永远失败
   * （候选预览全变成「没看明白，只有标签」）。
   * 现在改走 openAgent：它有 resume/create 回退 + 写锁重试，拿到的结构也对。
   */
  async describeImage(image, question) {
    const agents = this.svc("agents");
    if (!agents) return "";
    const att = this.svc("attachments");
    if (!att) return "";
    const tmpId = `vision-${Date.now()}`;
    let handle = null;
    try {
      handle = await this.openAgent(tmpId);
      const realAgent = handle?.agent ?? handle;
      const session = realAgent?.session;
      if (!session) {
        this.logger?.warn?.("[onebot] 看图：openAgent 没拿到 session");
        return "";
      }
      const firstSeq = session.seq;
      const ref = await att.saveImage({ data: image.data, mediaType: image.mediaType });
      realAgent.followup(
        createUserMessage({
          content: [
            { type: "text", text: question || "这张图是什么？一两句话描述，别长篇。" },
            { type: "image", attachment: ref },
          ],
          source: { kind: "user" },
        }),
      );
      await withTimeout(realAgent.whenIdle(), 45000, "vision-turn");
      return String(extractReply(session, firstSeq) ?? "").trim();
    } catch (err) {
      this.logger?.warn?.(`[onebot] 看图失败：${err?.message ?? err}`);
      return "";
    } finally {
      try {
        const realAgent = handle?.agent ?? handle;
        await realAgent?.dispose?.();
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
      const token = Symbol("silent");
      entry.proactiveTurn = true;
      entry.proactiveQuote = false;
      entry.silentTurn = true; // 关键：turn/end 不发送
      entry.silentTurnAt = Date.now();
      entry.silentToken = token;
      const firstSeq = agent.session.seq;
      try {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: instruction }],
            source: { kind: "user" },
          }),
        );
        // 10 分钟上限：只为防"卡死导致永久失声"，不用来卡正常回合
        // （实测对话 P90 19s、活动 P90 70s、最长 619s）
        // 只是提醒，不掐断：她算协方差那种活本来就慢
        const stuckTimer = setTimeout(() => {
          this.logger?.warn?.("[onebot] 这一轮已经跑了 10 分钟还没结束（还在跑，没掐断）");
        }, 600000);
        stuckTimer.unref?.();
        try {
          // 30 分钟硬上限：只防真的卡死（协方差这类计算可能跑十几分钟）
          await withTimeout(agent.whenIdle(), 1_800_000, "silent-turn");
        } finally {
          clearTimeout(stuckTimer);
        }
        return extractReply(agent.session, firstSeq);
      } finally {
        if (entry.silentToken === token) {
          entry.silentTurn = false;
          entry.silentTurnAt = 0;
          entry.silentToken = null;
        }
      }
    });
    entry.queue = job.catch(() => {});
    return job;
  }

  /** 主动回合：让 agent 自己说一段，不进 inTurn（这样自发转发会把它发到 QQ） */
  async runProactive(key, instruction, triggerEv, opts = {}) {
    const entry = await this.ensure(key);
    const targetKey = String(key || "");
    const job = entry.queue.then(async () => {
      if (!entry.handle) entry.handle = await this.openAgent(entry.sessionId);
      const agent = entry.handle.agent;
      await withTimeout(agent.whenIdle(), 20000, "proactive-idle");
      // ── 目标必须显式：不能拿「别的会话的 lastTarget」当发送目标 ──
      let targetEv = triggerEv || null;
      let targetFrom = triggerEv ? "explicit" : "";
      if (!targetEv && entry.lastTarget && conversationKey(entry.lastTarget) === targetKey) {
        targetEv = entry.lastTarget;
        targetFrom = "session-last";
      }
      // 没有 lastTarget（比如简讯用的私聊会话）时，直接由 key 合成目标
      if (!targetEv && /^(group|private):\d{5,20}$/.test(targetKey)) {
        const kind0 = targetKey.slice(0, targetKey.indexOf(":"));
        const id0 = Number(targetKey.slice(targetKey.indexOf(":") + 1));
        targetEv =
          kind0 === "group"
            ? { message_type: "group", group_id: id0, user_id: 0 }
            : { message_type: "private", user_id: id0 };
        targetFrom = "key";
      }
      // 独立会话（自主活动/内省/自检）默认只对创造者私聊说，绝不落到某个群
      if (!targetEv && targetKey.startsWith("self") && this.cfg?.ownerId) {
        targetEv = { message_type: "private", user_id: Number(this.cfg.ownerId) };
        targetFrom = "owner-default";
      }
      if (!targetEv) {
        this.logger?.warn?.(`[onebot] 主动回合没有明确目标，跳过：${targetKey}`);
        return;
      }
      const token = Symbol("proactive");
      entry.proactiveTurn = true; // 主动回合：turn/end 负责把话发出去
      entry.proactiveTarget = targetEv;
      entry.proactiveToken = token;
      entry.proactiveSource = opts.source || (targetKey.startsWith("self") ? "activity" : "proactive");
      entry.proactiveTargetFrom = targetFrom;
      entry.turnOriginKey = conversationKey(targetEv);
      // 热群插话是「加入正在进行的讨论」，引用某一条会显得突兀，默认不引用
      entry.proactiveQuote = opts.quote === true;
      try {
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: instruction }],
            source: { kind: "user" },
          }),
        );
        await withTimeout(agent.whenIdle(), 90000, "proactive-turn");
      } finally {
        // 只有本次 job 还是标志的创造者时才清（避免清掉后一个回合的）
        if (entry.proactiveToken === token) {
          entry.proactiveTurn = false;
          entry.proactiveTarget = null;
          entry.proactiveToken = null;
        }
      }
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

export { SessionManager };
