#!/usr/bin/env bash
# ============================================================
# stkj 一键脚本：安装 / 升级 / 卸载 / 查看状态
#
# 用法（普通用户执行，不要 sudo）：
#   curl -fsSL https://raw.githubusercontent.com/dakerclaw/stkjinfo/main/deploy/stkj.sh | bash -s -- install
#   bash ~/apps/stkj/deploy/stkj.sh upgrade      # 升级到最新代码
#   bash ~/apps/stkj/deploy/stkj.sh uninstall    # 卸载服务（保留代码与数据）
#   bash ~/apps/stkj/deploy/stkj.sh status       # 查看运行状态与数据统计
#   bash ~/apps/stkj/deploy/stkj.sh help         # 显示本帮助
#
# 常用参数：
#   --repo=<地址>         代码来源：tar.gz 下载地址，或 git 地址（git 地址需要 git）
#                         默认从 GitHub 下载 tar.gz，服务器上不需要安装 git
#   --branch=<分支>       默认 main
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
#   - 安装与升级默认用 curl 下载代码包，不要求服务器装 git
#   - 数据库结构变更由 db.js 启动时自动迁移，升级不需要手动执行 SQL
#   - 脚本可重复执行，不会重复下载或覆盖数据
# ============================================================
set -euo pipefail

SELF="${BASH_SOURCE[0]:-$0}"
[ -f "$SELF" ] || SELF="$HOME/apps/stkj/deploy/stkj.sh"
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
fi

REPO_SLUG="dakerclaw/stkjinfo"
BRANCH="${STKJ_BRANCH:-main}"
DEFAULT_SOURCE="https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$BRANCH"
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

# 下载模式用到的临时目录与升级状态
WORK_TMP=""
REL_DIR=""
NEW_CODE_DIR=""
SOURCE_URL=""
OLD_VER=""
NEW_VER=""
OLD_TREE=""
NEW_TREE=""
CHANGED=""
SAME_TREE=0
NEED_RESTART=0
STASHED=0
CODE_PREV=""

cleanup_tmp() {
  if [ -n "$WORK_TMP" ] && [ -d "$WORK_TMP" ]; then rm -rf "$WORK_TMP"; fi
}
trap cleanup_tmp EXIT

# ---------------------------------------------------------------- 输出
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
# git 是可选依赖：存在且能正常运行才走 git 模式，否则用下载方式
have_git() { have git && git --version >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
stkj 一键脚本：安装 / 升级 / 卸载 / 查看状态

用法（普通用户执行，不要 sudo）：
  install     全新安装（已装过则自动修复/补装）
  upgrade     升级到 GitHub 最新代码
  uninstall   卸载服务（默认保留代码与数据）
  status      查看运行状态与数据统计
  help        显示本帮助

常用参数：
  --repo=<地址>         代码来源：tar.gz 下载地址，或 git 地址（git 地址需要 git）
                        默认从 GitHub 下载 tar.gz，服务器上不需要安装 git
  --branch=<分支>       默认 main
  --dir=<目录>          安装目录（默认 ~/apps/stkj）
  --port=<端口>         监听端口（默认 5173）
  --host=<地址>         监听地址（默认 0.0.0.0；127.0.0.1 表示仅本机）
  --node-version=<v>    指定 Node 版本（默认 v22.23.3，仅安装时用）
  --no-backup           不安装每日自动备份定时器
  --with-linger         自动执行 sudo loginctl enable-linger（开机免登录自启）
  --purge               卸载时删除代码与数据（先自动备份数据库）
  --purge-all           卸载时删除整个安装目录（先自动备份数据库）
  --yes / -y            卸载时不再询问确认
  --dry-run             卸载时只打印将执行的操作

示例：
  # 全新服务器（一条命令，不需要 git）
  curl -fsSL https://raw.githubusercontent.com/dakerclaw/stkjinfo/main/deploy/stkj.sh | bash -s -- install

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
    --branch=*)
      BRANCH="${1#*=}"
      DEFAULT_SOURCE="https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$BRANCH"
      shift
      ;;
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
    *) die "未知参数：$1（执行 bash $SELF help 查看用法）" ;;
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
  # 注意：不要求 git。安装与升级默认用 curl 下载代码包，git 只在沿用旧 git 部署时才需要
  have curl || die "缺少 curl，请先执行：sudo apt update && sudo apt install -y curl"
  have tar || die "缺少 tar，请先执行：sudo apt update && sudo apt install -y tar"
  have xz || die "缺少 xz，请先执行：sudo apt update && sudo apt install -y xz-utils"
  have sha256sum || die "缺少 sha256sum（coreutils），请先安装：sudo apt update && sudo apt install -y coreutils"
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

# ---------------------------------------------------------------- 代码来源
is_git_url() {
  case "$1" in
    git@*|ssh://*|git://*|*.git) return 0 ;;
    *) return 1 ;;
  esac
}

# 把 GitHub 的 git 地址转成 tar.gz 下载地址（服务器没装 git 时也能用）
git_url_to_tarball() {
  local u="$1" path=""
  case "$u" in
    git@github.com:*) path="${u#git@github.com:}" ;;
    ssh://git@github.com/*) path="${u#ssh://git@github.com/}" ;;
    https://github.com/*) path="${u#https://github.com/}" ;;
    *) return 1 ;;
  esac
  path="${path%.git}"
  path="${path%.tar.gz}"
  printf 'https://codeload.github.com/%s/tar.gz/refs/heads/%s' "$path" "$BRANCH"
}

# 代码来源：--repo 优先；其次本脚本所在仓库的 origin；最后默认 GitHub 下载地址
resolve_source() {
  if [ -n "$REPO" ]; then
    printf '%s' "$REPO"
    return 0
  fi
  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/../.git" ] && have_git; then
    local url=""
    url="$(git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null || true)"
    if [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
  fi
  printf '%s' "$DEFAULT_SOURCE"
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

# ---------------------------------------------------------------- 下载 / 应用代码
fetch_release() {  # $1=下载地址 $2=临时目录 → 设置 REL_DIR
  local source="$1" tmp="$2" tarball=""
  tarball="$tmp/release.tar.gz"
  say "  下载代码：$source"
  curl -fsSL --retry 3 --connect-timeout 15 -o "$tarball" "$source" ||
    die "下载失败：$source（请检查网络后重试）"
  [ -s "$tarball" ] || die "下载内容为空：$source"
  mkdir -p "$tmp/x"
  tar -xzf "$tarball" -C "$tmp/x" || die "解压失败：下载的文件可能不完整，请重试"
  REL_DIR="$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [ -n "$REL_DIR" ] || die "代码包里没有目录，请确认下载地址"
  [ -f "$REL_DIR/server.js" ] || die "代码不完整（缺 server.js），请确认下载地址"
}

# 记录代码文件的哈希清单，用于比较版本、判断变更、清理旧版本已删除的文件
manifest_of() {  # $1=目录 $2=输出文件
  # 统一成「哈希 + 两个空格 + 路径」，避免不同平台 sha256sum 输出 `*` 标记导致比较失效
  ( cd "$1" && find . -type f \
      ! -path './.git/*' ! -path './data/*' ! -path './backups/*' ! -path './logs/*' \
      ! -path './.stkj-prev*' ! -name '.stkj-manifest' ! -name '.stkj-release' \
      -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) \
    | sed 's/^\([0-9a-f]\{64\}\) [ *]/\1  /' > "$2"
}

tree_hash() { sha256sum "$1" | awk '{print $1}'; }

# GitHub 上最新提交号（拿不到时返回空，由调用方回退到文件树哈希）
remote_sha() {  # $1=来源地址
  local src="$1"
  case "$src" in
    *github.com/$REPO_SLUG*) ;;
    *) return 1 ;;
  esac
  curl -fsSL --max-time 8 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO_SLUG/commits/$BRANCH" 2>/dev/null |
    sed -n 's/^  "sha": "\([0-9a-f]\{40\}\)".*$/\1/p' | head -n1
}

write_release() {  # $1=版本 $2=文件树哈希 $3=来源
  printf 'version=%s\ntree=%s\nsource=%s\ndate=%s\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP_DIR/.stkj-release"
}

read_release() {  # $1=字段名
  [ -f "$APP_DIR/.stkj-release" ] || return 1
  sed -n "s/^$1=//p" "$APP_DIR/.stkj-release" | head -n1
}

# 两份清单之间变化的文件（每行一个相对路径）
changed_paths() {  # $1=旧清单 $2=新清单
  local old="$1" new="$2"
  if [ -f "$old" ]; then
    # diff 有差异时退出码为 1，不能让它触发 set -e
    diff "$old" "$new" 2>/dev/null | sed -n 's/^[<>] [0-9a-f]\{64\} [ *]//p' | sed 's|^\./||' | LC_ALL=C sort -u || true
  else
    awk '{print $2}' "$new" | sed 's|^\./||'
  fi
}

# 用新版本覆盖代码：先删掉新版本里已不存在的文件，再整体复制；data/backups/logs 不动
apply_release() {  # $1=新代码目录 $2=新清单 $3=旧清单
  local new="$1" newman="$2" oldman="${3:-}" rel=""
  local oldlist="$WORK_TMP/old-paths" newlist="$WORK_TMP/new-paths"
  : > "$oldlist"
  : > "$newlist"
  if [ -n "$oldman" ] && [ -f "$oldman" ]; then
    awk '{print $2}' "$oldman" | sed 's|^\./||' > "$oldlist"
  fi
  awk '{print $2}' "$newman" | sed 's|^\./||' > "$newlist"

  # 留一份旧代码到 backups/，重启失败时回滚用；只保留最近 3 份
  CODE_PREV=""
  if [ -s "$oldlist" ]; then
    mkdir -p "$APP_DIR/backups"
    CODE_PREV="$APP_DIR/backups/code-prev-$(date +%Y%m%d-%H%M%S).tar.gz"
    ( cd "$APP_DIR" && tar czf "$CODE_PREV" -T "$oldlist" ) 2>/dev/null || CODE_PREV=""
    ls -1t "$APP_DIR"/backups/code-prev-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f || true
  fi

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if ! grep -qxF -- "$rel" "$newlist"; then
      rm -f -- "$APP_DIR/$rel"
    fi
  done < "$oldlist"

  ( cd "$new" && tar cf - . ) | ( cd "$APP_DIR" && tar xf - )
  cp "$newman" "$APP_DIR/.stkj-manifest"
}

check_js() {  # $1=代码目录
  local dir="$1" f=""
  for f in server.js db.js xlsx.js import-map.js seed.js; do
    if [ -f "$dir/$f" ]; then "$NODE_BIN" --check "$dir/$f"; fi
  done
}

# ---------------------------------------------------------------- 服务单元 / 状态
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

backup_db() {
  if [ -f "$APP_DIR/data/app.db" ]; then
    local out=""
    if out="$(DB_FILE="$APP_DIR/data/app.db" BACKUP_DIR="$APP_DIR/backups" \
      "$NODE_BIN" --no-warnings "$CODE_DIR/deploy/backup.cjs" 2>&1)"; then
      say "  已备份：$(latest_backup)"
    else
      warn "备份失败，继续升级（请自行确认 data/app.db 可读）"
      say "    $out"
    fi
  else
    say "  没有数据库，跳过备份"
  fi
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
  local source="" version="" code_ready=0
  source="$(resolve_source)"
  [ -n "$source" ] || die "找不到代码来源，请加 --repo=<下载地址>"
  mkdir -p "$APP_DIR"

  if [ -d "$APP_DIR/.git" ] && have_git; then
    # 沿用旧的 git 部署：只 pull，不动用户工作区
    say "  目录已是 git 仓库，执行 git pull --ff-only"
    git -C "$APP_DIR" pull --ff-only || warn "拉取失败，继续使用现有代码"
    version="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    code_ready=1
  elif is_git_url "$source"; then
    if [ -f "$APP_DIR/server.js" ] || [ -f "$APP_DIR/stkjinfo/server.js" ]; then
      # 已有非 git 代码：把 GitHub 地址转成下载地址后覆盖
      if ! source="$(git_url_to_tarball "$source")"; then
        die "该来源是 git 地址，覆盖已有代码需要下载地址，请改用 --repo=<tar.gz 地址>"
      fi
      say "  已有代码不是 git 仓库，改用下载方式更新"
    elif have_git; then
      say "  从 $source 克隆代码"
      git clone "$source" "$APP_DIR" || die "克隆失败：请确认仓库地址与权限（$source）"
      version="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)"
      code_ready=1
    else
      # 没有 git：GitHub 地址直接转成 tar.gz 下载
      if ! source="$(git_url_to_tarball "$source")"; then
        die "该来源是 git 地址，但系统没有 git；请改用 tar.gz 下载地址"
      fi
      say "  系统没有 git，改用下载方式"
    fi
  fi

  if [ "$code_ready" = "0" ]; then
    WORK_TMP="$(mktemp -d)"
    fetch_release "$source" "$WORK_TMP"
    manifest_of "$REL_DIR" "$WORK_TMP/new-manifest"
    NEW_TREE="$(tree_hash "$WORK_TMP/new-manifest")"
    if [ -f "$APP_DIR/server.js" ] || [ -f "$APP_DIR/stkjinfo/server.js" ]; then
      say "  目录已有代码，按最新版本替换（保留 data/backups/logs）"
      if [ -f "$APP_DIR/.stkj-manifest" ]; then
        cp "$APP_DIR/.stkj-manifest" "$WORK_TMP/old-manifest"
      else
        manifest_of "$APP_DIR" "$WORK_TMP/old-manifest"
      fi
      apply_release "$REL_DIR" "$WORK_TMP/new-manifest" "$WORK_TMP/old-manifest"
    else
      say "  解压代码到 $APP_DIR"
      ( cd "$REL_DIR" && tar cf - . ) | ( cd "$APP_DIR" && tar xf - )
      cp "$WORK_TMP/new-manifest" "$APP_DIR/.stkj-manifest"
    fi
    version="$(remote_sha "$source" || true)"
    [ -n "$version" ] || version="${NEW_TREE:0:12}"
    write_release "$version" "$NEW_TREE" "$source"
  fi

  detect_layout
  say "  代码目录：$CODE_DIR"
  say "  代码版本：${version:-$(read_release version || echo '未知')}"

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
# 拉取：git 仓库模式（沿用旧部署方式）
fetch_git() {
  step "[2/5] 拉取最新代码"
  NEW_CODE_DIR="$APP_DIR"
  local branch="" pull_log=""
  OLD_VER="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  branch="$(git -C "$APP_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "$BRANCH")"
  say "  当前版本：$OLD_VER $(git -C "$APP_DIR" log -1 --pretty=%s)"
  if [ -n "$(git -C "$APP_DIR" status --porcelain)" ]; then
    say "  检测到本地改动，先 git stash 收起"
    git -C "$APP_DIR" stash push -u -m "stkj 升级前自动收起 $(date +%F-%H%M%S)" >/dev/null
    STASHED=1
  fi
  pull_log="$(mktemp)"
  if git -C "$APP_DIR" pull --ff-only origin "$branch" >"$pull_log" 2>&1; then
    sed 's/^/  /' "$pull_log"
    rm -f "$pull_log"
  else
    cat "$pull_log"
    rm -f "$pull_log"
    die "拉取失败：本地与远程可能分叉，请按 README「升级失败怎么办」处理后重试"
  fi
  NEW_VER="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  CHANGED="$(git -C "$APP_DIR" diff --name-only "$OLD_VER" "$NEW_VER" 2>/dev/null || true)"
  say "  最新版本：$NEW_VER $(git -C "$APP_DIR" log -1 --pretty=%s)"
  if [ "$OLD_VER" = "$NEW_VER" ]; then SAME_TREE=1; else SAME_TREE=0; fi
}

# 拉取：下载模式（不需要 git）
fetch_download() {
  step "[2/5] 下载最新代码"
  WORK_TMP="$(mktemp -d)"
  if [ -n "$REPO" ]; then
    SOURCE_URL="$REPO"
    if is_git_url "$SOURCE_URL"; then
      SOURCE_URL="$(git_url_to_tarball "$SOURCE_URL")" ||
        die "该来源是 git 地址，下载模式需要 tar.gz 地址，请改用 --repo=<tar.gz 地址>"
    fi
  else
    SOURCE_URL="$(read_release source || true)"
    [ -n "$SOURCE_URL" ] || SOURCE_URL="$(resolve_source)"
  fi

  fetch_release "$SOURCE_URL" "$WORK_TMP"
  NEW_CODE_DIR="$REL_DIR"
  manifest_of "$REL_DIR" "$WORK_TMP/new-manifest"
  NEW_TREE="$(tree_hash "$WORK_TMP/new-manifest")"
  OLD_TREE="$(read_release tree || true)"
  if [ -f "$APP_DIR/.stkj-manifest" ]; then
    cp "$APP_DIR/.stkj-manifest" "$WORK_TMP/old-manifest"
  else
    manifest_of "$APP_DIR" "$WORK_TMP/old-manifest"
  fi
  if [ -f "$APP_DIR/.stkj-release" ]; then cp "$APP_DIR/.stkj-release" "$WORK_TMP/old-release"; fi

  CHANGED="$(changed_paths "$WORK_TMP/old-manifest" "$WORK_TMP/new-manifest")"
  OLD_VER="$(read_release version || true)"
  [ -n "$OLD_VER" ] || OLD_VER="${OLD_TREE:0:12}"
  [ -n "$OLD_VER" ] || OLD_VER="未知"
  NEW_VER="$(remote_sha "$SOURCE_URL" || true)"
  [ -n "$NEW_VER" ] || NEW_VER="${NEW_TREE:0:12}"

  say "  来源：$SOURCE_URL"
  say "  当前版本：$OLD_VER"
  say "  最新版本：$NEW_VER"
  if [ -n "$OLD_TREE" ] && [ "$NEW_TREE" = "$OLD_TREE" ]; then
    SAME_TREE=1
    say "  代码没有变化"
  else
    SAME_TREE=0
    say "  变更文件：$(printf '%s\n' "$CHANGED" | grep -c . || true) 个"
  fi
}

# 重启失败时回滚到升级前的代码
rollback_download() {
  [ -n "$CODE_PREV" ] && [ -f "$CODE_PREV" ] || return 0
  warn "回滚代码到升级前版本（$CODE_PREV）"
  local rel=""
  if [ -f "$WORK_TMP/new-manifest" ] && [ -f "$WORK_TMP/old-manifest" ]; then
    awk '{print $2}' "$WORK_TMP/new-manifest" | sed 's|^\./||' > "$WORK_TMP/new-paths"
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      if ! grep -qxF -- "$rel" "$WORK_TMP/old-paths"; then rm -f -- "$APP_DIR/$rel"; fi
    done < "$WORK_TMP/new-paths"
    cp "$WORK_TMP/old-manifest" "$APP_DIR/.stkj-manifest"
  fi
  ( cd "$APP_DIR" && tar xzf "$CODE_PREV" )
  if [ -f "$WORK_TMP/old-release" ]; then cp "$WORK_TMP/old-release" "$APP_DIR/.stkj-release"; fi
  systemctl --user restart "$SERVICE"
  sleep 2
  if systemctl --user is-active --quiet "$SERVICE"; then
    warn "已回滚到升级前版本（$OLD_VER），服务已恢复"
  else
    warn "回滚后仍未启动，请手动检查：journalctl --user -u $SERVICE -n 100"
  fi
}

restart_if_needed() {  # $1=1 表示 git 模式
  local git_mode="$1" cf=""
  if [ "$SAME_TREE" = "1" ]; then
    say "  已是最新版本，无需重启"
    return 0
  fi
  NEED_RESTART=0
  for cf in $CHANGED; do
    case "$cf" in
      public/*) ;;                 # 纯前端静态文件，浏览器刷新即可
      *.md|README*|deploy/*) ;;    # 文档与部署脚本，不影响运行
      *) NEED_RESTART=1 ;;
    esac
  done
  if [ "$NEED_RESTART" = "1" ]; then
    say "  后端代码有变化，重启服务"
    systemctl --user restart "$SERVICE"
    sleep 2
    if ! systemctl --user is-active --quiet "$SERVICE"; then
      warn "服务启动失败，最近日志："
      tail -n 40 "$APP_DIR/logs/app.log" 2>/dev/null || true
      if [ "$git_mode" = "1" ]; then
        die "升级失败，可回滚：git reset --hard $OLD_VER && systemctl --user restart $SERVICE"
      fi
      rollback_download
      die "升级失败：已尝试回滚到 $OLD_VER，请检查上面的日志"
    fi
    say "  服务已重启"
  else
    say "  只有前端静态文件/文档/脚本变化，无需重启（浏览器 Ctrl+F5 刷新即可）"
  fi
}

cmd_upgrade() {
  preflight
  [ -d "$APP_DIR" ] || die "找不到安装目录 $APP_DIR，请先安装：bash $SELF install"
  systemctl --user cat "$SERVICE" >/dev/null 2>&1 ||
    die "服务尚未安装，请先执行：bash $SELF install"

  cd "$APP_DIR"
  detect_layout
  if [ -n "$NODE_VER" ]; then
    ensure_node "$NODE_VER"
  elif ! pick_node 1; then
    die "找不到可用的 Node.js（可在安装时用 --node-version= 指定）"
  fi

  local git_mode=0
  if [ -d "$APP_DIR/.git" ] && have_git; then git_mode=1; fi

  say ""
  say "============================================"
  say " stkj 升级"
  say "   安装目录：$APP_DIR"
  say "   Node     ：$("$NODE_BIN" -v)（$NODE_BIN）"
  say "   代码来源：$([ "$git_mode" = "1" ] && echo "git pull" || echo "下载代码包（不需要 git）")"
  say "============================================"

  step "[1/5] 备份数据库"
  backup_db

  if [ "$git_mode" = "1" ]; then
    fetch_git
  else
    fetch_download
  fi

  step "[3/5] 语法检查"
  check_js "$NEW_CODE_DIR"
  say "  通过"

  step "[4/5] 应用变更"
  if [ "$git_mode" = "0" ] && [ "$SAME_TREE" = "0" ]; then
    apply_release "$REL_DIR" "$WORK_TMP/new-manifest" "$WORK_TMP/old-manifest"
    write_release "$NEW_VER" "$NEW_TREE" "$SOURCE_URL"
    say "  已替换代码文件（data/backups/logs 未改动）"
  fi
  restart_if_needed "$git_mode"

  step "[5/5] 自检"
  say "  服务状态：$(systemctl --user is-active "$SERVICE" 2>/dev/null || echo unknown)"
  say "  首页访问：HTTP $(http_code)"
  if [ -f "$APP_DIR/data/app.db" ]; then
    say "  数据统计：$(counts_line)"
  fi

  say ""
  say "============================================"
  if [ "$SAME_TREE" = "1" ]; then
    say " 升级完成：已是最新版本（$NEW_VER）"
  else
    say " 升级完成：$OLD_VER → $NEW_VER"
  fi
  say "   备份文件：$(latest_backup)"
  if [ "$STASHED" = "1" ]; then
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
  if [ -d "$APP_DIR/.git" ] && have_git; then
    say "  代码版本：$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?') $(git -C "$APP_DIR" log -1 --pretty=%s 2>/dev/null || true)"
  elif [ -f "$APP_DIR/.stkj-release" ]; then
    say "  代码版本：$(read_release version || echo '?')（$(read_release date || echo '?')）"
    say "  代码来源：$(read_release source || echo '?')"
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
  *) die "未知命令：$CMD（执行 bash $SELF help 查看用法）" ;;
esac
