#!/usr/bin/env bash
# 兼容旧入口：等价于 `bash deploy/stkj.sh uninstall`
# 参数（--purge / --purge-all / --dry-run / --yes）原样透传。
set -euo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/stkj.sh" uninstall "$@"
