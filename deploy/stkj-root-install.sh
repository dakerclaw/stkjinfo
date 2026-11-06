#!/usr/bin/env bash
# ============================================================
# stkj root 一键安装（Debian 13 / Ubuntu 24.04+ 适用）
#
# 用法（root 执行）：
#   bash stkj-root-install.sh                 # 全新安装（创建运行用户 + 应用）
#   bash stkj-root-install.sh --user=xxx      # 指定运行用户（默认 stkj）
#   bash stkj-root-install.sh --port=5173     # 应用监听端口（默认 5173）
#   bash stkj-root-install.sh --no-seed       # 不初始化演示账号
#
# 行为：
#   1. apt 安装 curl/tar/xz/coreutils（缺啥装啥）
#   2. 创建运行用户（若不存在）并 enable-linger（开机自启）
#   3. 以该用户身份执行官方 install 脚本（Node/代码/数据库/用户服务全自动），
#      应用监听 0.0.0.0:<端口>
#   4. 可选：seed 初始化演示账号（admin/admin123）
#   5. 自检首页 HTTP 200
#
# 访问方式：安装后通过 http://<服务器IP>:<端口>/ 访问。
# 本项目不配置域名、证书或反向代理；应用不带 HTTPS，仅建议在受信任网络使用。
#
# 幂等：重复执行安全；已有数据不会被覆盖。
# ============================================================
set -euo pipefail

RUN_USER="stkj"
APP_PORT="5173"
SEED=1
APP_DIR_BASE="apps/stkj"          # 相对运行用户 HOME
NODE_BIN_REL="apps/node/bin/node"

C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_OFF='\033[0m'
say()  { printf '%b\n' "${C_GREEN}==> $*${C_OFF}"; }
warn() { printf '%b\n' "${C_YELLOW}警告：$*${C_OFF}"; }
die()  { printf '%b\n' "${C_RED}错误：$*${C_OFF}" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --user=*)     RUN_USER="${arg#*=}" ;;
    --port=*)     APP_PORT="${arg#*=}" ;;
    --no-seed)    SEED=0 ;;
    --help|-h)    sed -n '2,26p' "$0"; exit 0 ;;
    *) die "未知参数：$arg（--help 查看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"

# ------------------------------------------------------------
say "[1/5] 系统依赖"
# ------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
NEED=""
for p in curl tar xz sha256sum; do command -v "$p" >/dev/null 2>&1 || NEED="$NEED coreutils"; done
command -v curl >/dev/null 2>&1 || NEED="$NEED curl"
command -v xz   >/dev/null 2>&1 || NEED="$NEED xz-utils"
if [ -n "${NEED// /}" ]; then
  say "  apt 安装：$NEED"
  apt-get update -qq
  apt-get install -y -qq $NEED
else
  say "  依赖齐备"
fi

# ------------------------------------------------------------
say "[2/5] 运行用户：$RUN_USER"
# ------------------------------------------------------------
if id "$RUN_USER" >/dev/null 2>&1; then
  say "  用户已存在"
else
  useradd -m -s /bin/bash "$RUN_USER"
  say "  已创建用户 $RUN_USER"
fi
# linger：开机免登录自启用户服务
if [ "$(loginctl show-user "$RUN_USER" --property=Linger --value 2>/dev/null)" = "yes" ]; then
  say "  linger 已开启"
else
  loginctl enable-linger "$RUN_USER" && say "  已开启 linger（重启后服务自动拉起）"
fi

USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
APP_DIR="$USER_HOME/$APP_DIR_BASE"

# ------------------------------------------------------------
say "[3/5] 以 $RUN_USER 身份安装应用"
# ------------------------------------------------------------
# 监听 0.0.0.0，安装后即可通过 http://<服务器IP>:<端口>/ 直接访问
if [ -f "$APP_DIR/deploy/stkj.sh" ]; then
  say "  已有安装，沿用现有代码与数据（幂等）"
  su - "$RUN_USER" -c "bash '$APP_DIR/deploy/stkj.sh' install --port=$APP_PORT --host=0.0.0.0" || true
else
  say "  全新安装（官方脚本：Node v22 + 代码 + 数据库 + 用户服务）"
  su - "$RUN_USER" -c "curl -fsSL https://raw.githubusercontent.com/dakerclaw/stkjinfo/main/deploy/stkj.sh | bash -s -- install --port=$APP_PORT --host=0.0.0.0"
fi

# 官方脚本装完后再确保服务在跑
su - "$RUN_USER" -c "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user enable --now stkj.service" 2>/dev/null || true
su - "$RUN_USER" -c "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user is-active stkj.service" | grep -q active ||
  die "stkj 服务未起来，请查看：journalctl --user -u stkj（用 $RUN_USER 登录）"
say "  服务 active：http://0.0.0.0:$APP_PORT"

# ------------------------------------------------------------
say "[4/5] 账号初始化"
# ------------------------------------------------------------
DB_FILE="$APP_DIR/data/app.db"
if [ -f "$DB_FILE" ] && [ "$(stat -c%s "$DB_FILE")" -gt 5000 ]; then
  say "  数据库已存在，跳过 seed（不覆盖已有数据）"
elif [ "$SEED" = 1 ]; then
  su - "$RUN_USER" -c "cd '$APP_DIR' && '$USER_HOME/$NODE_BIN_REL' --no-warnings seed.js"
  say "  已初始化：admin/admin123（登录后请立即在左下角菜单修改密码）"
else
  warn "  跳过 seed：数据库为空，将无法登录，可手动执行 su - $RUN_USER -c \"cd $APP_DIR && ~/apps/node/bin/node seed.js\""
fi

# ------------------------------------------------------------
say "[5/5] 自检"
# ------------------------------------------------------------
sleep 1
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$APP_PORT/" || true)
say "  首页：http://127.0.0.1:$APP_PORT/ -> $HOME_CODE"
[ "$HOME_CODE" = "200" ] || warn "  首页自检未返回 200，请检查服务日志：su - $RUN_USER -c 'journalctl --user -u stkj -n 50'"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

say ""
say "============================================"
say " 安装完成"
say "   运行用户：$RUN_USER（linger 已开）"
say "   应用目录：$APP_DIR"
say "   服务管理：su - $RUN_USER -c 'bash ~/apps/stkj/deploy/stkj.sh status'"
say "   升级：    su - $RUN_USER -c 'bash ~/apps/stkj/deploy/stkj.sh upgrade'"
say "   访问：    http://<服务器IP>:$APP_PORT/"
[ -n "$SERVER_IP" ] && say "   例如：    http://$SERVER_IP:$APP_PORT/"
say "   默认账号：admin / admin123（登录后立即修改密码，入口在左下角）"
say "   提示：    本项目不配置域名与 HTTPS；外网暴露请自行限制来源或做加固"
say "============================================"
