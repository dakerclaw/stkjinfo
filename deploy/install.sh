#!/usr/bin/env bash
# 兼容旧入口：等价于 `bash deploy/stkj.sh install`
# 旧写法 `bash install.sh <代码包或仓库地址>` 仍可用（会转成 --repo=）。
set -euo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
args=()
for a in "$@"; do
  case "$a" in
    -*) args+=("$a") ;;
    *) args+=("--repo=$a") ;;
  esac
done
exec bash "$DIR/stkj.sh" install ${args[@]+"${args[@]}"}
