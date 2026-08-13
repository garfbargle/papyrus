#!/usr/bin/env bash
#
# Papyrus — build the current checkout and install it on this Mac and on any
# connected Android phone.
#
#   ./scripts/deploy-local.sh            # both
#   ./scripts/deploy-local.sh mac        # macOS only
#   ./scripts/deploy-local.sh android    # Android only
#
# This is local sideloading only — it does not touch notes.c0di.com or the sync
# relay (that's `npm run deploy:all`).
#
# Environment overrides:
#   ANDROID_ABI=aarch64      Rust/Android target to build (default aarch64)
#   INCLUDE_EMULATORS=1      Also install to running emulators
#   NDK_HOME=/path/to/ndk    Pin a specific NDK

set -euo pipefail

TARGET="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ANDROID_ABI="${ANDROID_ABI:-aarch64}"
KEYSTORE="$HOME/.papyrus/android-release.jks"
KEYSTORE_PASS_FILE="$HOME/.papyrus/android-release.pass"
KEY_ALIAS="papyrus"

bold() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗  %s\033[0m\n' "$1" >&2; exit 1; }

case "$TARGET" in
  all|mac|macos|android) ;;
  *) die "unknown target '$TARGET' (expected: all, mac, android)" ;;
esac

# ── macOS ─────────────────────────────────────────────────────────────────────
deploy_mac() {
  bold "Building Papyrus.app (release)"
  npx tauri build --bundles app

  local built="src-tauri/target/release/bundle/macos/Papyrus.app"
  [ -d "$built" ] || die "expected bundle at $built"

  # Quit a running copy so we're not swapping the bundle out from under it.
  # The user-facing app is named Papyrus, but the bundled executable is
  # lowercase `papyrus`. Match the actual process so an update never replaces
  # the bundle under a still-running WebView (which can leave it blank).
  if pgrep -x papyrus >/dev/null 2>&1; then
    bold "Quitting the running Papyrus"
    osascript -e 'tell application "Papyrus" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      pgrep -x papyrus >/dev/null 2>&1 || break
      sleep 0.5
    done
    pgrep -x papyrus >/dev/null 2>&1 && pkill -x papyrus || true
  fi

  bold "Installing to /Applications/Papyrus.app"
  rm -rf "/Applications/Papyrus.app"
  ditto "$built" "/Applications/Papyrus.app"
  xattr -dr com.apple.quarantine "/Applications/Papyrus.app" 2>/dev/null || true
  echo "   installed $(defaults read /Applications/Papyrus.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '?')"
}

# ── Android ───────────────────────────────────────────────────────────────────
setup_android_env() {
  if [ -z "${JAVA_HOME:-}" ] || ! "${JAVA_HOME}/bin/java" -version 2>&1 | grep -q '"17'; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)" \
      || die "JDK 17 not found — the Android Gradle Plugin needs it (brew install --cask temurin@17)"
    export JAVA_HOME
  fi

  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  [ -d "$ANDROID_HOME" ] || die "Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)"

  if [ -z "${NDK_HOME:-}" ]; then
    # Prefer r27 (what Tauri 2 is tested against), else the newest installed.
    NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/27.* 2>/dev/null | sort -V | tail -1)"
    [ -n "$NDK_HOME" ] || NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
    [ -n "$NDK_HOME" ] || die "no NDK found under $ANDROID_HOME/ndk (install one via Android Studio)"
    export NDK_HOME
  fi

  export PATH="$ANDROID_HOME/platform-tools:$PATH"
  command -v adb >/dev/null || die "adb not on PATH"

  BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)"
  [ -n "$BUILD_TOOLS" ] || die "no build-tools found under $ANDROID_HOME/build-tools"
}

# A dedicated signing key, created once. Deliberately *not* the Android Studio
# debug keystore: that one gets regenerated, and a changed signature means every
# future update fails until the app is uninstalled (taking local notes with it).
ensure_keystore() {
  [ -f "$KEYSTORE" ] && return

  bold "Creating a signing key at $KEYSTORE (first run only)"
  mkdir -p "$(dirname "$KEYSTORE")"
  umask 077
  # No pipe into `head` here: it exits early, SIGPIPEs the writer, and `pipefail`
  # would fail the script with 141. The trailing newline is required — apksigner
  # reads a password file as a terminated line and errors with "end of file
  # reached" without it. keytool and apksigner both strip it.
  printf '%s\n' "$(openssl rand -hex 24)" > "$KEYSTORE_PASS_FILE"
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" -storepass:file "$KEYSTORE_PASS_FILE" \
    -keypass:file "$KEYSTORE_PASS_FILE" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10950 \
    -dname "CN=Papyrus, OU=Local Build, O=Papyrus, C=US" >/dev/null
  warn "Back up $KEYSTORE — without it you cannot update an installed Papyrus in place."
}

# Physical devices only unless INCLUDE_EMULATORS=1, de-duplicated by hardware
# serial (one phone shows up twice when it's paired over both USB and Wi-Fi).
connected_devices() {
  local seen="" id serial
  while read -r id state _; do
    [ "$state" = "device" ] || continue
    case "$id" in
      emulator-*) [ "${INCLUDE_EMULATORS:-0}" = "1" ] || continue ;;
    esac
    serial="$(adb -s "$id" shell getprop ro.serialno 2>/dev/null | tr -d '\r\n')" || continue
    [ -n "$serial" ] || continue
    case " $seen " in *" $serial "*) continue ;; esac
    seen="$seen $serial"
    echo "$id"
  done < <(adb devices | tail -n +2)
}

deploy_android() {
  setup_android_env

  # These three Kotlin files live under directories named `notes`, which an
  # unanchored `Notes/` in .gitignore used to match (git is case-insensitive on
  # macOS), so they went missing from fresh clones. MainActivity.kt is the one
  # that matters: it is hand-edited (ndk-context init for the keyring, window
  # inset publishing), and `tauri android init` overwrites it with boilerplate
  # that crashes on launch. Fail loudly rather than silently shipping that.
  local missing=""
  for f in \
    src-tauri/gen/android/app/src/main/java/com/papyrus/notes/MainActivity.kt \
    src-tauri/gen/android/buildSrc/src/main/java/com/papyrus/notes/kotlin/RustPlugin.kt \
    src-tauri/gen/android/buildSrc/src/main/java/com/papyrus/notes/kotlin/BuildTask.kt
  do
    [ -f "$f" ] || missing="$missing\n    $f"
  done
  if [ -n "$missing" ]; then
    printf '\033[31m✗  Android project is incomplete — missing:%b\033[0m\n' "$missing" >&2
    die "Restore these from a checkout that has them. Do NOT just run
    'tauri android init': it regenerates MainActivity.kt without the keyring
    and safe-area fixes, and overwrites the app icons."
  fi

  if ! grep -q 'initializeNdkContext' \
      src-tauri/gen/android/app/src/main/java/com/papyrus/notes/MainActivity.kt; then
    die "MainActivity.kt is missing Keyring.initializeNdkContext() — this build
    would crash on launch. It has probably been overwritten by 'tauri android init'."
  fi

  bold "Building the Android APK (release, $ANDROID_ABI)"
  echo "   JAVA_HOME=$JAVA_HOME"
  echo "   NDK_HOME=$NDK_HOME"
  npx tauri android build --apk --target "$ANDROID_ABI"

  local unsigned
  unsigned="$(find src-tauri/gen/android/app/build/outputs/apk -name '*-release-unsigned.apk' -print0 \
    | xargs -0 ls -t 2>/dev/null | head -1)"
  [ -n "$unsigned" ] || die "no release APK produced under src-tauri/gen/android/app/build/outputs/apk"

  ensure_keystore

  bold "Signing $(basename "$unsigned")"
  local aligned="${unsigned%-unsigned.apk}-aligned.apk"
  local signed="${unsigned%-unsigned.apk}-signed.apk"
  "$BUILD_TOOLS/zipalign" -p -f 4 "$unsigned" "$aligned"
  # No --key-pass: it defaults to the keystore password, and pointing both at the
  # same file makes apksigner look for a second line that isn't there.
  "$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE_PASS_FILE" \
    --ks-key-alias "$KEY_ALIAS" \
    --out "$signed" "$aligned"
  rm -f "$aligned" "$signed.idsig"
  echo "   $signed"

  local devices
  devices="$(connected_devices)"
  if [ -z "$devices" ]; then
    warn "No Android device connected — APK is built and signed at:"
    warn "  $signed"
    warn "Plug the phone in (or 'adb connect <ip>') and re-run: $0 android"
    return
  fi

  local id model
  while read -r id; do
    model="$(adb -s "$id" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')"
    bold "Installing to $model ($id)"
    if ! adb -s "$id" install -r -d "$signed"; then
      warn "Install failed on $model."
      warn "If it says SIGNATURE or UPDATE_INCOMPATIBLE, a copy signed with a"
      warn "different key is already installed. Export your notes first, then:"
      warn "  adb -s $id uninstall com.papyrus.notes"
      die "install failed"
    fi
  done <<< "$devices"
}

# ── Run ───────────────────────────────────────────────────────────────────────
START=$SECONDS
case "$TARGET" in
  mac|macos) deploy_mac ;;
  android)   deploy_android ;;
  all)       deploy_mac; deploy_android ;;
esac
printf '\n\033[32m✓ Done in %dm%02ds\033[0m\n' $(( (SECONDS-START)/60 )) $(( (SECONDS-START)%60 ))
