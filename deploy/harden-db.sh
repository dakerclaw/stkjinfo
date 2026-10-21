#!/usr/bin/env bash
# ============================================================
# 数据库加固与健康检查
#
# 作用：
#   1. 确认 db.js 已启用 synchronous=FULL / wal_autocheckpoint
#   2. 停服并对现有数据库做一次完整 CHECKPOINT，把 WAL 合并进主库
#   3. 输出容量与健康状况，然后重启服务
#
# 用法：
#   bash harden-db.sh                        # 使用默认路径
#   STKJ_APP_DIR=~/apps/stkj bash harden-db.sh
#   bash harden-db.sh --no-restart           # 只检查不停服
#
# 环境变量：
#   STKJ_APP_DIR  代码目录（默认 ~/apps/stkj）
#   STKJ_NODE     node 可执行文件（默认自动探测）
#   STKJ_PORT     服务端口（默认 5173）
# ============================================================
set -euo pipefail

APP_DIR="${STKJ_APP_DIR:-$HOME/apps/stkj}"
PORT="${STKJ_PORT:-5173}"
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
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

[ -d "$APP_DIR" ] || { echo "✗ 代码目录不存在：$APP_DIR（用 STKJ_APP_DIR 指定）"; exit 1; }
echo "==> 代码目录: $APP_DIR"
echo "==> Node    : $NODE ($("$NODE" -v))"

echo
echo "==> 1. 检查 db.js 关键配置"
grep -q "synchronous = FULL" "$APP_DIR/db.js" \
  && echo "   ✓ synchronous=FULL 已启用" \
  || echo "   ! 未启用 synchronous=FULL，请先更新代码"
grep -q "wal_autocheckpoint" "$APP_DIR/db.js" \
  && echo "   ✓ wal_autocheckpoint 已配置" \
  || echo "   ! 未配置 wal_autocheckpoint"

echo
echo "==> 2. WAL 状态（checkpoint 前）"
ls -lh "$APP_DIR/data/" 2>/dev/null | grep -E "app\.db" || echo "   ! 未找到数据库文件"

if [ "$RESTART" = "1" ]; then
  echo
  echo "==> 3. 停服并做一次完整 CHECKPOINT"
  systemctl --user stop stkj.service 2>/dev/null || true
  sleep 1
else
  echo
  echo "==> 3. 跳过停服（--no-restart），直接只读检查"
fi

cd "$APP_DIR"
if [ "$RESTART" = "1" ]; then
  "$NODE" --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("data/app.db");
  const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
  console.log("   checkpoint 结果:", JSON.stringify(r));
  console.log("   完整性检查     :", db.prepare("PRAGMA integrity_check").get().integrity_check);
  console.log("   projects       :", db.prepare("SELECT COUNT(*) c FROM projects").get().c);
  console.log("   project_data   :", db.prepare("SELECT COUNT(*) c FROM project_data").get().c);
  console.log("   users          :", db.prepare("SELECT COUNT(*) c FROM users").get().c);
  console.log("   sessions       :", db.prepare("SELECT COUNT(*) c FROM sessions").get().c);
  db.close();
  '
else
  "$NODE" --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("data/app.db", { readOnly: true });
  console.log("   完整性检查     :", db.prepare("PRAGMA integrity_check").get().integrity_check);
  console.log("   projects       :", db.prepare("SELECT COUNT(*) c FROM projects").get().c);
  console.log("   project_data   :", db.prepare("SELECT COUNT(*) c FROM project_data").get().c);
  console.log("   users          :", db.prepare("SELECT COUNT(*) c FROM users").get().c);
  db.close();
  '
fi

if [ "$RESTART" = "1" ]; then
  echo
  echo "==> 4. 文件状态（app.db-wal 应为 0 字节或不存在）"
  ls -lh "$APP_DIR/data/"

  echo
  echo "==> 5. 重启服务"
  systemctl --user start stkj.service
  sleep 3
  if systemctl --user is-active --quiet stkj.service; then
    curl -s -o /dev/null -w "   本机访问 http://127.0.0.1:$PORT/ → HTTP %{http_code}\n" "http://127.0.0.1:$PORT/" || true
  else
    echo "   ✗ 服务启动失败，最近日志："
    tail -20 "$APP_DIR/logs/app.log" 2>/dev/null || true
    exit 1
  fi
fi

echo
echo "==> 完成"
