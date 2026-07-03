#!/bin/bash
# Build a double-clickable Undiscord.app from the SwiftPM executable.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building release binary..."
swift build -c release

BIN=".build/release/UndiscordApp"
RESBUNDLE=".build/release/UndiscordApp_UndiscordApp.bundle"
APP="Undiscord.app"

echo "==> Assembling ${APP} ..."
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

cp "${BIN}" "${APP}/Contents/MacOS/Undiscord"

# The SwiftPM resource bundle (holds undiscord.js) must be findable by Bundle.module.
# Put it where Bundle.main looks (Resources) and next to the executable, to be safe.
cp -R "${RESBUNDLE}" "${APP}/Contents/Resources/"
cp -R "${RESBUNDLE}" "${APP}/Contents/MacOS/"

# App icon
if [ -f icon/Undiscord.icns ]; then
  cp icon/Undiscord.icns "${APP}/Contents/Resources/Undiscord.icns"
fi

cat > "${APP}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>Undiscord</string>
    <key>CFBundleDisplayName</key>     <string>Undiscord</string>
    <key>CFBundleIdentifier</key>      <string>com.josemsalcedoq.undiscord</string>
    <key>CFBundleExecutable</key>      <string>Undiscord</string>
    <key>CFBundleIconFile</key>        <string>Undiscord</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleShortVersionString</key> <string>0.3.0</string>
    <key>CFBundleVersion</key>         <string>3</string>
    <key>CFBundleInfoDictionaryVersion</key> <string>6.0</string>
    <key>LSMinimumSystemVersion</key>  <string>12.0</string>
    <key>NSHighResolutionCapable</key> <true/>
    <key>LSApplicationCategoryType</key> <string>public.app-category.utilities</string>
</dict>
</plist>
PLIST

# Ad-hoc code signature so macOS treats it as a stable app identity (no paid cert needed).
if codesign --force --deep --sign - "${APP}" >/dev/null 2>&1; then
  echo "==> Ad-hoc signed."
else
  echo "==> (codesign skipped)"
fi

echo "==> Done: $(pwd)/${APP}"
echo "    Launch with:  open ${APP}"
