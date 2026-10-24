#!/usr/bin/env bash
# 安装 dsh-onebot-bridge 的运行环境（Node 24 + pnpm + DSH CLI）
# 只装依赖，不碰 NapCat、不碰配置。
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.22.1}"
NODE_DIR="/opt/node-v${NODE_VERSION}-linux-x64"

echo "==> 检查系统"
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "只支持 x86_64，当前：$(uname -m)"; exit 1
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "请用 root 运行"; exit 1
fi

echo "==> 安装 Node ${NODE_VERSION}"
if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
  cd /tmp
  curl -fsSL -o node.tar.xz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  tar -xJf node.tar.xz -C /opt
  rm -f node.tar.xz
fi
for b in node npm npx; do
  ln -sf "${NODE_DIR}/bin/${b}" "/usr/local/bin/${b}"
done
node -v

echo "==> 安装 pnpm"
npm i -g pnpm@11 --no-fund --no-audit >/dev/null
ln -sf "${NODE_DIR}/bin/pnpm" /usr/local/bin/pnpm
pnpm -v

echo "==> 安装 DSH CLI"
npm i -g @deepseek-ai/dsh@latest --no-fund --no-audit >/dev/null
ln -sf "${NODE_DIR}/bin/dsh" /usr/local/bin/dsh
dsh --version

echo "==> 安装系统依赖（Xvfb / ffmpeg / git）"
if command -v dnf >/dev/null; then
  dnf install -y xorg-x11-server-Xvfb ffmpeg git >/dev/null 2>&1 || true
elif command -v apt-get >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb ffmpeg git >/dev/null
fi

cat <<'EOF'

✅ 依赖装好了。接下来：

  1. 安装 NapCat（自行从官方仓库）：https://napneko.github.io
  2. 扫码登录，开 OneBot WebSocket（端口 3001）
  3. 把这个仓库装进 DSH：
       dsh plugin --profile web add /path/to/this/repo
  4. 复制配置并填 selfId / ownerId / token：
       mkdir -p ~/.dsh/onebot-bridge
       cp config.example.json ~/.dsh/onebot-bridge/config.json
  5. 设置 API Key（systemd）：
       systemctl edit dsh-web
       # [Service]
       # Environment=DEEPSEEK_API_KEY=sk-xxxx
  6. 启动：
       systemctl restart dsh-web

详见 README.md
EOF
