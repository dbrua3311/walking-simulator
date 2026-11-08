#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_ROOT="${WALKING_STORAGE_ROOT:-/mnt/piper-usb/walking-simulator}"
for device_mount in /mnt/extra /mnt/piper-usb; do
  if ! mountpoint -q "$device_mount"; then
    echo "외부 저장 장치가 마운트되지 않았습니다: $device_mount" >&2
    exit 1
  fi
done
if [[ ! -d "$STORAGE_ROOT" ]]; then
  echo "전용 USB 저장 폴더가 없습니다: $STORAGE_ROOT" >&2
  exit 1
fi
storage_real="$(realpath -- "$STORAGE_ROOT")"
allowed_real="$(realpath -- /mnt/piper-usb/walking-simulator)"
if [[ "$storage_real" != "$allowed_real" && "$storage_real" != "$allowed_real/"* ]] ||
   [[ "$(stat -Lc %d -- "$STORAGE_ROOT")" != "$(stat -Lc %d -- /mnt/piper-usb)" ]]; then
  echo "Walking Simulator 전용 USB 경로만 사용할 수 있습니다: $STORAGE_ROOT" >&2
  exit 1
fi
if [[ -n "${WALKING_NODE_BIN:-}" ]]; then
  export PATH="$WALKING_NODE_BIN:$PATH"
elif ! command -v node >/dev/null; then
  shopt -s nullglob
  node_bins=(/mnt/extra/tools/nvm/versions/node/*/bin)
  if (( ${#node_bins[@]} == 0 )); then
    echo 'Node.js가 없습니다. 별도 파티션에 설치하고 WALKING_NODE_BIN을 지정하세요.' >&2
    exit 1
  fi
  export PATH="${node_bins[-1]}:$PATH"
fi
export WALKING_STORAGE_ROOT="$STORAGE_ROOT"
export npm_config_cache="$STORAGE_ROOT/cache/npm"
export PLAYWRIGHT_BROWSERS_PATH="$STORAGE_ROOT/cache/ms-playwright"
export XDG_CACHE_HOME="$STORAGE_ROOT/cache/xdg"
export TMPDIR="$STORAGE_ROOT/tmp"
mkdir -p "$npm_config_cache" "$PLAYWRIGHT_BROWSERS_PATH" "$XDG_CACHE_HOME" "$TMPDIR"
cd "$PROJECT_ROOT"
exec npm "$@"
