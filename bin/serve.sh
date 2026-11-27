#!/usr/bin/env bash
# Start or stop the Koharu MCP server for one project.
#
#   bin/serve.sh <project.khr> [port]   start (default port 7878)
#   bin/serve.sh --stop [port]          stop the server on the port
#
# KOHARU_SERVE_BIN overrides the server binary; KOHARU_LOG_DIR overrides the log directory.
set -euo pipefail

BIN=${KOHARU_SERVE_BIN:-serve}
if [[ $BIN != */* ]]; then BIN=$(command -v "$BIN" || true); fi
LOG_DIR=${KOHARU_LOG_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-koharu/logs}

usage() {
  echo "usage: $0 <project.khr> [port] [page images...]" >&2
  echo "       $0 --stop [port]" >&2
  exit 2
}

port_pid() {
  ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

stop_port() {
  local port=$1 pid
  pid=$(port_pid "$port" || true)
  if [ -z "${pid:-}" ]; then
    echo "serve $port already stopped"
    return 0
  fi
  # The project file is folded on a clean exit, so SIGINT first.
  kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { echo "serve $port stopped"; return 0; }
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null || true
  echo "serve $port killed after 20s"
}

health() {
  local port=$1 headers
  headers=$(mktemp)
  if curl -s -D "$headers" -o /dev/null --max-time 5 -X POST "http://127.0.0.1:$port/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"serve-sh","version":"1"}}}'; then
    tr -d '\r' < "$headers" | awk 'tolower($1)=="mcp-session-id:"{print $2}'
  fi
  rm -f "$headers"
}

project() {
  local port=$1 session=$2
  curl -s --max-time 10 -X POST "http://127.0.0.1:$port/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $session" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project","arguments":{}}}' |
    sed -n 's/^data: //p' |
    python3 -c 'import json,sys
try:
    text = json.load(sys.stdin)["result"]["content"][0]["text"]
    project = json.loads(text)
    print(project["id"], len(project["pages"]))
except Exception:
    sys.exit(1)'
}

if [ "${1:-}" = "--stop" ]; then
  stop_port "${2:-7878}"
  exit 0
fi

[ $# -ge 1 ] || usage
PROJECT=$1
shift
PORT=7878
if [ $# -ge 1 ] && [[ $1 =~ ^[0-9]+$ ]]; then
  PORT=$1
  shift
fi
PAGES=("$@")
[ -f "$PROJECT" ] || [ $# -ge 1 ] || { echo "no project file at $PROJECT (pass page images to create it)" >&2; exit 1; }
for page in "${PAGES[@]+"${PAGES[@]}"}"; do
  [ -f "$page" ] || { echo "no page image at $page" >&2; exit 1; }
done
[ -x "$BIN" ] || { echo "no server binary at $BIN; cargo install --path crates/koharu-agent --example serve --root ~/.local (or set KOHARU_SERVE_BIN)" >&2; exit 1; }
PROJECT=$(cd "$(dirname "$PROJECT")" && pwd)/$(basename "$PROJECT")

if [ -n "$(port_pid "$PORT" || true)" ]; then
  stop_port "$PORT"
fi

mkdir -p "$LOG_DIR"
NAME=$(basename "$(dirname "$PROJECT")")
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="$LOG_DIR/serve-$PORT-$NAME-$STAMP.log"
nohup env GGML_VK_VISIBLE_DEVICES=0 "$BIN" --port "$PORT" "$PROJECT" ${PAGES[@]+"${PAGES[@]}"} > "$LOG" 2>&1 &
PID=$!
{ ls -1t "$LOG_DIR"/serve-"$PORT"-*.log 2>/dev/null || true; } | tail -n +21 | xargs -r rm -f
echo "serve $PORT starting (pid $PID, log $LOG)"

SESSION=""
for _ in $(seq 1 150); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "serve $PORT exited; last log lines:" >&2
    tail -5 "$LOG" >&2
    exit 1
  fi
  SESSION=$(health "$PORT" || true)
  [ -n "$SESSION" ] && break
  sleep 2
done
[ -n "$SESSION" ] || { echo "serve $PORT did not answer in 5 min" >&2; exit 1; }

READY=$(project "$PORT" "$SESSION" || true)
[ -n "$READY" ] || { echo "serve $PORT answered but get_project failed" >&2; exit 1; }
echo "serve $PORT project ${READY% *} pages ${READY##* }"
