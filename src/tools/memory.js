import { facts } from "../store/facts.js";
import { selfViews } from "../store/selfviews.js";
import { people } from "../store/people.js";
// 记忆类工具。

export function registerMemoryTools(app) {
  const { cfg, logger, recallSearch, pluginCtx: ctx } = app;
  void (async () => {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        ctx.get?.("tools")?.register?.(
          defineTool({
            name: "recall",
            description:
              "**翻聊天原文**——谁在哪天说了什么，一字不差。" +
              "对方说「你记得…吗」「上次那个」「之前提过」时调用。" +
              "\n\n**可以按想法组合查：**" +
              "\n· 只查某个词 → query（模糊匹配，任一命中就算）" +
              "\n· 查某个人说过什么 → person（名字/QQ 号/昵称）" +
              "\n· 只查和主人的对话 → with_me: true" +
              "\n· 查某个群 → group（群号）" +
              "\n· 查某段时间 → since / until（认「上周」「10-24」「昨天」）或 days: 7" +
              "\n· 以上全都可以组合，是 AND 关系" +
              "\n\n**搜不到不等于没有**——只是没匹配上。换个人名、QQ 号、" +
              "或者当时聊到的具体东西再试。",
            parameters: {
              query: {
                type: "string",
                description: "关键词，模糊匹配（拆词后任一命中就算）。可以多个词",
              },
              person: {
                type: "string",
                description: "只看这个人说的：名字 / 昵称 / QQ 号",
              },
              with_me: {
                type: "boolean",
                description: "只看和主人的对话（等价于 person=主人）",
              },
              group: {
                type: "string",
                description: "只看这个群：群号",
              },
              since: {
                type: "string",
                description: "从哪天起：2026-10-24 / 10-24 / 上周 / 昨天 / 3天前",
              },
              until: {
                type: "string",
                description: "到哪天止，格式同 since",
              },
              days: {
                type: "number",
                description: "最近 N 天（等价于 since=N天前）",
              },
              scope: {
                type: "string",
                description: "all（全部会话，默认）/ current（只当前会话）/ groups / privates",
              },
              only_user: {
                type: "boolean",
                description: "只搜对方说的（要核对「他当时到底怎么说的」时用）",
              },
              limit: {
                type: "number",
                description: "最多返回几条，默认 20",
              },
              context: {
                type: "number",
                description: "每条命中带前后各几条上下文（0-10，默认 0）。想看懂某句话在说什么时用",
              },
            },
            output: {
              schema: { type: "json" },
              render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
            },
            execute: async (args, exec) => {
              const sid = exec?.agent?.session?.id;
              // scope 兼容旧参数 all_sessions
              const scope =
                args?.scope ||
                (args?.all_sessions === false ? "current" : "all");
              const res = await recallSearch(sid, args?.query ?? "", {
                cross: scope !== "current",
                scope,
                onlyUser: args?.only_user === true,
                person: args?.with_me ? String(cfg.ownerId) : (args?.person ?? ""),
                group: args?.group ?? "",
                since: args?.since ?? "",
                until: args?.until ?? "",
                days: args?.days ?? 0,
                limit: args?.limit ?? 0,
                context: args?.context ?? 0,
              });
              // 没搜到但跨会话了：给个提示，别让她以为真的没了
              if (res && res.ok !== false && (!res.hits || res.hits.length === 0)) {
                const cond = (res.conditions || []).join(" ");
                return {
                  ...res,
                  hits: [],
                  total: 0,
                  hint:
                    "按这些条件搜（" + (cond || "无条件") + "）一条都没命中。\n" +
                    "**这不代表没有记录**——可能条件太窄，或者词没对上。\n" +
                    "试试：换个人名/QQ 号、放宽时间、或者去掉 query 只按人+时间查。",
                };
              }
              return res;
            },
          }),
        );
        logger.info?.("[onebot] 回忆工具已注册");
      } catch (err) {
        logger.warn?.(`[onebot] 回忆工具注册失败：${err?.message ?? err}`);
      }
    })();

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
            execute: async (args, exec) => {
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
            execute: async (args, exec) => {
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
            execute: async (args, exec) => {
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
            execute: async (args, exec) => {
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
            execute: async (args, exec) => {
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
}

export {  };
