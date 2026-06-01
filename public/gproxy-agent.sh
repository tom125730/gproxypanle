#!/usr/bin/env bash
set -euo pipefail

install_from_query() {
  local query="${1:-}"

  require_command curl
  require_command python3
  require_command systemctl

  if [[ -z "$query" ]]; then
    echo "usage: bash gproxy-agent.sh 'panel=https://panel.example&node=node-id&token=secret&listen=0.0.0.0:443&host=example.com&port=443'" >&2
    exit 2
  fi

  local decoded
  decoded="$(python3 - "$query" <<'PY'
import sys
from urllib.parse import parse_qs

params = parse_qs(sys.argv[1], keep_blank_values=True)
for key in ["panel", "node", "token", "listen", "host", "port"]:
    value = params.get(key, [""])[0]
    print(f"{key.upper()}={value!r}")
PY
)"
  eval "$decoded"

  mkdir -p /etc/gproxy-agent
  {
    echo "$decoded"
    echo "INTERVAL=60"
  } > /etc/gproxy-agent/env
  chmod 600 /etc/gproxy-agent/env

  curl -fsSL "${PANEL%/}/static/gproxy-agent.sh" -o /usr/local/bin/gproxy-agent
  chmod 0755 /usr/local/bin/gproxy-agent

  cat >/etc/systemd/system/gproxy-agent.service <<'UNIT'
[Unit]
Description=gproxy node monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/gproxy-agent/env
ExecStart=/usr/local/bin/gproxy-agent run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now gproxy-agent
  systemctl status gproxy-agent --no-pager
}

run_agent() {
  require_command curl
  require_command python3

  local listen_port
  listen_port="${LISTEN##*:}"
  if [[ -z "$listen_port" || ! "$listen_port" =~ ^[0-9]+$ ]]; then
    listen_port="${PORT}"
  fi

  setup_iptables_counter "$listen_port"

  while true; do
    report_once "$listen_port" || true
    sleep "${INTERVAL:-60}"
  done
}

report_once() {
  local listen_port="$1"
  local start end latency status error connections rx tx uptime

  start="$(now_ms)"
  error=""
  status="down"

  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${listen_port}" 2>/tmp/gproxy-agent-check.err; then
    status="up"
  else
    error="$(tr '\n' ' ' </tmp/gproxy-agent-check.err | cut -c1-180)"
    if [[ -z "$error" ]]; then
      error="tcp check failed on 127.0.0.1:${listen_port}"
    fi
  fi

  end="$(now_ms)"
  latency=$((end - start))
  connections="$(connection_count "$listen_port")"
  rx="$(iptables_bytes INPUT "$listen_port")"
  tx="$(iptables_bytes OUTPUT "$listen_port")"
  uptime="$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)"

  curl -fsS \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${PANEL%/}/api/node/${NODE}/agent" \
    --data "$(json_payload "$status" "$latency" "$error" "$connections" "$rx" "$tx" "$uptime")" \
    >/dev/null
}

setup_iptables_counter() {
  local port="$1"
  if ! command -v iptables >/dev/null 2>&1; then
    return 0
  fi

  ensure_iptables_rule INPUT tcp dport "$port"
  ensure_iptables_rule INPUT udp dport "$port"
  ensure_iptables_rule OUTPUT tcp sport "$port"
  ensure_iptables_rule OUTPUT udp sport "$port"
}

ensure_iptables_rule() {
  local chain="$1"
  local protocol="$2"
  local option="$3"
  local port="$4"
  local comment="gproxy-agent-${chain}-${protocol}-${port}"

  if iptables -nvx -L "$chain" 2>/dev/null | grep -F "$comment" >/dev/null; then
    return 0
  fi

  iptables -I "$chain" 1 -p "$protocol" -m "$protocol" --"$option" "$port" -m comment --comment "$comment" || true
}

iptables_bytes() {
  local chain="$1"
  local port="$2"
  if ! command -v iptables >/dev/null 2>&1; then
    echo 0
    return
  fi

  iptables -nvx -L "$chain" 2>/dev/null |
    awk -v chain="$chain" -v port="$port" '
      BEGIN {
        tcp = "gproxy-agent-" chain "-tcp-" port
        udp = "gproxy-agent-" chain "-udp-" port
      }
      $0 ~ tcp || $0 ~ udp { total += $2; found=1 }
      END { if (found) print total; else print 0 }
    '
}

connection_count() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    echo 0
    return
  fi

  ss -Htan "sport = :${port} or dport = :${port}" 2>/dev/null | wc -l
}

json_payload() {
  python3 - "$@" <<'PY'
import json
import sys

status, latency, error, connections, rx, tx, uptime = sys.argv[1:]
print(json.dumps({
    "status": status,
    "latencyMs": int(latency),
    "error": error,
    "connections": int(connections),
    "rxBytes": int(rx),
    "txBytes": int(tx),
    "uptimeSeconds": int(uptime),
    "version": "shell-1",
}))
PY
}

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

case "${1:-install}" in
  run)
    run_agent
    ;;
  *)
    install_from_query "${1:-}"
    ;;
esac
