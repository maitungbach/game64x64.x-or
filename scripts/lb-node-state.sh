#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${LB_CONFIG_PATH:-/etc/nginx/sites-enabled/game64x64-lb}"

usage() {
  cat <<'EOF'
Usage:
  lb-node-state.sh status
  lb-node-state.sh drain <backend_ip>
  lb-node-state.sh undrain <backend_ip>

Examples:
  sudo lb-node-state.sh status
  sudo lb-node-state.sh drain 172.16.10.216
  sudo lb-node-state.sh undrain 172.16.10.253
EOF
}

require_backend() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    usage
    exit 1
  fi
}

show_status() {
  grep -E '^[[:space:]]*server [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:80' "$CONFIG_PATH"
}

rewrite_backend() {
  local backend_ip="$1"
  local target_line="$2"

  python3 - "$CONFIG_PATH" "$backend_ip" "$target_line" <<'PY'
import pathlib
import re
import sys

config_path = pathlib.Path(sys.argv[1])
backend_ip = sys.argv[2]
target_line = sys.argv[3]
pattern = re.compile(rf"^(\s*)server\s+{re.escape(backend_ip)}:80\b.*;$", re.MULTILINE)
text = config_path.read_text()
updated, count = pattern.subn(lambda match: f"{match.group(1)}{target_line}", text, count=1)
if count != 1:
    raise SystemExit(f"backend {backend_ip} not found in {config_path}")
config_path.write_text(updated)
PY
}

reload_nginx() {
  nginx -t
  systemctl reload nginx
}

action="${1:-}"

case "$action" in
  status)
    show_status
    ;;
  drain)
    require_backend "$@"
    rewrite_backend "$2" "server $2:80 max_fails=2 fail_timeout=10s down;"
    reload_nginx
    show_status
    ;;
  undrain)
    require_backend "$@"
    rewrite_backend "$2" "server $2:80 max_fails=2 fail_timeout=10s;"
    reload_nginx
    show_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
