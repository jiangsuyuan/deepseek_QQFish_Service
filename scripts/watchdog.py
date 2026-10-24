#!/usr/bin/env python3
"""NapCat 登录态看门狗 + 自动恢复。

策略：
  1. 探测 3001（OneBot 端口）
  2. 不通超过 2 分钟 → 看看最近有没有在等扫码
  3. 没在等扫码 → 自动 systemctl restart napcat（走快速登录）
  4. 重启后仍不通 → 记录，等待人工扫码
  5. 每小时最多自动重启 2 次，避免刷屏
  6. 如果配置了邮箱，掉线超过 3 分钟会发一封告警（12 小时内不重复）

⚠️ 邮件部分未经过实际发送验证（开发环境没有可用的 SMTP 授权码）。
   代码路径完整，但第一次启用时请手动触发一次确认能收到。
"""
import json
import os
import smtplib
import socket
import ssl
import subprocess
import time
from email.header import Header
from email.mime.text import MIMEText

HOME = os.path.expanduser("~")
BASE = os.path.join(os.environ.get("DSH_HOME") or os.path.join(HOME, ".dsh"), "onebot-bridge")
STATE = os.path.join(BASE, "alert_state.json")
CFG = os.path.join(BASE, "mail.json")
LOG = os.path.join(BASE, "alert.log")
AUTO = os.path.join(BASE, "auto_restart.json")
QRCODE = os.path.join(
    HOME, "Napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png"
)


def log(msg):
    try:
        os.makedirs(BASE, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass


def load_json(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass


def port_open(port=3001):
    s = socket.socket()
    s.settimeout(3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def qrcode_recent(minutes=6):
    """最近 N 分钟内是否生成过二维码（说明正在等扫码，别打断）"""
    try:
        out = subprocess.run(
            ["journalctl", "-u", "napcat", "--since", "%d min ago" % minutes,
             "--no-pager", "-q"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        return "二维码已保存" in out or "二维码解码URL" in out
    except Exception:
        return False


def auto_restart_allowed():
    """每小时最多 2 次"""
    now = time.time()
    st = load_json(AUTO, {"hour_start": 0, "count": 0})
    if now - float(st.get("hour_start") or 0) > 3600:
        st = {"hour_start": now, "count": 0}
    if int(st.get("count", 0)) >= 2:
        return False, st
    st["count"] = int(st.get("count", 0)) + 1
    st["last"] = now
    save_json(AUTO, st)
    return True, st


def send_mail(cfg, subject, body):
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = cfg["user"]
    msg["To"] = cfg["to"]
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(cfg.get("host", "smtp.qq.com"), int(cfg.get("port", 465)),
                          context=ctx, timeout=20) as s:
        s.login(cfg["user"], cfg["pass"])
        s.sendmail(cfg["user"], [cfg["to"]], msg.as_string())


def check_mail_config(cfg):
    """返回配置是否足以发信"""
    return bool(cfg.get("user") and cfg.get("pass") and cfg.get("to"))


def main():
    cfg = load_json(CFG, {})
    state = load_json(STATE, {"down_since": None, "last_alert": 0})
    now = time.time()

    if port_open():
        if state.get("down_since"):
            log("已恢复（掉线 %.0f 分钟）" % ((now - state["down_since"]) / 60))
        state["down_since"] = None
        save_json(STATE, state)
        return

    if not state.get("down_since"):
        state["down_since"] = now
        log("检测到 3001 不通，开始计时")
        save_json(STATE, state)

    down_min = (now - state["down_since"]) / 60

    # 自动恢复：掉线超过 2 分钟、不在等扫码、额度够 → 重启 NapCat
    if down_min >= 2 and not qrcode_recent(6):
        allowed, st = auto_restart_allowed()
        if allowed:
            log("尝试自动恢复：重启 napcat（第 %d 次/小时）" % st["count"])
            try:
                subprocess.run(["systemctl", "restart", "napcat"], timeout=90)
                log("已重启 napcat，等待 40s 检查…")
                time.sleep(40)
                if port_open():
                    log("自动恢复成功（快速登录生效）")
                    state["down_since"] = None
                    save_json(STATE, state)
                    return
                log("自动恢复失败，可能票据失效，需要扫码")
            except Exception as e:
                log("自动重启异常：%s" % e)
        else:
            log("本小时自动重启额度已用完，等待人工处理")

    # 邮件告警（如果配了邮箱）
    if down_min >= 3 and now - float(state.get("last_alert") or 0) > 43200:
        if check_mail_config(cfg):
            body = (
                "NapCat 的 OneBot 端口 3001 已连续不通 %.0f 分钟。\n"
                "自动恢复已尝试过，若仍不通大概率需要重新扫码。\n\n"
                "二维码：%s\n"
                "（本邮件 12 小时内不重复）\n" % (down_min, QRCODE)
            )
            try:
                send_mail(cfg, "[QQ 机器人] 掉线提醒", body)
                state["last_alert"] = now
                log("已发送掉线邮件 -> %s" % cfg.get("to"))
            except Exception as e:
                log("发送失败：%s" % e)
        else:
            log("掉线但 mail.json 未配置，跳过发信")

    save_json(STATE, state)


if __name__ == "__main__":
    main()
