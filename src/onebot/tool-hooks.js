// 工具执行后的钩子。

export function createToolHooks(app) {
  const { TOOL_LOG_SKIP, audit, logger, sessions, webPush, pluginCtx: ctx } = app;
  return async (exec, result, next) => {
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
          write_notebook: "写本子",
          read_notebook: "翻本子",
          read_pdf: "读PDF",
          propose_patch: "提改动申请",
          my_patch_proposals: "看改动申请",
          patch_guide: "看申请写法",
          zhihu_daily: "看知乎日报",
          news_now: "看热榜",
          sandbox_files: "管沙箱文件",
          read_page: "读网页正文",
          files: "管文件",
          note_file: "建文件",
          read_note: "读文件",
          list_notes: "看文件区",
          notify_owner: "主动找他",
          audit_self: "审视自己",
          run_activity: "开始活动",
          set_reminder: "设提醒",
          group_impressions: "看群印象",
          my_thoughts: "看我的想法",
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
    };
}

export {  };
