// 群管理：入群申请、退群、邀请回复、记住某人的请求。

export function createGroupAdmin(ctx) {
  const { audit, cfg, client, facts, logger, pendingFriends, pendingInvites } = ctx;
  async function handleGroupRequest(ev) {
      try {
        // 加好友请求：转告创造者
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
            logger.info?.(`[onebot] 好友请求已转告创造者：${userId}`);
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
          logger.info?.(`[onebot] 创造者的邀请，直接同意：群 ${groupId}`);
          return;
        }

        pendingInvites.set(flag, { groupId, inviter, subType, at: Date.now() });
        const kind = subType === "invite" ? "邀请我进群" : "提交了加群申请";
        const msg =
          `有人${kind}：群 ${groupId}，发起人 ${inviter}。` +
          `\n要进吗？回复「同意」或「拒绝」（这是最近一条邀请）。`;
        if (cfg.ownerId) {
          await client.sendPrivate(cfg.ownerId, msg);
          logger.info?.(`[onebot] 入群邀请已转问创造者：群 ${groupId} 来自 ${inviter}`);
        } else {
          logger.warn?.("[onebot] 收到入群邀请但未配置 ownerId，无法确认");
        }
      } catch (err) {
        logger.warn?.(`[onebot] 处理入群邀请失败：${err?.message ?? err}`);
      }
    }

  async function handleOwnerRemember(ev, text) {
      if (!cfg.ownerId || String(ev.user_id) !== String(cfg.ownerId)) return false;
      if (ev.message_type === "group") return false;
      const m = String(text || "").match(/^(记住|记一下|记下)[，,：:\s]*(.+)$/);
      if (!m) return false;
      const saved = facts.add(m[2], "owner");
      if (saved) {
        await client.sendPrivate(cfg.ownerId, `记住了：${saved}\n（所有会话都能用到）`);
        logger.info?.(`[onebot] 创造者写入全局事实：${saved}`);
      } else {
        await client.sendPrivate(cfg.ownerId, "这条没存：内容为空或含敏感信息（QQ号/密钥/路径/口令）。");
      }
      return true;
    }

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
        logger.info?.(`[onebot] 创造者${yes ? "同意" : "拒绝"}了群 ${info.groupId} 的邀请`);
      } catch (err) {
        logger.warn?.(`[onebot] 执行入群决定失败：${err?.message ?? err}`);
        await client.sendPrivate(cfg.ownerId, `操作失败：${String(err?.message ?? err).slice(0, 120)}`);
      }
      return true;
    }

  return { handleGroupRequest, handleOwnerLeaveGroup, handleOwnerInviteReply, handleOwnerRemember };
}

export {  };
