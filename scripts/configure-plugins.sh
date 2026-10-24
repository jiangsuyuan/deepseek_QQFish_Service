#!/usr/bin/env bash
# 把已有的 QQ 会话一次性接进配套插件（fish-memory / speak-up / feiyu-mood）
#
# 适用场景：装完之后、或换了机器/换了 QQ，想批量补配置。
# 桥在运行时也会自动配置新会话，这个脚本是给"离线状态"用的。
#
# 用法：bash scripts/configure-plugins.sh
set -euo pipefail

exec python3 - <<'PY'
import glob
import json
import os

base = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
sessions = os.path.join(base, "sessions")

# 找出所有桥创建的会话目录（ob-<hash>-<seq>）
ids = sorted({
    os.path.basename(d)
    for d in glob.glob(os.path.join(sessions, "*", "ob-*"))
    if os.path.isdir(d)
})

if not ids:
    print("没有找到任何 QQ 会话（ob-*），先启动一次 DSH 并让机器人收到消息")
    raise SystemExit(0)

print(f"找到 {len(ids)} 个会话：")
for i in ids:
    print("  -", i)
print()


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# 1) fish-memory：全部开启
fp = os.path.join(base, "fish-memory-config.json")
d = load(fp)
d.setdefault("sessions", {})
added = 0
for sid in ids:
    if not d["sessions"].get(sid):
        d["sessions"][sid] = True
        added += 1
d["switchMigrated"] = True
save(fp, d)
print(f"fish-memory : 新增 {added} 个会话（共 {len([v for v in d['sessions'].values() if v])} 个开启）")

# 2) speak-up：加进目标列表
sp = os.path.join(base, "speak-up-config.json")
d = load(sp)
lst = d.get("目标会话") if isinstance(d.get("目标会话"), list) else []
added = 0
for sid in ids:
    if sid not in lst:
        lst.append(sid)
        added += 1
d["目标会话"] = lst
d.setdefault("总开关", True)
d.setdefault("间隔分钟", 30)
save(sp, d)
print(f"speak-up    : 新增 {added} 个目标（共 {len(lst)} 个）")

# 3) feiyu-mood：没设过目标就设第一个
mp = os.path.join(base, "feiyu-mood", "config.json")
d = load(mp)
if not d.get("targetSession"):
    d["targetSession"] = ids[0]
    d.setdefault("selfName", "伙伴")
    d.setdefault("ownerName", "用户")
    d.setdefault("moodBase", 70)
    d.setdefault("injectMode", "event")
    d.setdefault("injectPerDay", 6)
    save(mp, d)
    print(f"feiyu-mood  : 目标设为 {ids[0]}")
else:
    print(f"feiyu-mood  : 已有目标 {d['targetSession']}，保持不变")

print()
print("完成。重启 DSH 让配置生效：systemctl restart dsh-web")
PY
