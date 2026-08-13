#!/usr/bin/env bash
# Build a native Fedora RPM from the electron-builder linux-unpacked output.
#
# electron-builder's own rpm target shells out to a bundled fpm whose vendored
# Ruby links against libcrypt.so.1, which Fedora 38+ no longer ships. Rather
# than install libxcrypt-compat system-wide (and depend on a compat shim), we
# build the RPM with real rpmbuild inside a Fedora container. The result is a
# first-class Fedora package with proper dependencies and a setuid sandbox.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNPACKED="$ROOT/release/linux/linux-unpacked"
OUT="$ROOT/release/linux"
VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
FEDORA_IMAGE="${FEDORA_IMAGE:-fedora:41}"

[[ -d "$UNPACKED" ]] || { echo "Missing $UNPACKED -- run electron-builder --linux first"; exit 1; }

echo "==> Building Utility $VERSION RPM in $FEDORA_IMAGE"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/SOURCES" "$STAGE/SPECS"
tar -C "$ROOT/release/linux" -czf "$STAGE/SOURCES/utility-$VERSION.tar.gz" linux-unpacked
cp "$ROOT/apps/desktop/build/icon.png" "$STAGE/SOURCES/utility.png"

cat > "$STAGE/SPECS/utility.spec" <<SPEC
Name:           utility
Version:        $VERSION
Release:        1%{?dist}
Summary:        GST invoice digitisation and sales register export
License:        Proprietary
URL:            https://patienceai.in
Source0:        utility-%{version}.tar.gz
Source1:        utility.png
BuildArch:      x86_64
AutoReqProv:    no

Requires:       gtk3, libnotify, nss, libXScrnSaver, libXtst, xdg-utils, at-spi2-core, libuuid, alsa-lib

%description
Offline-first invoice digitisation for Indian GST accounting. Parses invoices,
validates them arithmetically, and exports a consolidated GST Sales Register.
Client financial data never leaves the machine.

a product of Patience AI.

# The payload contains a prebuilt Electron runtime and a PyInstaller bundle.
# Stripping or re-linking either corrupts them, so every post-build mangler is
# disabled deliberately.
%global __os_install_post %{nil}
%global debug_package %{nil}
%global __brp_strip %{nil}
%global __brp_strip_static_archive %{nil}
%global __brp_strip_comment_note %{nil}
%global __brp_check_rpaths %{nil}

%prep
%setup -q -c

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt/Utility
cp -a linux-unpacked/. %{buildroot}/opt/Utility/

mkdir -p %{buildroot}%{_bindir}
ln -sf /opt/Utility/utility-desktop %{buildroot}%{_bindir}/utility

mkdir -p %{buildroot}%{_datadir}/applications
cat > %{buildroot}%{_datadir}/applications/utility.desktop <<'DESKTOP'
[Desktop Entry]
Name=Utility
Comment=GST invoice digitisation by Patience AI
Exec=/opt/Utility/utility-desktop %U
Icon=utility
Terminal=false
Type=Application
Categories=Office;Finance;
StartupWMClass=Utility
DESKTOP

mkdir -p %{buildroot}%{_datadir}/icons/hicolor/512x512/apps
install -m 0644 %{SOURCE1} %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/utility.png

%files
%dir /opt/Utility
/opt/Utility
%{_bindir}/utility
%{_datadir}/applications/utility.desktop
%{_datadir}/icons/hicolor/512x512/apps/utility.png

%post
# Electron's sandbox helper must be setuid root or the app refuses to start
# with "SUID sandbox helper is not configured correctly".
chmod 4755 /opt/Utility/chrome-sandbox || :
update-desktop-database &>/dev/null || :

%postun
update-desktop-database &>/dev/null || :

%changelog
* Fri Aug 14 2026 Patience AI <support@patienceai.in> - $VERSION-1
- Phase 1/2: parsing core, validation gate, sales register export
SPEC

# The staging dir is mounted read-only and copied into the container's own
# filesystem before building. rpmbuild writes a lot of intermediate state, and
# doing that inside a bind mount fights both SELinux and uid mapping.
docker run --rm \
  -v "$STAGE:/src:ro,z" -v "$OUT:/out:z" \
  "$FEDORA_IMAGE" bash -euo pipefail -c '
    dnf install -q -y rpm-build >/dev/null 2>&1
    mkdir -p /work && cp -r /src/. /work/
    rpmbuild --define "_topdir /work" -bb /work/SPECS/utility.spec >/tmp/build.log 2>&1 || {
      tail -40 /tmp/build.log; exit 1; }
    cp /work/RPMS/x86_64/*.rpm /out/
    # rpmbuild runs as root in the container; hand the artifact back to the
    # invoking user so it is not left root-owned on the host.
    chown '"$(id -u):$(id -g)"' /out/*.rpm
    echo "built: $(ls /work/RPMS/x86_64/)"
  '

echo "==> RPM at $OUT/"
ls -lh "$OUT"/*.rpm
