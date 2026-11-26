# FreeShape Web — experimental serverless port

The browser loads Pyodide 0.29.5, NumPy, OCP.wasm 7.9.3.1 and the original
FreeShape Python source into a Web Worker. Three.js draws tessellated geometry.
nginx only serves files; no Python process, upload API or remote CAD computation
exists. Dependencies are vendored during image build.

## Deploy

Portainer Web editor: paste webcad/compose.yaml after the CI image is published.
The container listens at 8080, mapped to host 8086. The GHCR package may need
public visibility or registry authentication. To build without GHCR:

    git clone --branch experiment/browser-wasm https://github.com/mirivlad/FreeShape.git
    cd FreeShape
    docker build -f webcad/Dockerfile -t freeshape-web:local .
    docker run --rm -p 8086:8080 freeshape-web:local

Open http://HOST:8086. Reverse proxy the same port using HTTPS for offline
service-worker caching. No uploads or persistent container volumes required.
For an offline reload, press Offline cache once while connected; cache may
be evicted by the browser. Use Save .fshape for durable user-owned files.

## Acceptance

Demo: 40 x 30 x 10 mm, volume 12000 mm³. Select Extrude and set depth to 20;
volume must become 24000 mm³. Download .fshape, reopen it, export STEP/STL.
CI uses a real Chromium browser and disables networking after offline caching.

## Limits

Prototype, not full CAD: no browser sketch editing, assembly/drawing editing,
plugin or derived-document execution, persistent local project catalogue or
general feature creation. Existing Part Studios with supported operations
can be rebuilt; other operations may fail due to browser-specific OCP
or OS limitations. Use only trusted documents and keep backups. JSON mesh
transfer is intentionally simple; large projects may exhaust browser memory.
No claim of Firefox or other browser compatibility before testing.

FreeShape copyright and GPL-3.0-or-later retained. Runtime dependencies
retain their own licenses; upstream sources: Pyodide, NumPy, OCP.wasm,
OpenCascade, Three.js. See their upstream projects and distributed notices.
