// 工具调用入口：常驻只有 call_tool 和 describe_tool，其余 100 个工具
// 靠提示词里的那张表（tool-table.js）让她知道存在。
import { INTERNAL_TOOLS } from "./tool-table.js";

const MAX_RESULT_CHARS = 2000;

function clip(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s == null) return { text: "", truncated: false };
    if (s.length <= MAX_RESULT_CHARS) return { text: s, truncated: false };
    return { text: s.slice(0, MAX_RESULT_CHARS), truncated: true, total: s.length };
  } catch {
    return { text: "[无法序列化]", truncated: false };
  }
}

/** 精简版 schema：只给参数名、类型、一句话 */
function compactSchema(def) {
  const props = def?.parameters || {};
  const required = new Set(Array.isArray(props.required) ? props.required : []);
  const params = {};
  for (const [k, v] of Object.entries(props.properties || {})) {
    params[k] = {
      type: v?.type || "any",
      ...(required.has(k) ? {} : {}),
      desc: String(v?.description || "").slice(0, 40),
    };
  }
  return {
    brief: String(def?.description || "").split("\n")[0].slice(0, 80),
    params,
  };
}

export function createToolCatalog(app) {
  const { ctx, logger, toolTable } = app;

  function svc() {
    try {
      return ctx?.get?.("tools") ?? null;
    } catch {
      return null;
    }
  }

  function getDef(name) {
    const n = String(name || "").trim();
    if (!n) return null;
    if (INTERNAL_TOOLS.has(n)) return null;
    return svc()?.get?.(n) ?? null;
  }

  async function register() {
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    let tools = svc();
    for (let i = 0; i < 50 && !tools?.register; i += 1) {
      await new Promise((r) => setTimeout(r, 400).unref?.());
      tools = svc();
    }
    if (!tools?.register) {
      logger?.warn?.("[onebot] 工具目录：tools 服务不可用");
      return { ok: false };
    }
    const out = { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] };

    tools.register(
      defineTool({
        name: "call_tool",
        description:
          "按名字调用一个工具。工具清单在上面的「工具」表里，参数名后面带类型。\n" +
          "args 是对象，键跟表里写的一致。参数不确定就先 describe_tool 看一眼。\n" +
          "例：call_tool({ name: \"group_patrol\", args: { group: \"123456789\", hours: 2 } })",
        parameters: {
          name: { type: "string", description: "工具名，从工具表里抄" },
          args: { type: "object", additionalProperties: true, description: "参数对象" },
        },
        output: out,
        execute: async (args, exec) => {
          const name = String(args?.name || "").trim();
          const def = getDef(name);
          if (!def?.execute) {
            return {
              ok: false,
              reason: INTERNAL_TOOLS.has(name)
                ? `${name} 不可用（不是你的工具）`
                : `没有 ${name} 这个工具，看上面的工具表`,
            };
          }
          let a = args?.args;
          if (typeof a === "string") {
            try {
              a = JSON.parse(a);
            } catch {
              return { ok: false, reason: "args 不是合法 JSON" };
            }
          }
          try {
            const r = await def.execute(a || {}, exec);
            const c = clip(r);
            return {
              ok: true,
              tool: name,
              result: c.truncated ? c.text + "…（已截断）" : r,
              ...(c.truncated ? { truncated: true } : {}),
            };
          } catch (err) {
            // 原样带回错误，并附上参数结构，省她一次 describe 往返
            return {
              ok: false,
              tool: name,
              reason: String(err?.message ?? err).slice(0, 300),
              schema: compactSchema(def).params,
            };
          }
        },
      }),
    );

    tools.register(
      defineTool({
        name: "describe_tool",
        description:
          "看工具的参数说明。可以一次看 1~3 个（精简版），要完整 schema 就单个加 full:true。\n" +
          "例：describe_tool({ names: [\"draw_svg\", \"send_image\"] })",
        parameters: {
          name: { type: "string", description: "单个工具名" },
          names: { type: "array", items: { type: "string" }, description: "多个工具名（最多 3 个）" },
          full: { type: "boolean", description: "true = 返回完整 schema（只对单个有效）" },
        },
        output: out,
        execute: async (args) => {
          const names = (Array.isArray(args?.names) ? args.names : args?.name ? [args.name] : [])
            .map((x) => String(x || "").trim())
            .filter(Boolean)
            .slice(0, 3);
          if (!names.length) return { ok: false, reason: "给 name 或 names" };
          const res = {};
          for (const n of names) {
            const def = getDef(n);
            if (!def) {
              res[n] = { ok: false, reason: "没有这个工具" };
              continue;
            }
            res[n] = args?.full === true && names.length === 1
              ? { ok: true, description: String(def.description || "").slice(0, 1200), parameters: def.parameters || {} }
              : { ok: true, ...compactSchema(def) };
          }
          return { ok: true, tools: res };
        },
      }),
    );

    logger?.info?.("[onebot] 工具入口已注册（call_tool / describe_tool）");
    return { ok: true };
  }

  return { register };
}
