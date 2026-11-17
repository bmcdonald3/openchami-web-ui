#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_HOST="${REMOTE_HOST:-root@tamarindo.hpc.amslabs.hpecorp.net}"
REMOTE_DIR="${REMOTE_DIR:-/root/openchami-web-ui}"
NAMESPACE="${OPENCHAMI_NAMESPACE:-openchami-testcluster}"
MAGELLAN_BIN="${MAGELLAN_BIN:-magellan}"
REMOTE_APP_PORT="${REMOTE_APP_PORT:-5173}"
REMOTE_SMD_PORT="${REMOTE_SMD_PORT:-39101}"
REMOTE_BSS_PORT="${REMOTE_BSS_PORT:-39102}"
LOCAL_PORT="${LOCAL_PORT:-5175}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTROL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openchami-console.XXXXXX")"
CONTROL_SOCKET="$CONTROL_DIR/ssh-control"
REMOTE_STARTED=false

quote_for_shell() {
  printf '%q' "$1"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -S "$CONTROL_SOCKET" ]]; then
    if [[ "$REMOTE_STARTED" == true ]]; then
      ssh -S "$CONTROL_SOCKET" "$REMOTE_HOST" bash -s -- <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
state="$HOME/.cache/openchami-web-ui"
for name in app smd-forward bss-forward; do
  file="$state/$name.pid"
  if [[ -f "$file" ]]; then
    pid=$(cat "$file")
    if [[ "$pid" =~ ^[0-9]+$ ]]; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$file"
  fi
done
REMOTE_CLEANUP
    fi
    ssh -S "$CONTROL_SOCKET" -O exit "$REMOTE_HOST" >/dev/null 2>&1 || true
  fi
  rm -rf "$CONTROL_DIR"
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

for command_name in ssh tar lsof curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing local command: %s\n' "$command_name" >&2
    exit 1
  fi
done

if lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Local port %s is already in use. Set LOCAL_PORT to another free port and retry.\n' "$LOCAL_PORT" >&2
  exit 1
fi

printf 'Connecting to %s and creating a temporary SSH control connection...\n' "$REMOTE_HOST"
ssh -M -S "$CONTROL_SOCKET" -o ControlPersist=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -fN "$REMOTE_HOST"

printf 'Copying this app to %s:%s over SSH...\n' "$REMOTE_HOST" "$REMOTE_DIR"
remote_dir_quoted="$(quote_for_shell "$REMOTE_DIR")"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.DS_Store' \
  -C "$SCRIPT_DIR" . |
  ssh -S "$CONTROL_SOCKET" "$REMOTE_HOST" "mkdir -p $remote_dir_quoted && tar -xzf - -C $remote_dir_quoted"

printf 'Checking remote tools, namespace and service names...\n'
ssh -S "$CONTROL_SOCKET" "$REMOTE_HOST" bash -s -- \
  "$REMOTE_DIR" "$NAMESPACE" "$MAGELLAN_BIN" \
  "$REMOTE_APP_PORT" "$REMOTE_SMD_PORT" "$REMOTE_BSS_PORT" <<'REMOTE_START'
set -Eeuo pipefail
umask 077
app_dir="$1"
namespace="$2"
magellan_bin="$3"
app_port="$4"
smd_port="$5"
bss_port="$6"
state="$HOME/.cache/openchami-web-ui"
mkdir -p "$state"
chmod 700 "$state"

missing=()
for command_name in node npm kubectl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then missing+=("$command_name"); fi
done
if ! command -v "$magellan_bin" >/dev/null 2>&1; then missing+=("Magellan ($magellan_bin)"); fi
if [[ ${#missing[@]} -gt 0 ]]; then
  printf '\nRequired tools are missing on Tamarindo: %s\n' "${missing[*]}" >&2
  printf 'Install/configure these manually using your site-approved modules or packages, then rerun this script.\n' >&2
  printf 'Requirements: Node.js 20.19+ with npm, kubectl configured for the cluster, curl, and Magellan on PATH.\n' >&2
  exit 2
fi

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major > 20 || major === 20 && minor >= 19 ? 0 : 1)'; then
  printf 'Node.js %s is too old; install Node.js 20.19+ manually and rerun.\n' "$(node --version)" >&2
  exit 2
fi
if [[ ! -x "$app_dir/node_modules/.bin/vite" ]]; then
  printf '\nApp dependencies are not installed at %s.\n' "$app_dir" >&2
  printf 'Run this manually on Tamarindo with your approved npm registry/cache:\n  cd %q && npm ci\n' "$app_dir" >&2
  exit 2
fi

context=$(kubectl config current-context 2>/dev/null || true)
if [[ -z "$context" ]]; then
  printf 'kubectl has no active context on Tamarindo. Configure/select the cluster context, then rerun.\n' >&2
  exit 2
fi
if ! kubectl get namespace "$namespace" >/dev/null; then
  printf 'Cannot read namespace %s using kubectl context %s. Check the namespace and access, then rerun.\n' "$namespace" "$context" >&2
  exit 2
fi
if ! kubectl get service smd boot-service -n "$namespace" >/dev/null; then
  printf 'Expected services smd and boot-service were not found in namespace %s.\n' "$namespace" >&2
  exit 2
fi
if ! kubectl get deployment tokensmith -n "$namespace" >/dev/null; then
  printf 'TokenSmith deployment was not found in namespace %s; automatic session tokens are unavailable.\n' "$namespace" >&2
  exit 2
fi

for name in app smd-forward bss-forward; do
  file="$state/$name.pid"
  if [[ -f "$file" ]]; then
    pid=$(cat "$file")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      printf 'A managed %s process is already running on Tamarindo (PID %s). Stop that session before starting another.\n' "$name" "$pid" >&2
      exit 2
    fi
    rm -f "$file"
  fi
done

port_available() {
  node -e 'const net=require("net");const socket=net.connect(Number(process.argv[1]),"127.0.0.1");socket.once("connect",()=>{socket.destroy();process.exit(1)});socket.once("error",()=>process.exit(0));socket.setTimeout(500,()=>process.exit(0))' "$1"
}
for port in "$app_port" "$smd_port" "$bss_port"; do
  if ! port_available "$port"; then
    printf 'Remote loopback port %s is already in use. Set the corresponding REMOTE_*_PORT override and retry.\n' "$port" >&2
    exit 2
  fi
done

cleanup_partial() {
  for name in app smd-forward bss-forward; do
    file="$state/$name.pid"
    if [[ -f "$file" ]]; then
      pid=$(cat "$file")
      if [[ "$pid" =~ ^[0-9]+$ ]]; then kill "$pid" 2>/dev/null || true; fi
      rm -f "$file"
    fi
  done
}
trap cleanup_partial EXIT

smd_token=$(kubectl exec -n "$namespace" deploy/tokensmith -- \
  /usr/local/bin/tokensmith user-token create \
  --subject demo-admin --audience hsm \
  --scopes node:read,node:write,group:read,group:write \
  --key-file /var/lib/tokensmith/keys/private.pem \
  --enable-local-user-mint)
bss_token=$(kubectl exec -n "$namespace" deploy/tokensmith -- \
  /usr/local/bin/tokensmith user-token create \
  --subject demo-admin --audience boot-service \
  --scopes boot:read,boot:write,node:read,node:write \
  --key-file /var/lib/tokensmith/keys/private.pem \
  --enable-local-user-mint)
if [[ -z "$smd_token" || -z "$bss_token" ]]; then
  printf 'TokenSmith returned an empty token; no services were started.\n' >&2
  exit 2
fi

nohup kubectl port-forward --address 127.0.0.1 -n "$namespace" \
  svc/smd "$smd_port:27779" >"$state/smd-forward.log" 2>&1 </dev/null &
printf '%s\n' "$!" > "$state/smd-forward.pid"
nohup kubectl port-forward --address 127.0.0.1 -n "$namespace" \
  svc/boot-service "$bss_port:27778" >"$state/bss-forward.log" 2>&1 </dev/null &
printf '%s\n' "$!" > "$state/bss-forward.pid"

wait_for_port() {
  port="$1"
  log="$2"
  attempt=0
  while [[ "$attempt" -lt 40 ]]; do
    pid_file="$3"
    pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'A port-forward exited early. Log follows: %s\n' "$log" >&2
      cat "$log" >&2
      return 1
    fi
    if node -e 'const net=require("net");const socket=net.connect(Number(process.argv[1]),"127.0.0.1");socket.once("connect",()=>{socket.end();process.exit(0)});socket.once("error",()=>process.exit(1))' "$port"; then return 0; fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  printf 'Timed out waiting for port-forward on %s. Log follows: %s\n' "$port" "$log" >&2
  cat "$log" >&2
  return 1
}
wait_for_port "$smd_port" "$state/smd-forward.log" "$state/smd-forward.pid"
wait_for_port "$bss_port" "$state/bss-forward.log" "$state/bss-forward.pid"

export OPENCHAMI_NAMESPACE="$namespace"
export OPENCHAMI_SMD_URL="http://127.0.0.1:$smd_port"
export OPENCHAMI_BSS_URL="http://127.0.0.1:$bss_port"
export OPENCHAMI_SMD_TOKEN="$smd_token"
export OPENCHAMI_BSS_TOKEN="$bss_token"
export MAGELLAN_BIN="$magellan_bin"
cd "$app_dir"
nohup ./node_modules/.bin/vite --host 127.0.0.1 --port "$app_port" --strictPort \
  >"$state/app.log" 2>&1 </dev/null &
printf '%s\n' "$!" > "$state/app.pid"
unset smd_token bss_token

attempt=0
while [[ "$attempt" -lt 40 ]]; do
  app_pid=$(cat "$state/app.pid")
  if ! kill -0 "$app_pid" 2>/dev/null; then
    printf 'The console server exited early. Log follows: %s\n' "$state/app.log" >&2
    cat "$state/app.log" >&2
    exit 1
  fi
  if curl --silent --max-time 1 "http://127.0.0.1:$app_port/api/config" | node -e 'let text="";process.stdin.on("data",x=>text+=x).on("end",()=>{try{const value=JSON.parse(text);process.exit(value.managedAuth && value.smdUrl && value.bssUrl ? 0 : 1)}catch{process.exit(1)}})'; then break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [[ "$attempt" -ge 40 ]]; then
  printf 'Timed out waiting for the console server. Log follows: %s\n' "$state/app.log" >&2
  cat "$state/app.log" >&2
  exit 1
fi

trap - EXIT
printf 'Remote services are ready in namespace %s (kubectl context %s).\n' "$namespace" "$context"
printf 'SMD and BSS tokens were minted for this session and were not printed or saved.\n'
printf 'Remote forwards: SMD 127.0.0.1:%s, BSS 127.0.0.1:%s; console 127.0.0.1:%s.\n' "$smd_port" "$bss_port" "$app_port"
REMOTE_START
REMOTE_STARTED=true

printf 'Opening SSH tunnel on local port %s...\n' "$LOCAL_PORT"
if ! ssh -S "$CONTROL_SOCKET" -o ExitOnForwardFailure=yes \
  -O forward -L "$LOCAL_PORT:127.0.0.1:$REMOTE_APP_PORT" "$REMOTE_HOST"; then
  printf 'The SSH control master could not install the local port forward.\n' >&2
  exit 1
fi

attempt=0
while [[ "$attempt" -lt 40 ]]; do
  if ! ssh -S "$CONTROL_SOCKET" -O check "$REMOTE_HOST" >/dev/null 2>&1; then
    printf 'The SSH control connection closed while opening the local tunnel.\n' >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 "http://127.0.0.1:$LOCAL_PORT/" | grep -q '<div id="root"></div>' \
    && curl --silent --fail --max-time 1 "http://127.0.0.1:$LOCAL_PORT/api/config" >/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [[ "$attempt" -ge 40 ]]; then
  printf 'Timed out waiting for the app page through the local SSH tunnel. On Tamarindo, inspect ~/.cache/openchami-web-ui/app.log.\n' >&2
  exit 1
fi

console_url="http://127.0.0.1:$LOCAL_PORT"
printf '\nOpenCHAMI Console is ready: %s\n' "$console_url"
if command -v open >/dev/null 2>&1; then open "$console_url"; fi
printf 'Leave this terminal running. Press Ctrl-C to stop the tunnel and remote processes.\n'
while ssh -S "$CONTROL_SOCKET" -O check "$REMOTE_HOST" >/dev/null 2>&1; do
  sleep 2
done
printf 'The SSH control connection closed.\n' >&2
exit 1
