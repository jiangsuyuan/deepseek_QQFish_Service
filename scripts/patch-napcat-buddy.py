#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 NapCat 打补丁：暴露「联系人 - 好友通知」的接口。

NapCat 本身只把好友申请暴露给了自己的 WebUI，没有 OneBot action，
所以桥查不到「谁申请加我好友」。这个补丁注入两个 action：

    get_buddy_req   → 读好友申请列表
    set_buddy_req   → 批准 / 拒绝

用法（在部署机器上，需要 root）：
    python3 patch-napcat-buddy.py
然后重启 NapCat：systemctl restart napcat

注意：
  * 打完补丁必须重启 NapCat，会触发重新登录
  * NapCat 升级会覆盖 napcat.mjs，升级后需要重新打
  * 原始文件备份在 napcat.mjs.bak-buddy
"""

import io
import os
import shutil
import sys

P = "/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs"
BAK = P + ".bak-buddy"

if not os.path.exists(P):
    print("找不到 napcat.mjs，请确认 NapCat 安装路径：", P)
    sys.exit(1)

s = io.open(P, encoding="utf-8", errors="ignore").read()

if "get_buddy_req" in s:
    print("已经打过补丁了，不用重复")
    sys.exit(0)

if not os.path.exists(BAK):
    shutil.copyfile(P, BAK)
    print("已备份 ->", BAK)

marker = "class h_e extends ue {"
idx = s.find(marker)
if idx < 0:
    print("找不到插入点，可能是 NapCat 版本差异，请手动处理")
    sys.exit(1)

NEW = '''
class DshBuddyReqGet extends ue {
  actionName = "get_buddy_req";
  payloadSchema = p.Object({});
  actionSummary = "获取好友通知";
  actionDescription = "获取「联系人-好友通知」里的申请列表";
  actionTags = ["系统接口"];
  async _handle(e) {
    try {
      return await this.core.apis.FriendApi.getBuddyReq();
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }
}
class DshBuddyReqSet extends ue {
  actionName = "set_buddy_req";
  payloadSchema = p.Object({
    friendUid: p.String({ description: "好友 uid" }),
    reqTime: p.Optional(p.String({ default: "" })),
    approve: p.Boolean({ default: true })
  });
  actionSummary = "处理好友通知";
  actionDescription = "批准或拒绝好友申请";
  actionTags = ["系统接口"];
  async _handle(e) {
    try {
      await this.core.apis.FriendApi.handleFriendRequest(
        { friendUid: e.friendUid, reqTime: e.reqTime || "" },
        !!e.approve
      );
      return { ok: true };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }
}
'''

s = s[:idx] + NEW + s[idx:]

old_reg = "new h_e(t, e),"
new_reg = "new h_e(t, e), new DshBuddyReqGet(t, e), new DshBuddyReqSet(t, e),"
if old_reg not in s:
    print("找不到 action 注册点，请手动处理")
    sys.exit(1)
s = s.replace(old_reg, new_reg, 1)

io.open(P, "w", encoding="utf-8").write(s)
print("补丁已应用，文件大小", len(s))
print("现在重启 NapCat：systemctl restart napcat")
