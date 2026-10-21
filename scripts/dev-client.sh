#!/usr/bin/env sh
set -eu

# 每个客户端使用独立数据目录与端口；仍支持环境变量覆盖。
case "${1:-}" in
  1|2|3) client_id=$1 ;;
  *) echo "用法：sh scripts/dev-client.sh <1|2|3> [--help]" >&2; exit 1 ;;
esac
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR/.."

export PANTRY_USER_DATA="${PANTRY_USER_DATA:-/tmp/pantry-dev$client_id}"
export PANTRY_UDP_PORT="${PANTRY_UDP_PORT:-$((client_id * 10000 + 7878))}"
export PANTRY_TCP_PORT="${PANTRY_TCP_PORT:-$((client_id * 10000 + 7879))}"
case "$client_id" in
  1) peers="127.0.0.1:27878,127.0.0.1:37878" ;;
  2) peers="127.0.0.1:17878,127.0.0.1:37878" ;;
  3) peers="127.0.0.1:17878,127.0.0.1:27878" ;;
esac
export PANTRY_PEERS="${PANTRY_PEERS:-$peers}"

if [ "${2:-}" = "--help" ] || [ "${2:-}" = "-h" ]; then
  echo "用法：npm run dev:client$client_id"
  echo "客户端 $client_id：$PANTRY_USER_DATA，UDP $PANTRY_UDP_PORT，TCP $PANTRY_TCP_PORT，对端 $PANTRY_PEERS。"
  exit 0
fi

echo "启动茶话间客户端 $client_id：userData=$PANTRY_USER_DATA UDP=$PANTRY_UDP_PORT TCP=$PANTRY_TCP_PORT peers=$PANTRY_PEERS"
exec npm run dev
