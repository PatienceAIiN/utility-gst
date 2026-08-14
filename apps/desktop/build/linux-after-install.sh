#!/bin/bash
# Electron's sandbox helper must be setuid root or the app refuses to start with
# "SUID sandbox helper is not configured correctly". electron-builder does not
# set this for rpm or deb, so a fresh install fails on first launch without it.
set -e
TARGET="/opt/Utility/chrome-sandbox"
if [ -f "$TARGET" ]; then
  chown root:root "$TARGET" || true
  chmod 4755 "$TARGET" || true
fi
# Refresh the desktop database so the launcher appears without a re-login.
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true
exit 0
