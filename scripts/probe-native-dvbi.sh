#!/bin/sh
#
# Probe the television's own DVB-I component, read-only.
#
#   sh scripts/probe-native-dvbi.sh <tv-ip>
#
# The Philips Android television carries org.droidtv.dvbi, a system package at
# /product/priv-app/dvbiservice which declares an android.media.tv.TvInputService
# and holds CHANNEL_WRITE and ACCESS_ALL_EPG_DATA. A TvInputService publishes
# channels into the platform's channel database, which is the list the set's own
# Live TV application shows and the list the remote's channel keys walk. So the
# component's job is to turn DVB-I services into channels of the television
# itself, rather than into rows inside an application.
#
# It was dormant when first seen: dumpsys tv_input_manager listed no input for
# it. The question this script answers is whether it can be pointed at a service
# list of our own, or whether the set only accepts lists from wherever the
# manufacturer configured.
#
# Everything here reads. Nothing is enabled, written or installed: a system
# priv-app is part of the television's own software, and changing it is neither
# needed to answer the question nor reversible from here.
#
# Both outcomes are worth having. If a third-party list cannot be loaded, that
# is a finding about closed native DVB-I clients. If one can be loaded but the
# linked application never starts, that is the stronger finding: the
# accessibility path in the service list goes unexercised even where a native
# DVB-I client ships.
set -e

TV_IP=$1
if [ -z "$TV_IP" ]; then
  echo "usage: sh scripts/probe-native-dvbi.sh <tv-ip>" >&2
  exit 2
fi

PORT=${TV_PORT:-5555}
OUT=${OUT_DIR:-probe-native-dvbi}
PKG=org.droidtv.dvbi

adb connect "$TV_IP:$PORT" >/dev/null 2>&1 || true
if ! adb -s "$TV_IP:$PORT" shell true >/dev/null 2>&1; then
  echo "Cannot reach $TV_IP:$PORT. Accept the debugging prompt on the TV, then re-run." >&2
  exit 1
fi

sh_tv() { adb -s "$TV_IP:$PORT" shell "$@" 2>/dev/null | tr -d '\r'; }

mkdir -p "$OUT"
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "package"
sh_tv "dumpsys package $PKG" > "$OUT/package.txt"
grep -E 'versionName|codePath|enabled=|flags=' "$OUT/package.txt" | head

say "declared components"
grep -E 'Action:|Service|Provider|Receiver' "$OUT/package.txt" | head -20

# An input only appears here once it has registered itself. Empty means the
# component is installed but not acting as a tuner, which is where it started.
say "registered TV inputs"
sh_tv "dumpsys tv_input_manager" > "$OUT/tv_input_manager.txt"
grep -iE 'inputId|dvbi|droidtv' "$OUT/tv_input_manager.txt" | head -20 || echo "(no inputs matched)"

# The channel database. Whatever a TvInputService publishes lands here, so this
# is where our services would show up if the component ever accepted our list.
say "channels currently in the platform database"
sh_tv "content query --uri content://android.media.tv/channel --projection _id:input_id:display_number:display_name" \
  > "$OUT/channels.txt" || true
head -20 "$OUT/channels.txt"

say "settings and properties mentioning dvbi"
{ sh_tv "settings list global"; sh_tv "settings list secure"; sh_tv "settings list system"; } \
  > "$OUT/settings.txt"
grep -i dvbi "$OUT/settings.txt" || echo "(none)"
sh_tv "getprop" > "$OUT/props.txt"
grep -iE 'dvbi|dvb_i|servicelist|countr' "$OUT/props.txt" | head -20 || echo "(none)"

# The interesting part: a DVB-I client has to learn a service list URL from
# somewhere. If it is compiled in, or read from a registry keyed by country, the
# string is in the package.
say "pulling the package for offline inspection"
APK_PATH=$(sh_tv "pm path $PKG" | sed 's/package://' | head -1)
if [ -n "$APK_PATH" ]; then
  adb -s "$TV_IP:$PORT" pull "$APK_PATH" "$OUT/dvbiservice.apk" >/dev/null 2>&1 \
    && echo "pulled $APK_PATH -> $OUT/dvbiservice.apk" \
    || echo "could not pull $APK_PATH (readable only to the system)"
fi

if [ -f "$OUT/dvbiservice.apk" ]; then
  say "URLs and list-shaped strings inside the package"
  strings "$OUT/dvbiservice.apk" 2>/dev/null \
    | grep -iE 'https?://|servicelist|ServiceList|registry|\.xml' \
    | sort -u | head -40 || echo "(none found; the APK is compressed, try apktool)"
fi

say "done"
echo "Everything read is under $OUT/. Nothing on the television was changed."
