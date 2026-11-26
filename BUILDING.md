# Building FreeShape

This is for people who want to run FreeShape from its source code, change it, or make the installers themselves.
To just **use** FreeShape, download it from the [latest release](https://github.com/richiewillmott/FreeShape/releases/latest)
instead — see the [README](README.md).

## Run from source

You need Python 3.10–3.13 (64-bit) from https://www.python.org. On Windows, tick "Add python.exe to PATH" when installing.

Then just start it — **the first run installs everything automatically**:

- **Windows:** double-click `run_freeshape.bat`
- **Mac / Linux:** run `./run_freeshape.sh` (or `python3 start.py`)

The first start creates a private `.venv` folder next to the app and downloads OpenCascade, Qt and the
other requirements (about 300 MB, a few minutes). After that it opens straight away. To open a file:
`python start.py examples/bracket.fshape`. To reinstall from scratch, delete the `.venv` folder.

If you'd rather manage it yourself: `pip install -r requirements.txt` then `python -m freeshape`.

## Make a Windows program (.exe)

Double-click **`build_exe.bat`** (Windows). It uses the same Python setup, then packs everything — OpenCascade,
Qt, the logo and icons — into **`dist\FreeShape\FreeShape.exe`**, which runs on any 64-bit Windows PC without
Python. It also makes **`dist\FreeShape-portable-2.1.0.zip`** (unzip anywhere and run). If
[Inno Setup](https://jrsoftware.org/isdl.php) (free) is installed it also builds **`dist\FreeShape-Setup-2.1.0.exe`**,
a normal installer with Start-menu and desktop shortcuts, FreeShape icons on `.fshape` / `.fasm` files
(double-click to open them) and FreeShape in "Open with" for STEP files. The first build takes 5–10 minutes;
the app folder is large (about 1 GB, mostly the geometry engine), the installer much smaller.

## Automatic builds on GitHub (Windows, Mac and Linux)

You don't need to build anything by hand: **publishing a release on GitHub** builds the Windows installer, the Mac
`.dmg` (Apple Silicon) and the Linux AppImage on GitHub's own computers, checks each one starts, and attaches all
three to the release (`.github/workflows/mac.yml`). **Actions → Build (Windows, Mac, Linux) → Run workflow** makes a
test build instead, with the files, a screenshot of FreeShape running on the Mac and the logs on a private
*Test builds* draft release (only you can see it). On a Mac of your own, `bash packaging/mac/build_mac.sh` builds the Mac app locally.

## Make a Debian / Ubuntu .deb

Use the same PyInstaller recipe as the AppImage, but install it as a proper Debian
package with an application-menu entry, native file associations and
`/usr/bin/freeshape`. The app itself is isolated in `/opt/freeshape`; no
system Python packages are changed and files under `$HOME` are not touched.

Build on **Ubuntu 22.04 amd64**, which has an older glibc than current Debian and
Ubuntu releases, with Python 3.10–3.13 and the Qt system libraries listed in
`.github/workflows/linux-deb.yml`:

```sh
python3 -m pip install -r requirements.txt "pyinstaller>=6.16"
PYTHON=python3 bash packaging/linux/build_deb.sh
bash packaging/linux/test_deb.sh dist/freeshape_*.deb
sudo apt install ./dist/freeshape_*.deb
freeshape
```

The package registers `.fshape`, `.fasm` and `.fdwg`, ships the app icon,
uses host OpenGL graphics libraries and is removed with `sudo apt remove freeshape`.
Source and license remain GPL-3.0-or-later. Do not try to wrap an AppImage as
a DEB: `build_deb.sh` packages the actual PyInstaller application directory.

`Linux DEB (Debian and Ubuntu)` in GitHub Actions builds the package on Ubuntu
22.04, performs a package install and an application self-test there, then
installs/tests it on Debian 12/13 and Ubuntu 24.04/26.04. A published
release attaches the DEB automatically. These checks do not replace a manual
desktop/OpenGL test on physical machines.

## Make a Linux AppImage

On Linux, with the requirements and PyInstaller installed (`python3 -m pip install -r requirements.txt pyinstaller`),
run **`bash packaging/linux/build_appimage.sh`**. It packs FreeShape, checks the packed app with its self-test and
makes **`dist/FreeShape-2.1.0-x86_64.AppImage`** (about 200 MB). An AppImage runs on Linux systems at least as new as the
one it was built on, so build on the oldest distro you want to support.

## Where things are in the code

```
freeshape/
  kernel.py      OpenCascade wrappers: extrude, revolve, booleans, fillet, shell, regions, tessellation, STEP/STL
  sketch.py      sketch model + constraint solver
  sketch_ops.py  sketch fillet, offset, slot, mirror and patterns
  expr.py        numbers with units, expressions and #variables
  measure.py     measurements between faces, edges and parts
  features.py    feature implementations and reference re-finding
  document.py    feature list, rollback, cached regeneration, undo/redo, save/load
  drawing.py     2D drawings: views (hidden-line removal), dimensions, title block, DXF export
  sheetmetal.py  sheet metal: panels and bends, flanges, exact flat patterns, flat-pattern DXF
  dxf.py         a small DXF (AutoCAD R12) writer
  assembly.py    assemblies: instances, mate connectors, the mate solver, interference, BOM, .fasm files
  ui/            Qt interface: viewport (OpenGL), sketcher, feature dialogs, panels, main window
tests/               headless tests (python -m pytest tests)
examples/            example documents (bracket, hinge assembly) and the scripts that build them
```

## Tests

`python -m pytest tests` runs the automatic tests (no window needed). They also run on every Mac build on GitHub.

### Fork DEB releases

The `mirivlad/FreeShape` fork publishes validated DEB packages and SHA-256 checksums under [GitHub Releases](https://github.com/mirivlad/FreeShape/releases). A master commit containing `[publish-deb]` requests a release after all distro checks pass; the Debian package revision must be increased before publishing another build of the same upstream version.
