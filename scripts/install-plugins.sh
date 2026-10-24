#!/usr/bin/env bash
# 安装配套插件（默认装到 web profile）
# 用法：bash scripts/install-plugins.sh [profile]
set -uo pipefail

PROFILE="${1:-${DSH_PROFILE:-web}}"

PLUGINS=(
  "github:Yuuyuko-uu/dsh-fish-memory"
  "github:Yuuyuko-uu/dsh-speak-up"
  "github:Yuuyuko-uu/dsh-tts-bridge"
  "github:Yuuyuko-uu/dsh-bili-subagent"
  "github:Yuuyuko-uu/dsh-feiyu-mood"
)

echo "==> 安装配套插件到 profile: ${PROFILE}"
echo "    （这些插件提供记忆、主动搭话、朗读、B 站、心情能力）"
echo

fail=0
for p in "${PLUGINS[@]}"; do
  name="${p##*/}"
  printf "  %-24s " "$name"
  if dsh plugin --profile "$PROFILE" add "$p" >/tmp/dsh-plugin.log 2>&1; then
    echo "✅"
  else
    echo "⚠️  失败（可稍后手动重试）"
    tail -3 /tmp/dsh-plugin.log | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "✅ 全部装好。重启 DSH 生效：systemctl restart dsh-web"
else
  echo "⚠️  有 ${fail} 个没装上，不影响主功能，可稍后执行："
  echo "    dsh plugin --profile ${PROFILE} add <插件地址>"
fi
