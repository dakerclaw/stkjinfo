#!/usr/bin/env bash
# ============================================================
# 更新脚本
# 作用：把更新包里的最新代码铺到代码目录，并重启服务。
#       保留 data/ 数据库与 logs/ 日志不动。
# 用法：
#   bash apply-update.sh <更新包.tar.gz>
#   bash apply-update.sh <更新包.tar.gz> --dir=~/apps/stkj
#   bash apply-update.sh --git                 # 直接从 git 拉取最新代码
#
# 环境变量：
#   STKJ_APP_DIR  代码目录（默认 ~/apps/stkj）
#   STKJ_NODE     node 可执行文件（默认自动探测）
#   STKJ_PORT     服务端口（默认 5173）
# ============================================================
set -euo pipefail

APP_DIR="${STKJ_APP_DIR:-$HOME/apps/stkj}"
PORT="${STKJ_PORT:-5173}"
PKG=""
USE_GIT=0

for arg in "$@"; do
  case "$arg" in
    --dir=*) APP_DIR="${arg#*=}" ;;
    --git) USE_GIT=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "未知参数：$arg"; exit 1 ;;
    *) PKG="$arg" ;;
  esac
done

# Node 自动探测：优先环境变量，其次 ~/apps/node-*，最后 PATH 中的 node
NODE_FOUND=""
for cand in "$HOME"/apps/node-v*/bin/node; do
  [ -x "$cand" ] && NODE_FOUND="$cand"    # 通配按字典序展开，取最后一个
done
if [ -n "${STKJ_NODE:-}" ]; then
  NODE="$STKJ_NODE"
elif [ -n "$NODE_FOUND" ]; then
  NODE="$NODE_FOUND"
elif command -v node > /dev/null 2>&1; then
  NODE=$(command -v node)
else
  echo "✗ 找不到 node，请用 STKJ_NODE 指定路径"; exit 1
fi

[ -d "$APP_DIR" ] || { echo "✗ 代码目录不存在：$APP_DIR"; exit 1; }
[ -x "$NODE" ] || { echo "✗ node 不可执行：$NODE"; exit 1; }

if [ "$USE_GIT" = "0" ]; then
  [ -n "$PKG" ] || { echo "用法：bash apply-update.sh <更新包.tar.gz>（或用 --git）"; exit 1; }
  [ -f "$PKG" ] || { echo "✗ 找不到更新包：$PKG"; exit 1; }
fi

echo "==> 代码目录: $APP_DIR"
echo "==> Node    : $NODE ($("$NODE" -v))"
[ "$USE_GIT" = "1" ] && echo "==> 更新方式: git pull" || echo "==> 更新包  : $PKG"

# 1) 备份当前代码（不含 data/ 与 logs/）
cd "$APP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$HOME/apps/backups"
tar -czf "$HOME/apps/backups/code-$STAMP.tar.gz" \
    --exclude=data --exclude=logs --exclude=backups --exclude='*.bak*' . 2>/dev/null || true
echo "==> 已备份当前代码: ~/apps/backups/code-$STAMP.tar.gz"

# 2) 停止服务
systemctl --user stop stkj.service 2>/dev/null || true
sleep 1

# 3) 更新代码（不碰 data/ 与 logs/）
if [ "$USE_GIT" = "1" ]; then
  [ -d "$APP_DIR/.git" ] || { echo "✗ $APP_DIR 不是 git 仓库，无法 --git 更新"; exit 1; }
  git -C "$APP_DIR" pull --ff-only || { echo "✗ git pull 失败，请手动处理冲突"; exit 1; }
  echo "==> 代码已更新（git pull）"
else
  tar -xzf "$PKG" -C "$APP_DIR" --exclude=data --exclude=logs
  echo "==> 代码已更新（解包 $PKG）"
fi

# 4) 语法自检（兼容根目录与 stkjinfo/ 子目录两种代码布局）
if [ -f "$APP_DIR/server.js" ]; then
  CODE_DIR="$APP_DIR"
elif [ -f "$APP_DIR/stkjinfo/server.js" ]; then
  CODE_DIR="$APP_DIR/stkjinfo"
else
  echo "✗ 在 $APP_DIR 下找不到 server.js，更新包内容不对"; exit 1
fi
echo "==> 代码目录: $CODE_DIR"
cd "$CODE_DIR"
for f in server.js db.js xlsx.js seed.js; do
  [ -f "$f" ] && "$NODE" --check "$f"
done
echo "==> 语法检查通过"

# 4.1) 修补旧版服务单元：代码迁到子目录后，WorkingDirectory 与 DATA_DIR 必须跟着改，
#      否则服务会在仓库根找不到 server.js，或把数据库建到代码目录里。
UNIT="$HOME/.config/systemd/user/stkj.service"
if [ -f "$UNIT" ]; then
  CHANGED=0
  if ! grep -q '^Environment=DATA_DIR=' "$UNIT"; then
    sed -i "/^WorkingDirectory=/a Environment=DATA_DIR=$APP_DIR/data" "$UNIT"
    CHANGED=1
  fi
  if ! grep -qx "WorkingDirectory=$CODE_DIR" "$UNIT"; then
    sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$CODE_DIR|" "$UNIT"
    CHANGED=1
  fi
  if [ "$CHANGED" = "1" ]; then
    mkdir -p "$APP_DIR/data"
    systemctl --user daemon-reload
    echo "==> 已更新服务单元（WorkingDirectory / DATA_DIR）"
  fi
fi

# 5) 启动服务
systemctl --user start stkj.service
sleep 3

if systemctl --user is-active --quiet stkj.service; then
  echo "==> 服务已启动"
else
  echo "✗ 服务启动失败，最近日志："
  tail -20 "$APP_DIR/logs/app.log" 2>/dev/null || true
  echo "  可回滚：systemctl --user stop stkj && tar -xzf ~/apps/backups/code-$STAMP.tar.gz -C $APP_DIR && systemctl --user start stkj"
  exit 1
fi

curl -s -o /dev/null -w "==> 本机访问 http://127.0.0.1:$PORT/ → HTTP %{http_code}\n" \
  "http://127.0.0.1:$PORT/" || true
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "==> 完成。局域网访问: http://${IP:-127.0.0.1}:$PORT"
echo "    回滚方式: systemctl --user stop stkj && tar -xzf ~/apps/backups/code-$STAMP.tar.gz -C $APP_DIR && systemctl --user start stkj"
