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
  local start end latency status error connections rx tx uptime probes_json payload response

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
  probes_json="$(probe_targets_json)"
  payload="$(json_payload "$status" "$latency" "$error" "$connections" "$rx" "$tx" "$uptime" "$probes_json")"
  if [[ -s /etc/gproxy-agent/command-result.json ]]; then
    payload="$(merge_command_result "$payload" /etc/gproxy-agent/command-result.json)"
  fi

  response="$(curl -fsS --show-error \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${PANEL%/}/api/node/${NODE}/agent" \
    --data "$payload" \
    2>/tmp/gproxy-agent-report.err)" || {
      logger -t gproxy-agent "report failed: $(tr '\n' ' ' </tmp/gproxy-agent-report.err | cut -c1-180)"
      return 0
    }

  rm -f /etc/gproxy-agent/command-result.json
  handle_command "$response"
  if [[ -s /etc/gproxy-agent/command-result.json ]]; then
    report_command_result_now "$payload" || true
  fi
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

probe_targets_json() {
  python3 - <<'PY'
import json
import socket
import time

targets = {
    "cm": ("js-cm-v4.ip.zstaticcdn.com", 80),
    "cu": ("js-cu-v4.ip.zstaticcdn.com", 80),
    "ct": ("js-ct-v4.ip.zstaticcdn.com", 80),
}

results = {}
for key, (host, port) in targets.items():
    start = time.time()
    try:
        with socket.create_connection((host, port), timeout=3):
            latency = int(round((time.time() - start) * 1000))
        results[key] = {"host": host, "port": port, "status": "up", "latencyMs": latency, "error": ""}
    except Exception as exc:
        results[key] = {"host": host, "port": port, "status": "down", "latencyMs": None, "error": str(exc)[:120]}

print(json.dumps(results, separators=(",", ":")))
PY
}

json_payload() {
  python3 - "$@" <<'PY'
import json
import sys

status, latency, error, connections, rx, tx, uptime, probes = sys.argv[1:]
try:
    probe_value = json.loads(probes)
except Exception:
    probe_value = {}

print(json.dumps({
    "status": status,
    "latencyMs": int(latency),
    "error": error,
    "connections": int(connections),
    "rxBytes": int(rx),
    "txBytes": int(tx),
    "uptimeSeconds": int(uptime),
    "probes": probe_value,
    "version": "shell-3",
}))
PY
}

merge_command_result() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
with open(sys.argv[2], "r", encoding="utf-8") as fh:
    payload["commandResult"] = json.load(fh)
print(json.dumps(payload, separators=(",", ":")))
PY
}

report_command_result_now() {
  local base_payload="$1"
  local result_payload

  result_payload="$(merge_command_result "$base_payload" /etc/gproxy-agent/command-result.json)"
  curl -fsS --show-error \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -X POST "${PANEL%/}/api/node/${NODE}/agent" \
    --data "$result_payload" \
    >/dev/null 2>/tmp/gproxy-agent-command-result.err || {
      logger -t gproxy-agent "command result report failed: $(tr '\n' ' ' </tmp/gproxy-agent-command-result.err | cut -c1-180)"
      return 1
    }

  rm -f /etc/gproxy-agent/command-result.json
}

handle_command() {
  local response="$1"
  local command_json command_type command_id config_url
  command_json="$(python3 - "$response" <<'PY'
import json
import sys

try:
    command = json.loads(sys.argv[1]).get("command")
except Exception:
    command = None

print(json.dumps(command or {}, separators=(",", ":")))
PY
)"

  command_type="$(python3 - "$command_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get("type", ""))
PY
)"
  if [[ "$command_type" != "deploy-docker" ]]; then
    return 0
  fi

  command_id="$(python3 - "$command_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get("id", ""))
PY
)"
  config_url="$(python3 - "$command_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get("configUrl", ""))
PY
)"
  run_deploy_docker "$command_id" "$config_url"
}

run_deploy_docker() {
  local command_id="$1"
  local config_url="$2"
  local output exit_code

  if [[ -z "$command_id" || -z "$config_url" ]]; then
    write_command_result "$command_id" false 2 "" "missing deploy command fields"
    return 0
  fi
  if [[ "$config_url" != http://* && "$config_url" != https://* ]]; then
    write_command_result "$command_id" false 2 "" "invalid config url"
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    write_command_result "$command_id" false 127 "" "docker command not found"
    return 0
  fi

  set +e
  output="$(docker rm -f gproxy 2>&1; docker run --network=host --name=gproxy --restart=always -d gproxylabs/gproxy -w -c "$config_url" 2>&1)"
  exit_code=$?
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    write_command_result "$command_id" true "$exit_code" "$output" ""
  else
    write_command_result "$command_id" false "$exit_code" "$output" "docker deploy failed"
  fi
}

write_command_result() {
  local command_id="$1"
  local ok="$2"
  local exit_code="$3"
  local output="$4"
  local error="$5"
  python3 - "$command_id" "$ok" "$exit_code" "$output" "$error" <<'PY'
import json
import sys

command_id, ok, exit_code, output, error = sys.argv[1:]
payload = {
    "id": command_id,
    "ok": ok == "true",
    "exitCode": int(exit_code or 0),
    "output": output[-2000:],
    "error": error[-1000:],
}
with open("/etc/gproxy-agent/command-result.json", "w", encoding="utf-8") as fh:
    json.dump(payload, fh, separators=(",", ":"))
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
