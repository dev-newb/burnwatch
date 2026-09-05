#!/bin/bash
# Burnwatch macOS updater.
#
# Checks GitHub for a newer release tag; if there is one, rebuilds from source,
# replaces the installed .app, and relaunches it. Run either by the launchd
# agent from install.sh (headless, no Terminal) or by the app itself when the
# user clicks the update banner — in which case the app quits so this script
# can replace the bundle it was running from.
#
# Log: ~/Library/Logs/burnwatch-update.log

set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="I'm Burning!"
LOG="$HOME/Library/Logs/burnwatch-update.log"

# launchd hands scripts a bare PATH — node/npm/git live in these dirs, so a
# script that works in Terminal fails under launchd without this line.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Safe Storage's Keychain ACL depends on this signing identity. Sign by hash
# after packaging, avoiding ambiguous certificate names and ad-hoc installs.
sign_update_bundle() {
    local signature
    codesign --force --deep --sign 6414A85D915F112D91B0BE476AA9F1F735F165BE "$1" || return 1
    signature="$(codesign -dvv "$1" 2>&1)" || return 1
    if ! printf '%s\n' "$signature" | grep -Fxq 'Authority=Apple Development: rmcquail@gmail.com (7K7LZM5SAP)'; then
        echo "unexpected signing authority; refusing to replace the installed app"
        return 1
    fi
    codesign --verify --deep --strict "$1"
}

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date) ==="

# The app is closed during a rebuild, so progress has to surface somewhere.
notify() { osascript -e "display notification \"$1\" with title \"I'm Burning!\"" >/dev/null 2>&1; }

cd "$REPO_DIR" || { echo "repo not found at $REPO_DIR"; exit 1; }
command -v npm >/dev/null || { echo "npm not found — install Node.js from nodejs.org"; exit 1; }

# Prefer /Applications, fall back to ~/Applications if it is not writable.
DEST_DIR="/Applications"
[ -w "$DEST_DIR" ] || DEST_DIR="$HOME/Applications"
mkdir -p "$DEST_DIR"
APP_DEST="$DEST_DIR/${APP_NAME}.app"

git fetch --tags --quiet || echo "fetch failed (offline?) — continuing with local tags"
latest="$(git tag -l 'v*' --sort=-v:refname | head -1)"
current="$(git describe --tags --abbrev=0 2>/dev/null || echo none)"
echo "current=$current latest=$latest dest=$APP_DEST"

needs_build=0
if [ -n "$latest" ] && [ "$latest" != "$current" ]; then
    echo "updating $current -> $latest"
    notify "Updating to ${latest}…"
    git checkout --quiet "$latest" || { notify "Update failed (checkout)"; exit 1; }
    npm install --silent || { notify "Update failed (npm install)"; exit 1; }
    needs_build=1
elif [ ! -d "$APP_DEST" ]; then
    echo "app not installed yet — building"
    needs_build=1
else
    echo "already up to date"
fi

# A fresh clone is ALREADY sitting on the newest tag, so the branch above
# never fires and its npm install never runs — the first build would then be
# attempted with no node_modules at all. Install whenever they're missing.
if [ "$needs_build" = 1 ] && [ ! -d node_modules ]; then
    echo "installing dependencies"
    npm install --silent || { echo "npm install failed"; notify "Install failed (npm install)"; exit 1; }
fi

# npm 11's allow-scripts gate silently skips electron's postinstall, leaving
# node_modules/electron without its binary. Fetch it explicitly if absent.
if [ "$needs_build" = 1 ] && [ -d node_modules/electron ] && [ ! -d node_modules/electron/dist ]; then
    echo "fetching the electron binary (postinstall was skipped)"
    node node_modules/electron/install.js || {
        echo "electron download failed"; notify "Install failed (electron download)"; exit 1; }
fi

if [ "$needs_build" = 1 ]; then
    if [ "$(uname -m)" = "arm64" ]; then archflag="--arm64"; else archflag="--x64"; fi
    echo "building $archflag"
    # 'dir' target: just the .app, skipping the dmg — faster, and we install by copy.
    # Defer signing to the hash-pinned, verified step below.
    npx electron-builder --mac dir $archflag -c.mac.identity=null || {
        echo "build failed"
        notify "Update failed — see ~/Library/Logs/burnwatch-update.log"
        exit 1
    }

    built="$(find dist -maxdepth 2 -name "${APP_NAME}.app" -type d | head -1)"
    [ -n "$built" ] || { echo "build produced no .app"; notify "Update failed (no app built)"; exit 1; }
    echo "built: $built"
    sign_update_bundle "$built" || {
        echo "signature verification failed"
        notify "Update failed (signing)"
        exit 1
    }

    # The app may still be running — and may be the very bundle being replaced,
    # if the user started this from the update banner. Let it exit, then insist.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -f "${APP_DEST}/Contents/MacOS/" >/dev/null 2>&1 || break
        sleep 1
    done
    pkill -f "${APP_DEST}/Contents/MacOS/" 2>/dev/null && sleep 2

    rm -rf "$APP_DEST"
    cp -R "$built" "$APP_DEST" || {
        echo "install to $APP_DEST failed"
        notify "Update failed (could not replace the app)"
        exit 1
    }
    echo "installed $latest to $APP_DEST"
fi

open -a "$APP_DEST" && echo "launched"
