#!/usr/bin/env sh
set -eu

case "${1:-}" in
  2|3) client_count=$1 ;;
  *) echo "用法：sh scripts/dev-clients.sh <2|3> [--help]" >&2; exit 1 ;;
esac
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)

if [ "${2:-}" = "--help" ] || [ "${2:-}" = "-h" ]; then
  echo "用法：npm run dev:$client_count"
  echo "一次性启动 $client_count 个客户端，Ctrl+C 结束。"
  exit 0
fi

dev_pids=""
cleanup() {
  if [ -n "$dev_pids" ]; then kill $dev_pids 2>/dev/null || true; fi
}
trap cleanup INT TERM EXIT

echo "一次性启动 $client_count 个茶话间客户端。按 Ctrl+C 结束。"
client_id=1
while [ "$client_id" -le "$client_count" ]; do
  sh "$SCRIPT_DIR/dev-client.sh" "$client_id" &
  dev_pids="$dev_pids $!"
  if [ "$client_id" -lt "$client_count" ]; then sleep 1; fi
  client_id=$((client_id + 1))
done
wait
