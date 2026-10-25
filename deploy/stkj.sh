#!/usr/bin/env bash
# ============================================================
# stkj 一键脚本：安装 / 升级 / 卸载 / 查看状态
#
# 用法（普通用户执行，不要 sudo）：
#   bash stkj.sh install                 全新安装（已装过则自动修复/补装）
#   bash stkj.sh upgrade                 升级到 GitHub 最新代码
#   bash stkj.sh uninstall               卸载服务（保留代码与数据）
#   bash stkj.sh status                  查看运行状态与数据统计
#   bash stkj.sh help                    显示本帮助
#
# 常用参数：
#   --repo=<git 地址>     代码来源（默认用本脚本所在仓库的 origin）
#   --dir=<目录>          安装目录（默认 ~/apps/stkj）
#   --port=<端口>         监听端口（默认 5173）
#   --host=<地址>         监听地址（默认 0.0.0.0；127.0.0.1 表示仅本机）
#   --node-version=<v>    指定 Node 版本（默认 v22.23.3，仅安装时用）
#   --no-backup           不安装每日自动备份定时器
#   --with-linger         自动执行 sudo loginctl enable-linger（开机免登录自启）
#   --purge               卸载时删除代码与数据（先自动备份数据库）
#   --purge-all           卸载时删除整个安装目录（先自动备份数据库）
#   --yes / -y            卸载时不再询问确认
#   --dry-run             卸载时只打印将执行的操作
#
# 说明：
#   - 全程无需 root，Node.js 装在用户目录，服务是 systemd「用户服务」
#   - 数据库结构变更由 db.js 启动时自动迁移，升级不需要手动执行 SQL
#   - 脚本可重复执行，不会重复下载或覆盖数据
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DEFAULT_REPO="git@github.com:dakerclaw/stkjinfo.git"
DEFAULT_NODE_VER="v22.23.3"

APP_DIR="${STKJ_APP_DIR:-$HOME/apps/stkj}"
PORT="${STKJ_PORT:-5173}"
HOST="${STKJ_HOST:-0.0.0.0}"
NODE_VER=""
REPO=""
WITH_LINGER=0
WITH_BACKUP=1
PURGE=0
PURGE_ALL=0
YES=0
DRY=0
CMD=""

SERVICE="stkj.service"
BACKUP_SERVICE="stkj-backup.service"
BACKUP_TIMER="stkj-backup.timer"
UNIT_DIR="$HOME/.config/systemd/user"

CODE_DIR=""
CODE_PATH=""
NODE_BIN=""
NODE_DIR=""
NODE_ARCH=""

# ---------------------------------------------------------------- 输出
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  awk 'NR == 1 { next } /^set -euo pipefail/ { exit } /^#/ { sub(/^# ?/, ""); print }' \
    "${BASH_SOURCE[0]}" 2>/dev/null || true
  cat <<'EOF'

示例：
  # 全新服务器（先拿到代码，再一键安装）
  mkdir -p ~/apps && git clone git@github.com:dakerclaw/stkjinfo.git ~/apps/stkj
  bash ~/apps/stkj/deploy/stkj.sh install

  # 日常升级（服务器上执行这一条即可）
  bash ~/apps/stkj/deploy/stkj.sh upgrade

  # 卸载：默认保留数据；加 --purge 连代码数据一起删（先自动备份）
  bash ~/apps/stkj/deploy/stkj.sh uninstall
  bash ~/apps/stkj/deploy/stkj.sh uninstall --purge --yes
EOF
}

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|update|uninstall|remove|status|help)
      if [ -z "$CMD" ]; then CMD="$1"; fi
      shift
      ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --dir=*) APP_DIR="${1#*=}"; shift ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --node-version=*) NODE_VER="${1#*=}"; shift ;;
    --no-backup|--no-backup-timer) WITH_BACKUP=0; shift ;;
    --with-linger) WITH_LINGER=1; shift ;;
    --purge) PURGE=1; shift ;;
    --purge-all) PURGE=1; PURGE_ALL=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) CMD="help"; shift ;;
    *) die "未知参数：$1（执行 bash $0 help 查看用法）" ;;
  esac
done

[ -n "$CMD" ] || CMD="help"
[ "$CMD" = "update" ] && CMD="upgrade"
[ "$CMD" = "remove" ] && CMD="uninstall"

# ---------------------------------------------------------------- 公共
confirm() {
  [ "$YES" = "1" ] && return 0
  local ans=""
  printf '%s [y/N] ' "$1"
  read -r ans || true
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_user_env() {
  # su / cron 等场景不会带 XDG_RUNTIME_DIR，补上才能连到用户级 systemd
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
}

preflight() {
  [ "$(id -u)" -ne 0 ] || die "请不要用 root/sudo 运行（systemd 用户服务必须由普通用户管理）"
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME 目录不可用"
  ensure_user_env
  have git || die "缺少 git，请先执行：sudo apt update && sudo apt install -y git"
  have curl || die "缺少 curl，请先执行：sudo apt update && sudo apt install -y curl"
  have tar || die "缺少 tar，请先执行：sudo apt update && sudo apt install -y tar"
  have xz || die "缺少 xz，请先执行：sudo apt update && sudo apt install -y xz-utils"
  have systemctl || die "系统没有 systemd（Debian 12/13 默认自带）"
  systemctl --user show-environment >/dev/null 2>&1 ||
    die "systemctl --user 不可用：请用普通用户 SSH 登录后执行（不要用 su 或 sudo -i）"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) die "不支持的 CPU 架构：$(uname -m)（仅支持 x86_64 / arm64）" ;;
  esac
}

node_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

# 服务当前使用的 Node（升级时优先用它，保证语法检查与运行时一致）
node_from_service() {
  local line=""
  line="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null || true)"
  line="$(printf '%s' "$line" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n1)"
  if [ -n "$line" ] && [ -x "$line" ]; then
    NODE_BIN="$line"
    NODE_DIR="${line%/bin/node}"
    return 0
  fi
  return 1
}

# 选一个可用 Node：prefer_service=1 时先看服务在用的那个
pick_node() {
  local prefer_service="${1:-0}" cand
  local cands=()
  if [ "$prefer_service" = "1" ] && node_from_service; then return 0; fi
  mapfile -t cands < <(ls -1d "$HOME"/apps/node-*-linux-*/bin/node 2>/dev/null | sort -Vr || true)
  for cand in "${cands[@]}"; do
    if [ -x "$cand" ]; then
      NODE_BIN="$cand"
      NODE_DIR="${cand%/bin/node}"
      return 0
    fi
  done
  if [ "$prefer_service" = "0" ] && node_from_service; then return 0; fi
  if have node; then
    cand="$(command -v node)"
    if [ "$(node_major "$cand")" -ge 22 ] 2>/dev/null; then
      NODE_BIN="$cand"
      NODE_DIR="$(dirname "$(dirname "$cand")")"
      return 0
    fi
  fi
  return 1
}

ensure_node() {
  local ver="$1" tarball url fallback
  NODE_DIR="$HOME/apps/node-${ver}-linux-${NODE_ARCH}"
  NODE_BIN="$NODE_DIR/bin/node"
  if [ -x "$NODE_BIN" ]; then
    say "  已有 Node $("$NODE_BIN" -v)：$NODE_BIN"
    return 0
  fi
  mkdir -p "$HOME/apps"
  tarball="node-${ver}-linux-${NODE_ARCH}.tar.xz"
  url="https://npmmirror.com/mirrors/node/${ver}/${tarball}"
  fallback="https://nodejs.org/dist/${ver}/${tarball}"
  say "  下载 Node ${ver}（${NODE_ARCH}）..."
  if ! ( cd "$HOME/apps" && curl -fsSL --retry 3 -o "$tarball" "$url" ); then
    warn "镜像下载失败，改用官方源"
    ( cd "$HOME/apps" && curl -fsSL --retry 3 -o "$tarball" "$fallback" ) ||
      die "Node.js 下载失败，请检查网络后重试（也可用 --node-version= 指定其他版本）"
  fi
  tar -xf "$HOME/apps/$tarball" -C "$HOME/apps"
  rm -f "$HOME/apps/$tarball"
  [ -x "$NODE_BIN" ] || die "Node 解压后找不到 $NODE_BIN"
  say "  已安装 Node $("$NODE_BIN" -v) → $NODE_DIR"
}

# 代码来源：--repo 优先，其次本脚本所在仓库的 origin
resolve_repo() {
  if [ -n "$REPO" ]; then
    printf '%s' "$REPO"
    return 0
  fi
  if [ -d "$SCRIPT_DIR/../.git" ]; then
    local url=""
    url="$(git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null || true)"
    if [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
    printf '%s' "$SCRIPT_DIR/.."
    return 0
  fi
  printf ''
}

# 兼容两种代码布局：仓库根即代码，或代码在 stkjinfo/ 子目录
detect_layout() {
  if [ -f "$APP_DIR/server.js" ]; then
    CODE_DIR="$APP_DIR"
    CODE_PATH=""
  elif [ -f "$APP_DIR/stkjinfo/server.js" ]; then
    CODE_DIR="$APP_DIR/stkjinfo"
    CODE_PATH="/stkjinfo"
  else
    die "$APP_DIR 下找不到 server.js，代码不完整（可删除该目录后重新安装）"
  fi
}

write_units() {
  local src="$CODE_DIR/deploy"
  [ -f "$src/stkj.service" ] || die "找不到服务模板：$src/stkj.service"
  mkdir -p "$UNIT_DIR"
  sed -e "s|%h/apps/stkj/logs|$APP_DIR/logs|g" \
      -e "s|%h/apps/stkj|$APP_DIR|g" \
      -e "s|%h/apps/node|$NODE_DIR|g" \
      -e "s|%code_path%|$CODE_PATH|g" \
      -e "s|Environment=PORT=5173|Environment=PORT=$PORT|" \
      -e "s|Environment=HOST=0.0.0.0|Environment=HOST=$HOST|" \
      "$src/stkj.service" > "$UNIT_DIR/$SERVICE"
  if [ "$WITH_BACKUP" = "1" ] && [ -f "$src/stkj-backup.service" ]; then
    sed -e "s|%h/apps/stkj/logs|$APP_DIR/logs|g" \
        -e "s|%h/apps/stkj|$APP_DIR|g" \
        -e "s|%h/apps/node|$NODE_DIR|g" \
        -e "s|%code_path%|$CODE_PATH|g" \
        "$src/stkj-backup.service" > "$UNIT_DIR/$BACKUP_SERVICE"
    cp "$src/stkj-backup.timer" "$UNIT_DIR/$BACKUP_TIMER"
  else
    rm -f "$UNIT_DIR/$BACKUP_SERVICE" "$UNIT_DIR/$BACKUP_TIMER"
  fi
}

http_code() {
  local port="${1:-$PORT}" code=""
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

latest_backup() {
  local f=""
  f="$(ls -1t "$APP_DIR"/backups/app-*.db 2>/dev/null | head -n1 || true)"
  printf '%s' "${f:-无}"
}

counts_line() {
  [ -f "$APP_DIR/data/app.db" ] || { printf '无数据库'; return 0; }
  "$NODE_BIN" --no-warnings -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const p = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
    const d = db.prepare('SELECT COUNT(*) c FROM project_data').get().c;
    const u = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log('项目 ' + p + ' 个 / 数据 ' + d + ' 条 / 账号 ' + u + ' 个');
    db.close();" "$APP_DIR/data/app.db" 2>/dev/null || printf '读取失败'
}

# 卸载用：可 dry-run 的命令
do_cmd() {
  if [ "$DRY" = "1" ]; then
    say "  [dry-run] $*"
    return 0
  fi
  say "  + $*"
  "$@" >/dev/null 2>&1 || true
}

do_rm() {
  if [ "$DRY" = "1" ]; then
    say "  [dry-run] rm -rf $*"
    return 0
  fi
  say "  + rm -rf $*"
  rm -rf -- "$@"
}

# ---------------------------------------------------------------- install
cmd_install() {
  preflight
  detect_arch

  say ""
  say "============================================"
  say " stkj 安装"
  say "   安装目录：$APP_DIR"
  say "   监听地址：$HOST:$PORT"
  say "============================================"

  step "[1/6] 准备 Node.js"
  if [ -n "$NODE_VER" ]; then
    ensure_node "$NODE_VER"
  elif pick_node 0; then
    say "  使用已有 Node $("$NODE_BIN" -v)：$NODE_BIN"
  else
    ensure_node "$DEFAULT_NODE_VER"
  fi
  [ "$(node_major "$NODE_BIN")" -ge 22 ] 2>/dev/null ||
    die "Node 版本过低（$("$NODE_BIN" -v)），需要 ≥ v22.13（node:sqlite）"

  step "[2/6] 准备代码"
  local src_repo=""
  src_repo="$(resolve_repo)"
  [ -n "$src_repo" ] ||
    die "找不到代码来源：请在仓库目录内运行本脚本，或加 --repo=$DEFAULT_REPO"
  mkdir -p "$APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    say "  目录已有代码，执行 git pull --ff-only"
    git -C "$APP_DIR" pull --ff-only || warn "拉取失败，继续使用现有代码"
  elif [ -f "$APP_DIR/server.js" ] || [ -f "$APP_DIR/stkjinfo/server.js" ]; then
    say "  目录已有代码（非 git 仓库），跳过拉取"
  else
    say "  从 $src_repo 克隆代码"
    git clone "$src_repo" "$APP_DIR" || die "克隆失败：请确认仓库地址与 SSH 权限（$src_repo）"
  fi
  detect_layout
  say "  代码目录：$CODE_DIR"

  step "[3/6] 准备数据目录"
  mkdir -p "$APP_DIR/data" "$APP_DIR/backups" "$APP_DIR/logs"
  chmod 700 "$APP_DIR/data" "$APP_DIR/backups"
  chmod 750 "$APP_DIR/logs"
  say "  data/ backups/ logs/ 就绪（数据目录权限 700）"

  step "[4/6] 初始化数据库"
  if [ -s "$APP_DIR/data/app.db" ]; then
    say "  已存在数据库，保留现有数据（不会覆盖）"
    say "  现有数据：$(counts_line)"
  else
    ( cd "$CODE_DIR" && DATA_DIR="$APP_DIR/data" "$NODE_BIN" --no-warnings seed.js ) ||
      die "初始化数据库失败，请检查上面的报错"
    say "  已初始化数据库（含默认管理员与示例数据）"
  fi

  step "[5/6] 安装并启动服务"
  write_units
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE"
  # 用 restart 而不是 start：改过端口/Node 版本时也能立即生效
  systemctl --user restart "$SERVICE"
  if [ "$WITH_BACKUP" = "1" ]; then
    systemctl --user enable --now "$BACKUP_TIMER"
    say "  已启用每日 03:00 自动备份"
  fi
  sleep 2
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    warn "服务未能启动，最近日志："
    tail -n 30 "$APP_DIR/logs/app.log" 2>/dev/null || true
    die "安装失败：服务启动异常（可用 journalctl --user -u $SERVICE -n 100 查看）"
  fi
  say "  服务已启动（$SERVICE）"

  step "[6/6] 自检"
  say "  本机访问：HTTP $(http_code)"

  local linger=""
  linger="$(loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | cut -d= -f2 || true)"
  if [ "$linger" != "yes" ]; then
    if [ "$WITH_LINGER" = "1" ]; then
      say "  开启 linger（开机免登录自启）..."
      sudo loginctl enable-linger "$(id -un)" || warn "开启失败，请手动执行：sudo loginctl enable-linger $(id -un)"
    else
      warn "未开启 linger：服务器重启后要等该用户登录才会拉起服务"
      say "    如需开机自启：sudo loginctl enable-linger $(id -un)"
      say "    或重跑安装：bash $CODE_DIR/deploy/stkj.sh install --with-linger"
    fi
  fi

  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  say ""
  say "============================================"
  say " 安装完成"
  say "   访问地址：http://${ip:-127.0.0.1}:$PORT"
  say "   默认账号：admin / admin123（登录后请立即改密码）"
  say "   查看状态：bash $CODE_DIR/deploy/stkj.sh status"
  say "   升级：    bash $CODE_DIR/deploy/stkj.sh upgrade"
  say "   卸载：    bash $CODE_DIR/deploy/stkj.sh uninstall"
  say "============================================"
}

# ---------------------------------------------------------------- upgrade
cmd_upgrade() {
  preflight
  [ -d "$APP_DIR" ] || die "找不到安装目录 $APP_DIR，请先安装：bash $0 install"
  [ -d "$APP_DIR/.git" ] ||
    die "$APP_DIR 不是 git 仓库，无法用 upgrade 升级；如需重装：bash $0 uninstall --purge 后重新 install"
  systemctl --user cat "$SERVICE" >/dev/null 2>&1 ||
    die "服务尚未安装，请先执行：bash $0 install"

  cd "$APP_DIR"
  detect_layout
  if [ -n "$NODE_VER" ]; then
    ensure_node "$NODE_VER"
  elif ! pick_node 1; then
    die "找不到可用的 Node.js（可在安装时用 --node-version= 指定）"
  fi

  say ""
  say "============================================"
  say " stkj 升级"
  say "   安装目录：$APP_DIR"
  say "   Node     ：$("$NODE_BIN" -v)（$NODE_BIN）"
  say "============================================"

  step "[1/5] 备份数据库"
  if [ -f "$APP_DIR/data/app.db" ]; then
    local bk_out=""
    if bk_out="$(DB_FILE="$APP_DIR/data/app.db" BACKUP_DIR="$APP_DIR/backups" \
      "$NODE_BIN" --no-warnings "$CODE_DIR/deploy/backup.cjs" 2>&1)"; then
      say "  已备份：$(latest_backup)"
    else
      warn "备份失败，继续升级（请自行确认 data/app.db 可读）"
      say "    $bk_out"
    fi
  else
    say "  没有数据库，跳过备份"
  fi

  step "[2/5] 拉取最新代码"
  local before="" after="" branch="" changed="" stashed=0
  before="$(git rev-parse --short HEAD)"
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
  say "  当前版本：$before $(git log -1 --pretty=%s)"
  if [ -n "$(git status --porcelain)" ]; then
    say "  检测到本地改动，先 git stash 收起"
    git stash push -u -m "stkj 升级前自动收起 $(date +%F-%H%M%S)" >/dev/null
    stashed=1
  fi
  local pull_log=""
  pull_log="$(mktemp)"
  if git pull --ff-only origin "$branch" >"$pull_log" 2>&1; then
    sed 's/^/  /' "$pull_log"
    rm -f "$pull_log"
  else
    cat "$pull_log"
    rm -f "$pull_log"
    die "拉取失败：本地与远程可能分叉，请按 README「升级失败怎么办」处理后重试"
  fi
  after="$(git rev-parse --short HEAD)"
  changed="$(git diff --name-only "$before" "$after" 2>/dev/null || true)"
  say "  最新版本：$after $(git log -1 --pretty=%s)"

  step "[3/5] 语法检查"
  local f=""
  for f in server.js db.js xlsx.js import-map.js seed.js; do
    if [ -f "$f" ]; then "$NODE_BIN" --check "$f"; fi
  done
  say "  通过"

  step "[4/5] 应用变更"
  local need_restart=0 cf=""
  for cf in $changed; do
    case "$cf" in
      public/*) ;;                 # 纯前端静态文件，浏览器刷新即可
      *.md|README*|deploy/*) ;;    # 文档与部署脚本，不影响运行
      *) need_restart=1 ;;
    esac
  done
  if [ "$before" = "$after" ]; then
    say "  已是最新版本，无需重启"
  elif [ "$need_restart" = "1" ]; then
    say "  后端代码有变化，重启服务"
    systemctl --user restart "$SERVICE"
    sleep 2
    if ! systemctl --user is-active --quiet "$SERVICE"; then
      warn "服务启动失败，最近日志："
      tail -n 40 "$APP_DIR/logs/app.log" 2>/dev/null || true
      die "升级失败，可回滚：git reset --hard $before && systemctl --user restart $SERVICE"
    fi
    say "  服务已重启"
  else
    say "  只有前端静态文件变化，无需重启（浏览器 Ctrl+F5 刷新即可）"
  fi

  step "[5/5] 自检"
  say "  服务状态：$(systemctl --user is-active "$SERVICE" 2>/dev/null || echo unknown)"
  say "  首页访问：HTTP $(http_code)"
  if [ -f "$APP_DIR/data/app.db" ]; then
    say "  数据统计：$(counts_line)"
  fi

  say ""
  say "============================================"
  if [ "$before" = "$after" ]; then
    say " 升级完成：已是最新版本（$after）"
  else
    say " 升级完成：$before → $after"
  fi
  say "   备份文件：$(latest_backup)"
  if [ "$stashed" = "1" ]; then
    say "   本地改动已收进 git stash（git stash list 查看，不需要可 git stash drop）"
  fi
  say "============================================"
}

# ---------------------------------------------------------------- uninstall
cmd_uninstall() {
  [ "$(id -u)" -ne 0 ] || die "请不要用 root/sudo 运行"
  have systemctl || die "系统没有 systemd"
  ensure_user_env

  local mode="仅移除服务（保留代码与数据）"
  if [ "$PURGE_ALL" = "1" ]; then
    mode="删除服务 + 整个安装目录（先自动备份数据库）"
  elif [ "$PURGE" = "1" ]; then
    mode="删除服务 + 代码数据（先自动备份数据库）"
  fi

  say ""
  say "============================================"
  say " stkj 卸载"
  say "   安装目录：$APP_DIR"
  say "   方式    ：$mode"
  [ "$DRY" = "1" ] && say "   dry-run ：只打印，不修改任何文件"
  say "============================================"

  if [ "$PURGE" = "1" ] && [ "$DRY" = "0" ]; then
    confirm "确认删除 $APP_DIR 下的代码与数据？" || die "已取消（未做任何修改）"
  fi

  step "[1/4] 停止服务"
  do_cmd systemctl --user stop "$BACKUP_TIMER"
  do_cmd systemctl --user stop "$BACKUP_SERVICE"
  do_cmd systemctl --user stop "$SERVICE"
  do_cmd systemctl --user disable "$BACKUP_TIMER"
  do_cmd systemctl --user disable "$SERVICE"

  step "[2/4] 移除 systemd 单元"
  local f=""
  for f in "$SERVICE" "$BACKUP_SERVICE" "$BACKUP_TIMER"; do
    if [ -f "$UNIT_DIR/$f" ]; then
      do_rm "$UNIT_DIR/$f"
    else
      say "  - $f 不存在，跳过"
    fi
  done
  do_cmd systemctl --user daemon-reload
  do_cmd systemctl --user reset-failed

  step "[3/4] 处理文件与数据"
  if [ "$PURGE" = "0" ]; then
    say "  - 保留 $APP_DIR（代码、数据库、日志都在）"
    say "  - 想彻底删除请加 --purge"
  else
    if [ -f "$APP_DIR/data/app.db" ]; then
      local stamp="" bk=""
      stamp="$(date +%Y%m%d-%H%M%S)"
      bk="$HOME/apps/stkj-uninstall-backup-$stamp"
      say "  先备份数据库到 $bk"
      if [ "$DRY" = "1" ]; then
        say "  [dry-run] mkdir -p $bk && cp -a $APP_DIR/data $bk/"
      else
        mkdir -p "$bk"
        cp -a "$APP_DIR/data" "$bk/"
        if [ -d "$APP_DIR/backups" ] && [ -n "$(ls -A "$APP_DIR/backups" 2>/dev/null || true)" ]; then
          mkdir -p "$bk/backups"
          cp -a "$APP_DIR/backups/." "$bk/backups/"
        fi
        say "  备份完成：$bk"
      fi
    else
      say "  未找到数据库，跳过备份"
    fi
    if [ "$PURGE_ALL" = "1" ]; then
      do_rm "$APP_DIR"
    else
      do_rm "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/backups"
    fi
  fi

  step "[4/4] 检查残留"
  local left=""
  left="$(systemctl --user list-units "stkj*" --all --no-pager --no-legend 2>/dev/null | wc -l || true)"
  say "  仍存在的 stkj 单元：${left:-0} 个"
  local linger=""
  linger="$(loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | cut -d= -f2 || true)"
  if [ "$linger" = "yes" ]; then
    warn "当前账号仍开启 linger（开机后无需登录即启动用户服务）"
    say "    如不再需要：sudo loginctl disable-linger $(id -un)"
  fi

  say ""
  if [ "$DRY" = "1" ]; then
    say "==> dry-run 结束，未做任何修改"
  else
    say "==> 卸载完成"
    say "    Node.js 运行时未删除：$(ls -d "$HOME"/apps/node-* 2>/dev/null | tr '\n' ' ' || echo '无')"
    say "    如确认不再使用，可手动删除：rm -rf ~/apps/node-*"
  fi
}

# ---------------------------------------------------------------- status
cmd_status() {
  ensure_user_env
  say ""
  say "stkj 状态"
  say "  安装目录：$APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    say "  代码版本：$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?') $(git -C "$APP_DIR" log -1 --pretty=%s 2>/dev/null || true)"
  fi
  say "  服务状态：$(systemctl --user is-active "$SERVICE" 2>/dev/null || echo '未安装/未运行')"
  say "  开机自启：$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || echo '未启用')"

  local port=""
  port="$(systemctl --user show "$SERVICE" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -n1 || true)"
  [ -n "$port" ] || port="$PORT"
  say "  监听端口：$port"
  say "  首页访问：HTTP $(http_code "$port")"

  if [ -f "$APP_DIR/data/app.db" ]; then
    if pick_node 1 || pick_node 0; then
      say "  数据统计：$(counts_line)"
    fi
  else
    say "  数据统计：未找到 data/app.db"
  fi
  say "  最近备份：$(latest_backup)"
  say "  备份数量：$(ls -1 "$APP_DIR"/backups/app-*.db 2>/dev/null | wc -l) 份"
  say "  磁盘占用：$(du -sh "$APP_DIR" 2>/dev/null | awk '{print $1}' || echo '?')"
  say ""
  say "  升级：bash $APP_DIR/deploy/stkj.sh upgrade"
  say "  卸载：bash $APP_DIR/deploy/stkj.sh uninstall"
}

# ---------------------------------------------------------------- 入口
case "$CMD" in
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  help) usage ;;
  *) die "未知命令：$CMD（执行 bash $0 help 查看用法）" ;;
esac
