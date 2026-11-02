#!/usr/bin/env bash
# ============================================================
# stkj root 一键安装（Debian 13 / Ubuntu 24.04+ 适用）
#
# 用法（root 执行）：
#   bash stkj-root-install.sh                    # 全新安装（创建 stkj 用户 + 应用 + nginx 443 反代）
#   bash stkj-root-install.sh --no-nginx         # 只装应用，不动 nginx
#   bash stkj-root-install.sh --domain=xxx.com   # 指定域名（默认 300750.xyz）
#   bash stkj-root-install.sh --user=xxx         # 指定运行用户（默认 stkj）
#   bash stkj-root-install.sh --port=5173        # 应用监听端口（默认 5173，仅本机反代用 127.0.0.1）
#
# 行为：
#   1. apt 安装 curl/tar/xz/nginx/certbot（缺啥装啥）
#   2. 创建运行用户（若不存在）并 enable-linger（开机自启）
#   3. 以该用户身份执行官方 install 脚本（Node/代码/数据库/服务全自动）
#   4. 可选：seed 初始化演示账号（admin/admin123）
#   5. 可选：nginx 80→443 + TLS 反代 5173（证书已有则复用，没有则 certbot 签发）
#
# 幂等：重复执行安全；已有数据不会被覆盖。
# ============================================================
set -euo pipefail

RUN_USER="stkj"
DOMAIN="300750.xyz"
APP_PORT="5173"
WITH_NGINX=1
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
    --domain=*)   DOMAIN="${arg#*=}" ;;
    --port=*)     APP_PORT="${arg#*=}" ;;
    --no-nginx)   WITH_NGINX=0 ;;
    --no-seed)    SEED=0 ;;
    --help|-h)    sed -n '2,30p' "$0"; exit 0 ;;
    *) die "未知参数：$arg（--help 查看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"

# ------------------------------------------------------------
say "[1/6] 系统依赖"
# ------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
NEED=""
for p in curl tar xz sha256sum; do command -v "$p" >/dev/null 2>&1 || NEED="$NEED coreutils"; done
command -v curl >/dev/null 2>&1 || NEED="$NEED curl"
command -v xz   >/dev/null 2>&1 || NEED="$NEED xz-utils"
if [ "$WITH_NGINX" = 1 ]; then
  command -v nginx >/dev/null 2>&1 || NEED="$NEED nginx"
  command -v certbot >/dev/null 2>&1 || NEED="$NEED certbot python3-certbot-nginx"
fi
if [ -n "${NEED// /}" ]; then
  say "  apt 安装：$NEED"
  apt-get update -qq
  apt-get install -y -qq $NEED
else
  say "  依赖齐备"
fi

# ------------------------------------------------------------
say "[2/6] 运行用户：$RUN_USER"
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
say "[3/6] 以 $RUN_USER 身份安装应用"
# ------------------------------------------------------------
if [ -f "$APP_DIR/deploy/stkj.sh" ]; then
  say "  已有安装，执行 upgrade 逻辑（幂等）"
  su - "$RUN_USER" -c "bash '$APP_DIR/deploy/stkj.sh' install" || true
else
  say "  全新安装（官方脚本：Node v22 + 代码 + 数据库 + 用户服务）"
  su - "$RUN_USER" -c "curl -fsSL https://raw.githubusercontent.com/dakerclaw/stkjinfo/main/deploy/stkj.sh | bash -s -- install --port=$APP_PORT --host=127.0.0.1"
fi

# 官方脚本装完后再确保服务在跑
su - "$RUN_USER" -c "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user enable --now stkj.service" 2>/dev/null || true
su - "$RUN_USER" -c "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user is-active stkj.service" | grep -q active ||
  die "stkj 服务未起来，请查看：journalctl --user -u stkj（用 $RUN_USER 登录）"
say "  服务 active：http://127.0.0.1:$APP_PORT"

# ------------------------------------------------------------
say "[4/6] 账号初始化"
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
say "[5/6] nginx + TLS（$DOMAIN）"
# ------------------------------------------------------------
if [ "$WITH_NGINX" = 1 ]; then
  NGX_CFG="/etc/nginx/sites-available/$DOMAIN"
  if [ -f "$NGX_CFG" ]; then
    say "  nginx 站点配置已存在，跳过（如需重写请先删除 $NGX_CFG）"
  else
    say "  写入站点配置 $NGX_CFG"
    CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
    if [ -f "$CERT_DIR/fullchain.pem" ]; then
      say "  检测到已有证书，直接启用 443"
      TLS_BLOCK=$(cat <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    client_max_body_size 20m;
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 30s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
    }
}
EOF
)
    else
      say "  无证书：先起 80（ACME 校验 + 跳转），稍后用 certbot 签发"
      TLS_BLOCK=$(cat <<EOF
# certbot 签发后自动注入 443 server 块
EOF
)
    fi

    cat > "$NGX_CFG" <<EOF
# stkj 项目管理系统 — $DOMAIN（root 一键安装脚本生成）
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    client_max_body_size 20m;
    server_tokens off;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        if (\$http_x_forwarded_proto != "https") {
            return 301 https://\$host\$request_uri;
        }
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 30s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
    }
}

$TLS_BLOCK
EOF
    ln -sfn "$NGX_CFG" "/etc/nginx/sites-enabled/$DOMAIN"
  fi

  nginx -t || die "nginx 配置校验失败"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  say "  nginx 已加载"

  # 没证书时尝试 certbot 自动签发（需要域名已解析到本机 + 80 可达）
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    say "  尝试 certbot 签发 $DOMAIN ..."
    if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null ||
       certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email; then
      say "  证书签发成功，443 已启用"
    else
      warn "  certbot 签发失败（域名未解析 / 80 不可达）。应用仍可通过 http://服务器IP:$APP_PORT 访问"
      warn "  解析就绪后重跑：certbot --nginx -d $DOMAIN"
    fi
  fi
else
  say "  跳过 nginx（--no-nginx）"
fi

# ------------------------------------------------------------
say "[6/6] 自检"
# ------------------------------------------------------------
sleep 1
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$APP_PORT/" || true)
say "  应用本地：http://127.0.0.1:$APP_PORT/ -> $HOME_CODE"
if [ "$WITH_NGINX" = 1 ]; then
  HTTPS_CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "https://127.0.0.1/" -H "Host: $DOMAIN" --resolve "$DOMAIN:443:127.0.0.1" || true)
  say "  nginx 443：https://$DOMAIN/ -> $HTTPS_CODE"
fi

say ""
say "============================================"
say " 安装完成"
say "   运行用户：$RUN_USER（linger 已开）"
say "   应用目录：$APP_DIR"
say "   服务管理：su - $RUN_USER -c 'bash ~/apps/stkj/deploy/stkj.sh status'"
say "   升级：    su - $RUN_USER -c 'bash ~/apps/stkj/deploy/stkj.sh upgrade'"
say "   访问：    https://$DOMAIN/ （或 http://服务器IP:$APP_PORT）"
say "   默认账号：admin / admin123（登录后立即修改密码，入口在左下角）"
say "============================================"
