#!/bin/sh
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

say "registered TV inputs"
sh_tv "dumpsys tv_input_manager" > "$OUT/tv_input_manager.txt"
grep -iE 'inputId|dvbi|droidtv' "$OUT/tv_input_manager.txt" | head -20 || echo "(no inputs matched)"

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
