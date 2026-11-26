#!/usr/bin/env bash
# Structural smoke checks without root privileges.
set -euo pipefail
PKG="${1:?Usage: bash packaging/linux/test_deb.sh dist/freeshape_*.deb}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dpkg-deb --extract "$PKG" "$tmp"
test -x "$tmp/usr/bin/freeshape"
test -x "$tmp/opt/freeshape/FreeShape"
test -f "$tmp/usr/share/applications/freeshape.desktop"
test -f "$tmp/usr/share/mime/packages/freeshape.xml"
test -f "$tmp/usr/share/icons/hicolor/256x256/apps/freeshape.png"
test -f "$tmp/usr/share/doc/freeshape/GPL-3.0-or-later.txt"
# PyInstaller 6 puts the bundled package data under _internal.
test -f "$tmp/opt/freeshape/_internal/freeshape/locale/ru.json"
grep -q '"Save": "Сохранить"' "$tmp/opt/freeshape/_internal/freeshape/locale/ru.json"
grep -q '^GenericName\[ru\]=' "$tmp/usr/share/applications/freeshape.desktop"
grep -qx 'Exec=freeshape %F' "$tmp/usr/share/applications/freeshape.desktop"
grep -q 'application/x-freeshape-part' "$tmp/usr/share/mime/packages/freeshape.xml"
grep -q 'application/x-freeshape-assembly' "$tmp/usr/share/mime/packages/freeshape.xml"
grep -q 'application/x-freeshape-drawing' "$tmp/usr/share/mime/packages/freeshape.xml"
test "$(dpkg-deb --field "$PKG" Package)" = freeshape
test "$(dpkg-deb --field "$PKG" Architecture)" = amd64
echo "[FreeShape] DEB structure OK"
