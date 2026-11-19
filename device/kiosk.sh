#!/usr/bin/env bash
# Start the desk's screen: cage (a Wayland kiosk compositor) running Chromium full-screen on the
# local UI. Run by lantern-kiosk.service as the unprivileged `kiosk` account on tty1.
#
# The service writes this boot's start URL (with its token) to /run/lantern/start-url; this waits
# for it, so the screen never shows an error page while the service is still starting.
set -euo pipefail

URL_FILE="${LANTERN_URL_FILE:-/run/lantern/start-url}"
for _ in $(seq 1 300); do
    [ -r "$URL_FILE" ] && break
    sleep 0.2
done
[ -r "$URL_FILE" ] || { echo "kiosk: no start URL at $URL_FILE after 60 s" >&2; exit 1; }
URL="$(head -n1 "$URL_FILE")"

BROWSER="$(command -v chromium || command -v chromium-browser)"
PROFILE="${XDG_RUNTIME_DIR:-/tmp}/lantern-chromium"   # in RAM: the browser writes nothing to the card
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

# Which way round the screen is (install.sh --rotate): 90 or 270 is landscape, 0 the native portrait.
ROTATE=90
# shellcheck disable=SC1091
[ -r /etc/lantern/display ] && . /etc/lantern/display
case "$ROTATE" in 0) TRANSFORM=normal ;; 90|180|270) TRANSFORM="$ROTATE" ;; *) TRANSFORM=90 ;; esac

# cage starts even before a keyboard or touch panel appears (the Keychron may be on the Mac's slot).
export WLR_LIBINPUT_NO_DEVICES=1
export XCURSOR_SIZE=1

# Inside cage: turn the output first (cage has no option of its own for it), then start Chromium,
# so the page opens at the turned size.
# shellcheck disable=SC2016
TURN='out="$(wlr-randr 2>/dev/null | awk "/^[^ ]/ {print \$1; exit}")"
if [ "$1" != normal ] && [ -n "$out" ]; then
    wlr-randr --output "$out" --transform "$1" || echo "kiosk: could not turn $out" >&2
fi
shift
exec "$@"'

exec cage -d -- /bin/sh -c "$TURN" turn "$TRANSFORM" "$BROWSER" \
    --kiosk --app="$URL" \
    --ozone-platform=wayland --enable-features=UseOzonePlatform \
    --force-device-scale-factor=2 \
    --user-data-dir="$PROFILE" --disk-cache-dir="$PROFILE/cache" \
    --noerrdialogs --disable-session-crashed-bubble --no-first-run --no-default-browser-check \
    --disable-features=Translate,MediaRouter,OverscrollHistoryNavigation \
    --overscroll-history-navigation=0 --disable-pinch \
    --autoplay-policy=no-user-gesture-required \
    --disable-component-update --disable-background-networking --disable-sync \
    --password-store=basic --check-for-update-interval=31536000 \
    --enable-gpu-rasterization --ignore-gpu-blocklist
