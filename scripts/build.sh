#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 [android|ios|all] (default: all)"
  exit 1
}

TARGET="${1:-all}"

build_android() {
  echo "==> Building Android APKs..."
  cd "$ROOT/android"
  ./gradlew assembleDebug assembleDebugAndroidTest --quiet
  echo "==> Copying Android artifacts to drivers/"
  cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/drivers/android/"
  cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk "$ROOT/drivers/android/"
  echo "    done."
}

build_ios() {
  echo "==> Building iOS test bundle..."
  cd "$ROOT/ios"
  xcodebuild build-for-testing \
    -project UITreeServer.xcodeproj \
    -scheme UITreeServerUITests \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath DerivedData \
    -quiet
  echo "==> Copying iOS artifacts to drivers/"
  rm -rf "$ROOT/drivers/ios/Debug-iphonesimulator"
  cp -R DerivedData/Build/Products/Debug-iphonesimulator "$ROOT/drivers/ios/"
  cp DerivedData/Build/Products/*.xctestrun "$ROOT/drivers/ios/"
  echo "    done."
}

bundle() {
  echo "==> Bundling server for Node..."
  cd "$ROOT"
  bun build src/server/index.ts --target node --outfile bin/cli.js --quiet
  printf '#!/usr/bin/env node\n%s' "$(cat bin/cli.js)" > bin/cli.js
  chmod +x bin/cli.js
  echo "    done."
}

pack() {
  echo "==> Packing tarball..."
  cd "$ROOT"
  npm pack --quiet 2>/dev/null
  TARBALL=$(ls -t mobile-device-mcp-*.tgz | head -1)
  echo "    $TARBALL"
}

case "$TARGET" in
  android) build_android; bundle; pack ;;
  ios)     build_ios; bundle; pack ;;
  all)     build_android; build_ios; bundle; pack ;;
  *)       usage ;;
esac

echo "==> Done. Restart Claude Code to pick up the new tarball."
