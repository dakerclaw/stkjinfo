#!/usr/bin/env bash
# ============================================================
# stkj 卸载脚本（在 Debian 服务器上执行）
#
# 作用：停止并移除 systemd 服务与备份定时器，可选删除代码与数据库。
#       默认「保留数据」——只摘服务，不碰 ~/apps/stkj。
#
# 用法：
#   bash uninstall.sh                # 仅移除服务与定时器，保留代码和数据
#   bash uninstall.sh --purge         # 额外删除代码目录（先自动备份数据库）
#   bash uninstall.sh --purge-all     # 删除代码 + 数据 + 日志（不可恢复！）
#   bash uninstall.sh --dry-run       # 只打印将要执行的操作，不做任何修改
#
# 说明：
#   - 本脚本不删除 Node.js 运行时（~/apps/node-*），如需一并清理请手动删除
#   - --purge / --purge-all 会先把 data/app.db 备份到 ~/apps/stkj-uninstall-backup-<时间戳>/
#   - 若开启了 linger，会提示是否关闭（不自动关闭，避免影响其他 user 服务）
# ============================================================
set -euo pipefail

APP_DIR="${STKJ_APP_DIR:-$HOME/apps/stkj}"
UNIT_DIR="$HOME/.config/systemd/user"
PURGE=0
PURGE_ALL=0
DRY=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --purge-all) PURGE=1; PURGE_ALL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$arg（用 --help 查看用法）"; exit 1 ;;
  esac
done

run() {
  if [ "$DRY" = "1" ]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    eval "$@"
  fi
}

echo "==> 应用目录 : $APP_DIR"
echo "==> 模式     : $([ "$PURGE_ALL" = "1" ] && echo '彻底删除（代码+数据）' || { [ "$PURGE" = "1" ] && echo '删除代码（保留备份）' || echo '仅移除服务（保留数据）'; })"
[ "$DRY" = "1" ] && echo "==> dry-run：不会真正修改任何文件"

# ------------------------------------------------------------ 1. 停止并禁用
echo
echo "==> [1/4] 停止并禁用服务"
run "systemctl --user stop stkj-backup.timer 2>/dev/null || true"
run "systemctl --user stop stkj-backup.service 2>/dev/null || true"
run "systemctl --user stop stkj.service 2>/dev/null || true"
run "systemctl --user disable stkj-backup.timer 2>/dev/null || true"
run "systemctl --user disable stkj.service 2>/dev/null || true"

# ------------------------------------------------------------ 2. 移除单元文件
echo
echo "==> [2/4] 移除 systemd 单元文件"
for f in stkj.service stkj-backup.service stkj-backup.timer; do
  if [ -f "$UNIT_DIR/$f" ]; then
    run "rm -f '$UNIT_DIR/$f'"
  else
    echo "  - $f 不存在，跳过"
  fi
done
run "systemctl --user daemon-reload 2>/dev/null || true"
run "systemctl --user reset-failed 2>/dev/null || true"

# ------------------------------------------------------------ 3. 数据处理
echo
echo "==> [3/4] 数据处理"
DB="$APP_DIR/data/app.db"
if [ "$PURGE" = "0" ]; then
  echo "  - 保留 $APP_DIR（含数据库与日志）"
  echo "  - 重新安装时直接指向该目录即可继续使用原有数据"
elif [ "$PURGE" = "1" ]; then
  if [ -f "$DB" ]; then
    STAMP=$(date +%Y%m%d-%H%M%S)
    BK="$HOME/apps/stkj-uninstall-backup-$STAMP"
    echo "  - 先备份数据库到 $BK"
    run "mkdir -p '$BK'"
    run "cp -a '$APP_DIR/data' '$BK/'"
    if [ -d "$APP_DIR/backups" ] && [ -n "$(ls -A "$APP_DIR/backups" 2>/dev/null)" ]; then
      run "mkdir -p '$BK/backups'"
      run "cp -a '$APP_DIR/backups/.' '$BK/backups/'"
    fi
    echo "  - 备份完成：$BK"
  else
    echo "  - 未找到数据库，跳过备份"
  fi
  if [ "$PURGE_ALL" = "1" ]; then
    echo "  - 删除整个代码目录（含数据与日志）：$APP_DIR"
    run "rm -rf '$APP_DIR'"
  else
    echo "  - 删除数据与日志，保留代码目录结构"
    run "rm -rf '$APP_DIR/data' '$APP_DIR/logs'"
  fi
fi

# ------------------------------------------------------------ 4. 检查残留
echo
echo "==> [4/4] 残留检查"
LEFT=$(systemctl --user list-units "stkj*" --all --no-pager --no-legend 2>/dev/null | wc -l)
echo "  - 仍存在的 stkj 单元：$LEFT 个"
[ "$LEFT" -gt 0 ] && systemctl --user list-units "stkj*" --all --no-pager --no-legend 2>/dev/null || true

LINGER=$(loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | cut -d= -f2)
if [ "$LINGER" = "yes" ]; then
  echo
  echo "  ! 当前账号仍开启 linger（开机后无需登录即启动 user 服务）"
  echo "    如不再需要，可手动关闭：sudo loginctl disable-linger $(id -un)"
fi

echo
if [ "$DRY" = "1" ]; then
  echo "==> dry-run 结束，未做任何修改"
else
  echo "==> 卸载完成（Node.js 运行时未删除：$(ls -d "$HOME"/apps/node-* 2>/dev/null || echo '无')）"
fi
