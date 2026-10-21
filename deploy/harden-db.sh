#!/usr/bin/env bash
# ============================================================
# 数据安全加固脚本（在 mac mini 上执行一次即可）
# 作用：
#   1. 确认 db.js 已启用 synchronous=FULL / wal_autocheckpoint
#   2. 对现有数据库做一次 CHECKPOINT，把 WAL 内容合并进主库
#   3. 报告数据库健康状况
# 用法：bash harden-db.sh
# ============================================================
set -euo pipefail

APP_DIR="$HOME/apps/stkj"
NODE="$HOME/apps/node-v22.22.2-linux-x64/bin/node"

echo "==> 1. 检查 db.js 关键配置"
grep -q "synchronous = FULL" "$APP_DIR/db.js" \
  && echo "   ✓ synchronous=FULL 已启用" \
  || echo "   ! 未启用 synchronous=FULL，请先跑 apply-update.sh"
grep -q "wal_autocheckpoint" "$APP_DIR/db.js" \
  && echo "   ✓ wal_autocheckpoint 已配置" \
  || echo "   ! 未配置 wal_autocheckpoint"

echo "==> 2. 停服并做一次完整 CHECKPOINT"
systemctl --user stop stkj.service 2>/dev/null || true
sleep 1

cd "$APP_DIR"
"$NODE" --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/app.db");
const before = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
console.log("   checkpoint 结果:", JSON.stringify(before));
console.log("   projects     :", db.prepare("SELECT COUNT(*) c FROM projects").get().c);
console.log("   project_data :", db.prepare("SELECT COUNT(*) c FROM project_data").get().c);
console.log("   users        :", db.prepare("SELECT COUNT(*) c FROM users").get().c);
db.close();
'

echo "==> 3. 文件状态（app.db-wal 应为 0 字节或不存在）"
ls -lh "$APP_DIR/data/"

echo "==> 4. 重启服务"
systemctl --user start stkj.service
sleep 3
systemctl --user is-active stkj.service
curl -s -o /dev/null -w "   本机访问: HTTP %{http_code}\n" http://127.0.0.1:5173/
echo "==> 完成"
