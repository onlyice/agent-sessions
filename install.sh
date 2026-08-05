#!/bin/bash

set -euo pipefail

readonly REPO="onlyice/agent-sessions"
readonly APP_NAME="Agent Sessions"
readonly INSTALL_PATH="/Applications/${APP_NAME}.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: ${APP_NAME} can only be installed on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) asset_arch="arm64" ;;
  x86_64) asset_arch="x64" ;;
  *)
    echo "Error: unsupported Mac architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for command in curl hdiutil ditto xattr; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: required command not found: ${command}" >&2
    exit 1
  fi
done

echo "Finding the latest ${APP_NAME} release for ${asset_arch}…"
release_json="$(
  curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${REPO}/releases/latest"
)"

# Prefer an architecture-specific DMG. A DMG without an architecture suffix is
# accepted as a fallback for future universal builds.
asset_url="$(
  printf '%s\n' "$release_json" | awk -v arch="$asset_arch" '
    match($0, /"browser_download_url": "[^"]+\.dmg"/) {
      url = substr($0, RSTART + 25, RLENGTH - 26)
      if (url ~ ("-" arch "\\.dmg$")) {
        print url
        found = 1
        exit
      }
      if (url !~ /-(arm64|x64)\.dmg$/ && fallback == "") fallback = url
    }
    END { if (!found && fallback != "") print fallback }
  '
)"

if [[ -z "$asset_url" ]]; then
  echo "Error: the latest release does not include a ${asset_arch} DMG." >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-sessions-install.XXXXXX")"
mount_dir="${work_dir}/mount"
dmg_path="${work_dir}/${APP_NAME}.dmg"
mounted=false

cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir "$mount_dir"
echo "Downloading ${asset_url##*/}…"
curl -fL --progress-bar "$asset_url" -o "$dmg_path"

echo "Mounting disk image…"
hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg_path" >/dev/null
mounted=true

source_app="$(find "$mount_dir" -maxdepth 2 -type d -name "${APP_NAME}.app" -print -quit)"
if [[ -z "$source_app" ]]; then
  echo "Error: ${APP_NAME}.app was not found in the downloaded DMG." >&2
  exit 1
fi

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "Closing the running ${APP_NAME} app…"
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
  sleep 1
fi

echo "Installing ${APP_NAME} in /Applications…"
if [[ -w /Applications ]]; then
  rm -rf "$INSTALL_PATH"
  ditto "$source_app" "$INSTALL_PATH"
  xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
else
  echo "Administrator permission is required to write to /Applications."
  sudo rm -rf "$INSTALL_PATH"
  sudo ditto "$source_app" "$INSTALL_PATH"
  sudo xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
fi

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALL_PATH/Contents/Info.plist")"
echo "Installed ${APP_NAME} ${version}."
open "$INSTALL_PATH"
