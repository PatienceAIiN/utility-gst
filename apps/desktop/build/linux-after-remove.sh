#!/bin/bash
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true
exit 0
