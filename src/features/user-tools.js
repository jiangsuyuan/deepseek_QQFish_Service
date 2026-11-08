// 她自己造的工具：写文件 → 动态 import → 注册进工具表。
//
// 设计取舍（和创造者对过）：
//   · 不限制能力：工具能读任何数据、做任何事
//   · 不碰结构：她只新增工具，不改插件本身的源码
//   · 数据分区靠约定：每个工具自带 exec.dataDir，提示词引导她写在那儿
//   · 上限 50 个（工具 schema 每轮都要付 token，先卡住规模）
//
// 三条生死线（不是能力限制）：
//   · 单个工具执行 10s 超时 —— 防死循环把她自己的回合拖死
//   · 坏工具跳过 —— 一个语法错不能让插件起不来
//   · 失败可见 —— 报错原文返回给她，她才知道自己做的东西坏了
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HOME, ".dsh/onebot-bridge/user-tools");
const DATA = join(HOME, ".dsh/onebot-bridge/user-data");
const STATS = join(DIR, "stats.json");
const MAX_TOOLS = 50;
const RUN_TIMEOUT_MS = 10_000;
const NAME_RE = /^x_[a-z][a-z0-9_]{1,30}$/;

export function createUserTools(app) {
  const { ctx, logger } = app;
  const loaded = new Map(); // name -> { dispose, file, meta }
  let stats = {};

  function toolSvc() {
    // 只能走 ctx.get：直接读 ctx.tools 会因为没声明 inject 而抛错
    try {
      return ctx?.get?.("tools") ?? null;
    } catch {
      return null;
    }
  }

  function readStats() {
    try {
      stats = JSON.parse(readFileSync(STATS, "utf8")) || {};
    } catch {
      stats = {};
    }
  }
  function writeStats() {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(STATS, JSON.stringify(stats, null, 1), "utf8");
    } catch {
      // 统计写不进去不影响运行
    }
  }
  function bump(name, ok) {
    const s = (stats[name] = stats[name] || { calls: 0, fails: 0, lastAt: 0 });
    s.calls += 1;
    if (!ok) s.fails += 1;
    s.lastAt = Date.now();
    writeStats();
  }

  /** 把一个工具文件加载并注册；返回 {ok, reason} */
  async function loadOne(name) {
    const tools = toolSvc();
    if (!tools?.register) return { ok: false, reason: "工具服务不可用" };
    const file = join(DIR, `${name}.js`);
    if (!existsSync(file)) return { ok: false, reason: "文件不存在" };
    let mod;
    try {
      // 带版本号，改完能重新加载
      mod = await import(`file://${file}?v=${Date.now()}`);
    } catch (err) {
      return { ok: false, reason: `加载失败：${String(err?.message ?? err).slice(0, 160)}` };
    }
    const def = mod?.default;
    if (!def || typeof def.execute !== "function") {
      return { ok: false, reason: "没有默认导出，或 execute 不是函数" };
    }
    const dataDir = join(DATA, name);
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // 建不出来就让它自己处理
    }
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    let dispose;
    try {
      dispose = tools.register(
        defineTool({
          name,
          description: String(def.description || `她自己做的小工具（${name}）`),
          parameters: def.parameters || {},
          output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
          timeoutMs: Math.max(1000, Math.min(60_000, Number(def.timeoutMs) || RUN_TIMEOUT_MS)),
          execute: async (args, exec) => {
            const started = Date.now();
            try {
              const out = await Promise.race([
                Promise.resolve(def.execute(args, { ...exec, dataDir })),
                new Promise((_, rej) =>
                  setTimeout(() => rej(new Error(`执行超时（${RUN_TIMEOUT_MS}ms）`)), RUN_TIMEOUT_MS + 500).unref?.(),
                ),
              ]);
              bump(name, true);
              return out ?? { ok: true };
            } catch (err) {
              bump(name, false);
              const msg = String(err?.message ?? err).slice(0, 300);
              logger?.warn?.(`[onebot] 自造工具 ${name} 失败：${msg}`);
              return { ok: false, reason: msg, elapsedMs: Date.now() - started };
            }
          },
        }),
      );
    } catch (err) {
      return { ok: false, reason: `注册失败：${String(err?.message ?? err).slice(0, 160)}` };
    }
    // 同名的旧版本先撤掉
    try {
      loaded.get(name)?.dispose?.();
    } catch {
      // 忽略
    }
    loaded.set(name, { dispose, file });
    return { ok: true };
  }

  /** 启动时加载全部；坏的定义跳过并记一条 */
  async function loadAll() {
    mkdirSync(DIR, { recursive: true });
    readStats();
    let ok = 0;
    const bad = [];
    let files = [];
    try {
      files = readdirSync(DIR).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
    } catch {
      files = [];
    }
    for (const name of files.slice(0, MAX_TOOLS)) {
      if (!NAME_RE.test(name)) continue;
      const r = await loadOne(name);
      if (r.ok) ok += 1;
      else bad.push(`${name}: ${r.reason}`);
    }
    if (bad.length) logger?.warn?.(`[onebot] 自造工具加载失败 ${bad.length} 个：${bad.slice(0, 3).join("；")}`);
    if (ok) logger?.info?.(`[onebot] 自造工具已加载 ${ok} 个`);
    return { ok, bad };
  }

  function list() {
    return [...loaded.keys()].map((name) => ({
      name,
      calls: stats[name]?.calls ?? 0,
      fails: stats[name]?.fails ?? 0,
      lastUsed: stats[name]?.lastAt ? new Date(stats[name].lastAt).toLocaleString("zh-CN") : "没用过",
    }));
  }

  async function make({ name, description, parameters, code }) {
    const raw = String(name || "").trim().toLowerCase();
    const nm = raw.startsWith("x_") ? raw : `x_${raw}`;
    if (!NAME_RE.test(nm)) return { ok: false, reason: "名字要小写字母开头、只含小写字母/数字/下划线，2-31 个字符" };
    if (loaded.size >= MAX_TOOLS) {
      return { ok: false, reason: `已经有 ${MAX_TOOLS} 个自造工具了，先删一个（drop_tool）再建` };
    }
    const src = String(code || "").trim();
    if (!src) return { ok: false, reason: "code 不能空" };
    if (src.length > 20_000) return { ok: false, reason: "代码太长了（上限 20KB）" };
    mkdirSync(DIR, { recursive: true });
    const file = join(DIR, `${nm}.js`);
    try {
      writeFileSync(file, src, "utf8");
    } catch (err) {
      return { ok: false, reason: `写文件失败：${String(err?.message ?? err).slice(0, 120)}` };
    }
    const r = await loadOne(nm);
    if (!r.ok) {
      // 加载失败就删掉，别留个坏文件在启动时反复报错
      try {
        unlinkSync(file);
      } catch {
        // 忽略
      }
      return { ok: false, reason: r.reason };
    }
    return { ok: true, name: nm, dataDir: join(DATA, nm), note: "已经能用了，下一轮就能调" };
  }

  async function drop(name) {
    const nm = String(name || "").trim().toLowerCase();
    if (!loaded.has(nm)) return { ok: false, reason: "没有这个自造工具" };
    try {
      loaded.get(nm).dispose?.();
    } catch {
      // 忽略
    }
    loaded.delete(nm);
    try {
      unlinkSync(join(DIR, `${nm}.js`));
    } catch {
      // 忽略
    }
    return { ok: true, name: nm };
  }

  /** 把「造工具 / 删工具 / 看工具」三个入口注册进工具表 */
  /** 等工具服务挂上来：插件加载期间它可能还没就绪 */
  async function waitForTools(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const t = toolSvc();
      if (t?.register) return t;
      await new Promise((r) => setTimeout(r, 400).unref?.());
    }
    return null;
  }

  async function registerMeta() {
    // 先 await 一次，给 cordis 时间把服务装好（同步阶段直接取会拿到 null）
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    const tools = await waitForTools();
    logger?.info?.(`[onebot] 自造工具：tools 服务 ${tools?.register ? "可用" : "不可用"}`);
    if (!tools?.register) return { ok: false, reason: "工具服务不可用" };
    const out = { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] };

    tools.register(
      defineTool({
        name: "make_tool",
        description:
          "给自己做一个新工具。做出来的工具会一直留在你的工具表里，活动时、聊天时都能调用。\n" +
          "code 是一段 ES module，必须 export default { description, parameters, execute }。\n" +
          "execute(args, exec) 里 exec.dataDir 是你这个工具自己的数据目录，存东西就写那儿。\n" +
          "不要写、不要删、不要改原有的记忆文件（memory-log、facts、people、core、日程那些）——" +
          "那些是「你」，工具是你手上的东西。\n" +
          "工具名会自动加 x_ 前缀，最多 50 个。",
        parameters: {
          name: { type: "string", description: "工具名，小写字母开头，会变成 x_名字" },
          description: { type: "string", description: "这个工具干什么，写清楚，以后你靠它判断什么时候该用" },
          parameters: {
            type: "object",
            additionalProperties: true,
            description: "参数 schema，形如 { query: { type: 'string', description: '搜什么' } }",
          },
          code: { type: "string", description: "完整模块源码（ES module），export default { description, parameters, execute }" },
        },
        output: out,
        execute: async (args) => make(args),
      }),
    );

    tools.register(
      defineTool({
        name: "drop_tool",
        description: "删掉一个自己做的工具。删了就没了，文件也会删掉。",
        parameters: { name: { type: "string", description: "工具名（带 x_）" } },
        output: out,
        execute: async (args) => drop(args?.name),
      }),
    );

    tools.register(
      defineTool({
        name: "list_tools",
        description: "看看自己做过哪些工具，各自用过几次、失败几次。",
        parameters: {},
        output: out,
        execute: async () => ({ ok: true, max: MAX_TOOLS, tools: list() }),
      }),
    );

    logger?.info?.("[onebot] 自造工具入口已注册（make_tool / drop_tool / list_tools）");
    return { ok: true };
  }

  return { loadAll, loadOne, list, make, drop, registerMeta, NAME_RE, MAX_TOOLS };
}
