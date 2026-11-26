#!/usr/bin/env bash
# Build a self-contained native DEB from FreeShape's existing PyInstaller bundle.
# Usage: PYTHON=python3 bash packaging/linux/build_deb.sh
# Requires: Python 3.10-3.13, requirements.txt, pyinstaller, dpkg-deb.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
REV="$("$PY" -c 'import freeshape; print(freeshape.__version__)')"
ARCH="$(dpkg --print-architecture)"
if [ "$ARCH" != "amd64" ]; then
    echo "Only amd64 is currently supported (got $ARCH)." >&2
    exit 1
fi

BUNDLE="$ROOT/build/deb-dist/FreeShape"
if [ "${FREESHAPE_REUSE_BUNDLE:-0}" != "1" ]; then
    echo "[FreeShape] Building frozen application for Debian / Ubuntu..."
    "$PY" -m PyInstaller packaging/freeshape.spec --noconfirm --clean \
        --distpath build/deb-dist --workpath build/deb-work
fi
if [ ! -x "$BUNDLE/FreeShape" ]; then
    echo "Missing bundled application: $BUNDLE/FreeShape" >&2
    exit 1
fi
mkdir -p build
SELFTEST="$ROOT/build/deb-selftest.txt"
rm -f "$SELFTEST"
if ! "$BUNDLE/FreeShape" --self-test "$SELFTEST"; then
    cat "$SELFTEST" 2>/dev/null || true
    echo "[FreeShape] Frozen application self-test failed." >&2
    exit 1
fi
grep -qx OK "$SELFTEST"

STAGE="$ROOT/build/deb-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/freeshape" "$STAGE/usr/bin" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps" \
    "$STAGE/usr/share/mime/packages" "$STAGE/usr/share/doc/freeshape"

cp -a "$BUNDLE/." "$STAGE/opt/freeshape/"
# Driver stacks are specific to the target machine; use host OpenGL/X11/Wayland.
# This follows packaging/linux/build_appimage.sh's driver-library exclusions.
find "$STAGE/opt/freeshape" -type f \( \
    -name 'libGL.so*' -o -name 'libGLX*.so*' -o -name 'libEGL.so*' \
    -o -name 'libGLdispatch.so*' -o -name 'libdrm.so*' \
    -o -name 'libgbm.so*' -o -name 'libxcb.so*' -o -name 'libX11.so*' \
    -o -name 'libwayland-client.so*' -o -name 'libstdc++.so*' \
    -o -name 'libgcc_s.so*' \) -delete
# Remove matching symlinks as well to avoid dangling linker paths.
find "$STAGE/opt/freeshape" -type l \( \
    -name 'libGL.so*' -o -name 'libGLX*.so*' -o -name 'libEGL.so*' \
    -o -name 'libGLdispatch.so*' -o -name 'libdrm.so*' \
    -o -name 'libgbm.so*' -o -name 'libxcb.so*' -o -name 'libX11.so*' \
    -o -name 'libwayland-client.so*' -o -name 'libstdc++.so*' \
    -o -name 'libgcc_s.so*' \) -delete

install -m 0755 packaging/linux/freeshape-launcher "$STAGE/usr/bin/freeshape"
sed 's/^Exec=.*/Exec=freeshape %F/' packaging/linux/freeshape.desktop \
    > "$STAGE/usr/share/applications/freeshape.desktop"
install -m 0644 freeshape/assets/logo_256.png \
    "$STAGE/usr/share/icons/hicolor/256x256/apps/freeshape.png"
install -m 0644 packaging/linux/freeshape.xml \
    "$STAGE/usr/share/mime/packages/freeshape.xml"
install -m 0644 LICENSE "$STAGE/usr/share/doc/freeshape/GPL-3.0-or-later.txt"
install -m 0644 THIRD-PARTY-NOTICES.txt \
    "$STAGE/usr/share/doc/freeshape/THIRD-PARTY-NOTICES.txt"
cat > "$STAGE/usr/share/doc/freeshape/copyright" <<'COPYRIGHT'
FreeShape (C) 2026 Richard Willmott
Copyright and licensing information: see GPL-3.0-or-later.txt and
THIRD-PARTY-NOTICES.txt in this directory.
Main project: https://github.com/richiewillmott/FreeShape
License: GPL-3.0-or-later
COPYRIGHT

cat > "$STAGE/DEBIAN/control" <<CONTROL
Package: freeshape
Version: $REV-4~snap1
Section: graphics
Priority: optional
Architecture: $ARCH
Maintainer: FreeShape Linux Packaging <742619+mirivlad@users.noreply.github.com>
Depends: libc6 (>= 2.35), libgl1, libegl1, libopengl0, libxkbcommon0, libxkbcommon-x11-0, libxcb-cursor0, libxcb-icccm4, libxcb-keysyms1, libxcb-randr0, libxcb-render-util0, libxcb-shape0, libxcb-xinerama0, libfontconfig1, libdbus-1-3
Description: Offline parametric CAD with Onshape-style modelling
 FreeShape supports Part Studios, sketches, assemblies, drawings,
 sheet metal, STEP, STL, and a history-based feature workflow.
 This binary package bundles the Python and CAD runtime under /opt.
CONTROL

# Keep payload ownership normal even when invoked by an unprivileged user.
mkdir -p dist
OUT="$ROOT/dist/freeshape_${REV}-4~snap1_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"
echo "[FreeShape] Built $OUT"
dpkg-deb --field "$OUT" Package Version Architecture
