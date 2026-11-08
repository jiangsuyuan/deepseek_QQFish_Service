// 工具目录表：把 100 来个工具压成一行一个的纯文本，常驻在提示词里。
//
// 和「常驻 schema」的区别：
//   schema 每个工具 400~1300 字节，100 个就是 60 多 KB；
//   这里一行约 45 字符，100 个约 4.5 KB，而且每轮一字不变（能命中缓存）。
//
// 和「按需查目录」的区别：
//   不需要她先查再调，少一轮往返；她永远知道有哪些工具。

const ORDER = ["发消息", "读", "记忆", "群", "活动", "图", "自我", "查询", "其它"];

/** 这些是 DSH 自带 / 已停用的工具，不列进表，也不允许 call_tool 调 */
export const INTERNAL_TOOLS = new Set([
  "workflow", "schedule_create", "schedule_update", "schedule_list", "schedule_delete",
  "subagent", "subagent_fork", "list_agents", "interrupt_agent",
  "job_list", "job_output", "job_kill", "todo_write",
  "create_goal", "get_goal", "update_goal", "exit_plan_mode", "present",
  "working_directory", "ask_user_question", "skill",
  "bash", "read", "write", "edit", "glob", "grep",
  "send_message",
]);

function categoryOf(name) {
  if (/^(reply_to|qq_send|send_|at_person)/.test(name)) return "发消息";
  if (/^(read_|list_|search_|look_|expand_|who_said|files$|web_)/.test(name)) return "读";
  if (/^(remember|recall|forget_|memory_|my_memory|revise_self|drop_want)/.test(name)) return "记忆";
  if (/^(group_|manage_group)/.test(name)) return "群";
  if (/^(run_activity|schedule_activity|my_activities|explore_|my_adventures)/.test(name)) return "活动";
  if (/^(draw_|save_sticker|list_recent_images|send_face|send_like|send_qzone)/.test(name)) return "图";
  if (/^(my_|audit_self|refuse_|person_|read_person|remember_person|note_|handle_request|request_feature)/.test(name)) return "自我";
  if (/^(news_|zhihu_|hot_|bili_)/.test(name)) return "查询";
  return "其它";
}

function typeOf(schema) {
  const t = schema?.type;
  if (!t) return "any";
  if (t === "array") return "array";
  return String(t);
}

/** 一行：name(a:string, b?:number) — 简介 */
function line(tool) {
  const props = tool.parameters?.properties || {};
  const required = new Set(Array.isArray(tool.parameters?.required) ? tool.parameters.required : []);
  const ps = Object.keys(props).slice(0, 5).map((k) => `${k}${required.has(k) ? "" : "?"}:${typeOf(props[k])}`);
  const firstLine = String(tool.description || "").split("\n")[0].trim();
  // 取第一句：遇到句号、分号、括号就停，避免截一半
  const briefRaw = firstLine.split(/[。；;（(]/)[0].trim();
  const brief = briefRaw.length > 18 ? briefRaw.slice(0, 17) + "…" : briefRaw;
  return `${tool.name}(${ps.join(", ")})${brief ? " — " + brief : ""}`;
}

export function createToolTable(app) {
  const { ctx } = app;
  let cache = "";
  let cacheKey = "";

  function svc() {
    try {
      return ctx?.get?.("tools") ?? null;
    } catch {
      return null;
    }
  }

  function usable() {
    const tools = svc();
    if (!tools?.schemas) return [];
    return tools.schemas().filter((t) => !INTERNAL_TOOLS.has(t.name));
  }

  /** 生成完整表；同名同数量时复用 */
  function text() {
    const list = usable();
    if (!list.length) return "";
    const key = list.map((t) => t.name).join(",");
    if (key === cacheKey && cache) return cache;
    const groups = new Map();
    for (const t of list) {
      const c = categoryOf(t.name);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(line(t));
    }
    const out = [];
    for (const c of ORDER) {
      const rows = groups.get(c);
      if (!rows?.length) continue;
      out.push(`【${c}】`);
      rows.sort((a, b) => a.localeCompare(b));
      for (const r of rows) out.push("  " + r);
    }
    cache = out.join("\n");
    cacheKey = key;
    return cache;
  }

  function allowed(name) {
    return usable().some((t) => t.name === name);
  }

  return { text, allowed, usable };
}
