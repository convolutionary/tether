#!/bin/sh
# Build Tether and install it for the current user (no root): ~/.local/bin, the app launcher, icons.
# Run again to update. `scripts/install-local.sh --uninstall` removes it (saved sessions stay).
set -eu
cd "$(dirname "$0")/.."
BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN/tether" "$APPS/tether.desktop"
  for s in 32x32 128x128 256x256 512x512 scalable; do rm -f "$ICONS/$s/apps/tether."*; done
  update-desktop-database "$APPS" 2>/dev/null || true
  echo "Tether removed. Sessions and settings are still in ~/.config/dev.convolutionary.tether"
  exit 0
fi

[ "${1:-}" = "--no-build" ] || npx tauri build --no-bundle

mkdir -p "$BIN" "$APPS"
install -m 755 target/release/tether "$BIN/tether.new" && mv -f "$BIN/tether.new" "$BIN/tether"
install -Dm 644 src-tauri/icons/32x32.png "$ICONS/32x32/apps/tether.png"
install -Dm 644 src-tauri/icons/128x128.png "$ICONS/128x128/apps/tether.png"
install -Dm 644 src-tauri/icons/128x128@2x.png "$ICONS/256x256/apps/tether.png"
install -Dm 644 src-tauri/icons/icon.png "$ICONS/512x512/apps/tether.png"
install -Dm 644 assets/icon.svg "$ICONS/scalable/apps/tether.svg"

cat > "$APPS/tether.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Tether
GenericName=Remote sessions
Comment=SSH, SFTP, RDP, VNC, serial and tunnels in one window
Exec=$BIN/tether %U
Icon=tether
Terminal=false
Categories=Network;RemoteAccess;System;TerminalEmulator;
Keywords=ssh;sftp;rdp;vnc;serial;telnet;mosh;terminal;mobaxterm;putty;tunnel;
StartupWMClass=tether
StartupNotify=true
MimeType=x-scheme-handler/ssh;x-scheme-handler/sftp;
DESKTOP

update-desktop-database "$APPS" 2>/dev/null || true
[ -f "$ICONS/icon-theme.cache" ] && gtk-update-icon-cache -q "$ICONS" 2>/dev/null || true  # refresh, never create, a cache
echo "Tether installed: $BIN/tether, and in the app launcher."
