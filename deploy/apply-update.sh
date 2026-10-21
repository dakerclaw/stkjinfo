#!/usr/bin/env bash
# ============================================================
# stkj 更新脚本（在 mac mini 上执行）
# 作用：把 stkj-update.tar.gz 里的最新代码铺到 ~/apps/stkj，
#       并重启服务。保留 data/ 数据库不动。
# 用法：
#   1. 把 stkj-update.tar.gz 上传到 ~ （或任意目录）
#   2. bash apply-update.sh
# ============================================================
set -euo pipefail

APP_DIR="$HOME/apps/stkj"
NODE="$HOME/apps/node-v22.22.2-linux-x64/bin/node"
PKG="${1:-$HOME/stkj-update.tar.gz}"

echo "==> 应用目录: $APP_DIR"
echo "==> 更新包  : $PKG"
[ -f "$PKG" ] || { echo "✗ 找不到更新包 $PKG"; exit 1; }
[ -x "$NODE" ] || { echo "✗ 找不到 Node: $NODE"; exit 1; }

# 1) 备份当前代码（不含 data/）
cd "$APP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$HOME/apps/backups"
tar -czf "$HOME/apps/backups/code-$STAMP.tar.gz" \
    --exclude=data --exclude=logs --exclude='*.bak*' . 2>/dev/null || true
echo "==> 已备份当前代码: ~/apps/backups/code-$STAMP.tar.gz"

# 2) 停止服务
systemctl --user stop stkj.service 2>/dev/null || true
sleep 1

# 3) 解包覆盖（不碰 data/ 与 logs/）
tar -xzf "$PKG" -C "$APP_DIR"
echo "==> 代码已更新"

# 4) 语法自检
"$NODE" --check server.js
"$NODE" --check db.js
"$NODE" --check seed.js
echo "==> 语法检查通过"

# 5) 启动服务
systemctl --user start stkj.service
sleep 3

if systemctl --user is-active --quiet stkj.service; then
    echo "==> 服务已启动"
else
    echo "✗ 服务启动失败，最近日志："
    tail -20 "$APP_DIR/logs/app.log" 2>/dev/null || true
    exit 1
fi

curl -s -o /dev/null -w "==> 本机访问: HTTP %{http_code}\n" http://127.0.0.1:5173/
echo "==> 完成。局域网访问: http://$(hostname -I | awk '{print $1}'):5173"
