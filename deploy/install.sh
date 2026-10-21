#!/usr/bin/env bash
# ============================================================
# stkj 全新安装脚本（Debian 13 / 12，x86_64 或 arm64）
#
# 作用：下载 Node.js → 铺设代码 → 初始化数据库 → 安装并启动
#       systemd 用户服务 + 每日备份定时器。
#
# 用法（以普通用户身份执行，不要用 sudo 跑本脚本）：
#   bash install.sh <代码包路径或 git 仓库地址> [选项]
#
# 示例：
#   bash install.sh ~/stkj-code.tar.gz
#   bash install.sh git@github.com:dakerclaw/stkjinfo.git
#
# 选项：
#   --node-version=v22.23.3   指定 Node 版本（默认 v22.23.3）
#   --port=5173               监听端口（默认 5173）
#   --host=0.0.0.0            监听地址（默认 0.0.0.0；改 127.0.0.1 则仅本机可访问）
#   --dir=~/apps/stkj         安装目录（默认 ~/apps/stkj）
#   --no-backup-timer         不安装每日自动备份定时器
#   --with-linger             自动执行 sudo loginctl enable-linger（免登录自启）
#
# 说明：
#   - Node.js 解压到 ~/apps/node-v<版本>-linux-<arch>，不污染系统 PATH，无需 root
#   - 已有数据库时不会覆盖，只做补建表与字段迁移
#   - linger 需要 sudo，脚本默认只提示命令，不自动执行
# ============================================================
set -euo pipefail

NODE_VER="v22.23.3"
PORT="5173"
HOST="0.0.0.0"
APP_DIR="$HOME/apps/stkj"
INSTALL_BACKUP=1
WITH_LINGER=0
SRC=""

# 先解析选项，剩下第一个非选项参数才是代码来源（避免把 --help 当成 SRC）
for arg in "$@"; do
  case "$arg" in
    --node-version=*) NODE_VER="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --host=*) HOST="${arg#*=}" ;;
    --dir=*) APP_DIR="${arg#*=}" ;;
    --no-backup-timer) INSTALL_BACKUP=0 ;;
    --with-linger) WITH_LINGER=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$arg（用 --help 查看用法）"; exit 1 ;;
    *) [ -z "$SRC" ] && SRC="$arg" ;;
  esac
done

[ -n "$SRC" ] || { echo "用法：bash install.sh <代码包.tar.gz | git 仓库地址>"; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "✗ 请不要用 root/sudo 运行本脚本（systemd user 服务需普通用户）"; exit 1; }

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "✗ 不支持的架构：$ARCH"; exit 1 ;;
esac

NODE_DIR="$HOME/apps/node-${NODE_VER}-linux-${NODE_ARCH}"
NODE_BIN="$NODE_DIR/bin/node"
UNIT_DIR="$HOME/.config/systemd/user"
LOG_DIR="$APP_DIR/logs"

echo "============================================"
echo " stkj 安装"
echo "   代码来源 : $SRC"
echo "   安装目录 : $APP_DIR"
echo "   Node     : $NODE_VER ($NODE_ARCH)"
echo "   监听     : $HOST:$PORT"
echo "============================================"

# ------------------------------------------------------------ 1. Node.js
echo
echo "==> [1/6] 准备 Node.js"
if [ -x "$NODE_BIN" ]; then
  echo "  已存在：$("$NODE_BIN" -v)"
else
  mkdir -p "$HOME/apps"
  TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
  URL="https://npmmirror.com/mirrors/node/${NODE_VER}/${TARBALL}"
  FALLBACK="https://nodejs.org/dist/${NODE_VER}/${TARBALL}"
  cd "$HOME/apps"
  echo "  下载 $URL"
  if ! curl -fL --retry 3 -o "$TARBALL" "$URL"; then
    echo "  镜像失败，改用官方源：$FALLBACK"
    curl -fL --retry 3 -o "$TARBALL" "$FALLBACK"
  fi
  tar -xf "$TARBALL"
  rm -f "$TARBALL"
  # 官方解压出来是 node-v22.23.3-linux-x64，与 NODE_DIR 一致
  [ -x "$NODE_BIN" ] || { echo "✗ Node 解压后找不到 $NODE_BIN"; exit 1; }
  echo "  已安装：$("$NODE_BIN" -v) → $NODE_DIR"
fi

# ------------------------------------------------------------ 2. 代码
echo
echo "==> [2/6] 铺设代码到 $APP_DIR"
mkdir -p "$APP_DIR"
if [ -d "$SRC/.git" ]; then
  # 已有 git 工作副本：直接更新
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone "$SRC" "$APP_DIR"
  fi
elif [ "${SRC#http}" != "$SRC" ] || [ "${SRC#git@}" != "$SRC" ]; then
  # 远程仓库地址
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone "$SRC" "$APP_DIR"
  fi
else
  # 本地压缩包
  if [ ! -f "$SRC" ]; then
    echo "✗ 找不到代码包：$SRC"
    echo "  提示：代码来源可以是 .tar.gz 路径、本地 git 目录，或 git@github.com:... 地址"
    exit 1
  fi
  tar -xzf "$SRC" -C "$APP_DIR" --exclude=data --exclude=logs --exclude='*.db*'
  echo "  已解包：$(basename "$SRC")"
fi
cd "$APP_DIR"
[ -f server.js ] || { echo "✗ $APP_DIR 下没有 server.js，代码包内容不对"; exit 1; }

# ------------------------------------------------------------ 3. 目录与权限
echo
echo "==> [3/6] 准备数据目录与权限"
mkdir -p "$APP_DIR/data" "$APP_DIR/backups" "$LOG_DIR"
chmod 700 "$APP_DIR/data" "$APP_DIR/backups"
chmod 750 "$LOG_DIR"
# 代码里没有密钥文件，但避免误放
find "$APP_DIR" -maxdepth 1 -name '*.pem' -o -maxdepth 1 -name '*.key' 2>/dev/null | while read -r f; do
  chmod 600 "$f"
done
echo "  data/ backups/ 权限已收紧为 700"

# ------------------------------------------------------------ 4. 数据库
echo
echo "==> [4/6] 初始化数据库"
if [ -f "$APP_DIR/data/app.db" ] && [ -s "$APP_DIR/data/app.db" ]; then
  echo "  已存在数据库，跳过初始化（不会覆盖现有数据）"
  "$NODE_BIN" --no-warnings -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    console.log('  现有数据：项目', db.prepare('SELECT COUNT(*) c FROM projects').get().c,
                '条，数据', db.prepare('SELECT COUNT(*) c FROM project_data').get().c, '条');
    db.close();" "$APP_DIR/data/app.db"
else
  "$NODE_BIN" --no-warnings seed.js
fi

# ------------------------------------------------------------ 5. systemd
echo
echo "==> [5/6] 安装 systemd 用户服务"
mkdir -p "$UNIT_DIR"
sed -e "s|%h/apps/stkj/logs|$LOG_DIR|g" \
    -e "s|%h/apps/stkj|$APP_DIR|g" \
    -e "s|%h/apps/node|$NODE_DIR|g" \
    -e "s|Environment=PORT=5173|Environment=PORT=$PORT|" \
    -e "s|Environment=HOST=0.0.0.0|Environment=HOST=$HOST|" \
    deploy/stkj.service > "$UNIT_DIR/stkj.service"

if [ "$INSTALL_BACKUP" = "1" ]; then
  sed -e "s|%h/apps/stkj/logs|$LOG_DIR|g" \
      -e "s|%h/apps/stkj|$APP_DIR|g" \
      -e "s|%h/apps/node|$NODE_DIR|g" \
      deploy/stkj-backup.service > "$UNIT_DIR/stkj-backup.service"
  cp deploy/stkj-backup.timer "$UNIT_DIR/stkj-backup.timer"
else
  rm -f "$UNIT_DIR/stkj-backup.service" "$UNIT_DIR/stkj-backup.timer"
fi

systemctl --user daemon-reload
systemctl --user enable --now stkj.service
if [ "$INSTALL_BACKUP" = "1" ]; then
  systemctl --user enable --now stkj-backup.timer
fi
sleep 3

if systemctl --user is-active --quiet stkj.service; then
  echo "  服务已启动"
else
  echo "✗ 服务启动失败，最近日志："
  tail -30 "$LOG_DIR/app.log" 2>/dev/null || true
  exit 1
fi

# ------------------------------------------------------------ 6. 自检
echo
echo "==> [6/6] 自检"
curl -s -o /dev/null -w "  本机访问 http://127.0.0.1:$PORT/ → HTTP %{http_code}\n" "http://127.0.0.1:$PORT/" || true

LINGER=$(loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | cut -d= -f2 || echo no)
if [ "$LINGER" != "yes" ]; then
  if [ "$WITH_LINGER" = "1" ]; then
    echo "  开启 linger（开机免登录自启）..."
    sudo loginctl enable-linger "$(id -un)"
    echo "  已开启"
  else
    echo
    echo "  ! 未开启 linger：重启后需该用户登录才会拉起服务"
    echo "    如需开机自启，可执行：sudo loginctl enable-linger $(id -un)"
  fi
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "============================================"
echo " 安装完成"
echo "   访问地址 : http://${IP:-127.0.0.1}:$PORT"
echo "   默认账号 : admin / admin123  ← 请立即修改"
echo "   服务管理 : systemctl --user status stkj"
echo "   查看日志 : tail -f $LOG_DIR/app.log"
echo "============================================"
