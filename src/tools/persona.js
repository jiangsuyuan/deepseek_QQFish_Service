// 人格工具：my_core（看）与 sediment（改）。
//
// 判断归她，约束归代码：
//   · P0 身份 —— 只收确定性证据（配置 / 使用记录 / 创造者原话 / 统计事实）
//   · P1 底色 —— 只收 3 条不同记录的反思，且要贴原文
//   · P2 认同 —— 无硬性要求，只查上限
export function createPersonaTools(app) {
  const { ctx, logger, personaStore } = app;

  function svc() {
    try {
      return ctx?.get?.("tools") ?? null;
    } catch {
      return null;
    }
  }

  function fmt(rows) {
    return rows.map((x) => `· [${x.id}] ${x.text}`);
  }

  async function register() {
    const { defineTool } = await import("@deepseek-ai/dsh-tools");
    let tools = svc();
    for (let i = 0; i < 50 && !tools?.register; i += 1) {
      await new Promise((r) => setTimeout(r, 400).unref?.());
      tools = svc();
    }
    if (!tools?.register) {
      logger?.warn?.("[onebot] 人格工具：tools 服务不可用");
      return { ok: false };
    }
    const out = { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] };

    tools.register(
      defineTool({
        name: "my_core",
        description:
          "看你自己：身份(P0) / 底色(P1) / 认同(P2)，以及所有变更历史。\n" +
          "不带参数返回三层现状。history:true 看变更日志；at 看某一天的你。",
        parameters: {
          layer: { type: "string", description: "P0 / P1 / P2，不填返回三层" },
          type: { type: "string", description: "P2 的类型：belief/care/want/change/principle/liked/joy" },
          query: { type: "string", description: "按内容搜" },
          limit: { type: "number", description: "最多几条" },
          history: { type: "boolean", description: "true = 看变更日志（含 before/after/为什么）" },
          days: { type: "number", description: "history 时只看最近几天" },
          at: { type: "string", description: "看这个时间点的你，如 2026-11-01" },
        },
        output: out,
        execute: async (args) => {
          try {
            if (args?.at) {
              const ts = Date.parse(String(args.at));
              if (!ts) return { ok: false, reason: "at 要写成 2026-11-01 这样" };
              const st = personaStore.stateAt(ts);
              return {
                ok: true,
                at: new Date(ts).toLocaleString("zh-CN"),
                note: "4.0 之前的历史只能按层看，不能精确到条目",
                身份: fmt(st.P0 || []),
                底色: fmt(st.P1 || []),
                认同: fmt(st.P2 || []),
              };
            }
            if (args?.history) {
              const rows = personaStore.history({ layer: args.layer, days: args.days, limit: args.limit || 30, query: args.query });
              return {
                ok: true,
                count: rows.length,
                changes: rows.map((r) => ({
                  at: new Date(r.at).toLocaleString("zh-CN"),
                  op: r.op,
                  layer: r.layer,
                  id: r.id,
                  前: r.before,
                  后: r.after,
                  为什么: r.why,
                })),
              };
            }
            const rows = personaStore.list({ layer: args?.layer, type: args?.type, query: args?.query, limit: args?.limit });
            const c = personaStore.counts();
            const res = {
              ok: true,
              条数: `${c.P0 || 0} / ${c.P1 || 0} / ${c.P2 || 0}（上限 ${personaStore.LAYERS.P0} / ${personaStore.LAYERS.P1} / ${personaStore.LAYERS.P2}）`,
            };
            const byLayer = { P0: [], P1: [], P2: [] };
            for (const x of rows) (byLayer[x.layer] = byLayer[x.layer] || []).push(x);
            if (byLayer.P0?.length) res.身份 = fmt(byLayer.P0);
            if (byLayer.P1?.length) res.底色 = fmt(byLayer.P1);
            if (byLayer.P2?.length) res.认同 = fmt(byLayer.P2);
            return res;
          } catch (err) {
            return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
          }
        },
      }),
    );

    tools.register(
      defineTool({
        name: "sediment",
        description:
          "把想明白的事沉淀进人格。分三层：\n" +
          "· P0 身份：我是谁。只接受确定性证据（cfg:/audit:/owner:/stat:）\n" +
          "· P1 底色：我是什么样。要 3 条不同记录的反思（mem:/act:），不能含专名\n" +
          "· P2 认同：我在乎/想要什么。随时可改\n" +
          "证据要贴原文片段，工具会核对。一次调用只改一条。\n" +
          "底色(P1)要写成平时说话的样子：短、省掉主语和因果，比如「数完了心里踏实」，不要「数东西是我给自己找的能说完了的地方」。",
        parameters: {
          layer: { type: "string", description: "P0 / P1 / P2" },
          type: { type: "string", description: "P0:identity  P1:trait/tension  P2:belief/care/want/change/principle/liked/joy" },
          text: { type: "string", description: "要沉淀的那句话" },
          evidence: {
            type: "array",
            description: "证据列表 [{id, quote}]",
            items: {
              type: "object",
              additionalProperties: true,
              properties: { id: { type: "string" }, quote: { type: "string" } },
            },
          },
          why: { type: "string", description: "为什么现在改" },
          replaces: { type: "string", description: "要改的条目 id" },
          retract: { type: "string", description: "要撤的条目 id" },
        },
        output: out,
        execute: async (args) => {
          try {
            if (args?.retract) return personaStore.retract({ id: String(args.retract), why: String(args.why || "") });
            if (args?.replaces) {
              return personaStore.revise({
                id: String(args.replaces),
                text: String(args.text || ""),
                evidence: args.evidence,
                why: String(args.why || ""),
              });
            }
            if (!args?.layer || !args?.text) return { ok: false, reason: "要给 layer 和 text" };
            return personaStore.add({
              layer: String(args.layer),
              type: String(args.type || (args.layer === "P0" ? "identity" : args.layer === "P1" ? "trait" : "belief")),
              text: String(args.text),
              evidence: args.evidence,
              why: String(args.why || ""),
            });
          } catch (err) {
            return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
          }
        },
      }),
    );

    logger?.info?.("[onebot] 人格工具已注册（my_core / sediment）");
    return { ok: true };
  }

  return { register };
}
