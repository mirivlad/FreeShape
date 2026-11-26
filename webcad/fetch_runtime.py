"""Vendor pinned browser dependencies during image build."""
import hashlib
import json
import pathlib
import urllib.request
import tarfile
import tempfile

ROOT = pathlib.Path("/site")
DEST = ROOT / "runtime"
DEST.mkdir(parents=True, exist_ok=True)
PYODIDE = "0.29.5"
OCP = "7.9.3.1.post202605192051"
THREE = "0.180.0"
CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE}/full/"


def download(url, target, sha=None):
    print("Download", url, flush=True)
    with urllib.request.urlopen(url, timeout=180) as response:
        data = response.read()
    if sha and hashlib.sha256(data).hexdigest() != sha:
        raise RuntimeError(f"Checksum mismatch: {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


for filename in ("pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm",
                 "python_stdlib.zip", "pyodide-lock.json"):
    download(CDN + filename, DEST / filename)
packages = json.loads((DEST / "pyodide-lock.json").read_text())["packages"]
done = set()


def vendor(name):
    name = name.lower().replace("_", "-")
    if name in done:
        return
    done.add(name)
    package = packages[name]
    for dep in package.get("depends", []):
        vendor(dep)
    filename = package["file_name"]
    download(CDN + filename, DEST / filename, package.get("sha256"))


for name in ("numpy", "micropip"):
    vendor(name)
with urllib.request.urlopen(f"https://pypi.org/pypi/cadquery-ocp-novtk-ocp-wasm/{OCP}/json", timeout=90) as response:
    info = json.load(response)
wheel = next(w for w in info["urls"] if "cp313-cp313-pyemscripten_2025_0_wasm32.whl" in w["filename"])
download(wheel["url"], DEST / wheel["filename"], wheel["digests"]["sha256"])
(ROOT / "runtime.json").write_text(json.dumps({"pyodide": PYODIDE, "ocp": OCP,
                                                "wheel": wheel["filename"], "three": THREE}))
with tempfile.TemporaryDirectory() as tmp:
    archive = pathlib.Path(tmp) / "three.tgz"
    download(f"https://registry.npmjs.org/three/-/three-{THREE}.tgz", archive)
    with tarfile.open(archive) as tar:
        for item in tar.getmembers():
            if item.isfile() and (item.name.startswith(("package/build/", "package/examples/jsm/controls/"))
                                  or item.name == "package/LICENSE"):
                dest = ROOT / "three" / item.name.removeprefix("package/")
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(tar.extractfile(item).read())
