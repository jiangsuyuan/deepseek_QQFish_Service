#!/usr/bin/env bash
# 安装掉线看门狗（systemd timer，每 2 分钟检查一次）
# 用法：sudo bash scripts/install-watchdog.sh
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "请用 root 运行"; exit 1
fi

HOME_DIR="${HOME:-/root}"
TARGET="${HOME_DIR}/.dsh/onebot-bridge/watchdog.py"
SRC="$(cd "$(dirname "$0")" && pwd)/watchdog.py"

if [[ ! -f "$SRC" ]]; then
  echo "找不到 $SRC"; exit 1
fi

mkdir -p "$(dirname "$TARGET")"
install -m 755 "$SRC" "$TARGET"
echo "已安装：$TARGET"

cat > /etc/systemd/system/qq-watchdog.service <<EOF
[Unit]
Description=QQ OneBot watchdog (auto recover + optional email alert)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 ${TARGET}
EOF

cat > /etc/systemd/system/qq-watchdog.timer <<'EOF'
[Unit]
Description=Run QQ watchdog every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=qq-watchdog.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now qq-watchdog.timer

echo
systemctl list-timers qq-watchdog.timer --no-pager | head -3
echo
echo "看门狗已启动。日志：${HOME_DIR}/.dsh/onebot-bridge/alert.log"
echo
echo "如需邮件告警，创建 ${HOME_DIR}/.dsh/onebot-bridge/mail.json："
cat <<'JSON'
{
  "host": "smtp.qq.com",
  "port": 465,
  "user": "你的QQ邮箱@qq.com",
  "pass": "SMTP授权码（不是登录密码）",
  "to": "接收告警的邮箱@qq.com"
}
JSON
echo
echo "然后手动测一次："
echo "  python3 ${TARGET}"
echo "  tail -5 ${HOME_DIR}/.dsh/onebot-bridge/alert.log"
