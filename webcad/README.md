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

## FreeShape Web 0.2.0

The workbench adds a local 2D sketch editor (line, rectangle, circle, arc,
point and construction geometry), local characteristic-point/intersection
snapping, a native solver on each committed edit, dimensions and selected
constraints, edit existing sketches, feature rename/suppress/delete, document
undo/redo, planar face selection, extrusion/revolution and edge fillet/chamfer.
The 3D viewport renders on demand and has no camera inertia. Model edges are
batched per body. Middle/right drag pans; left drag orbits; click selects;
use Edges mode and Shift for multiple edge picks.

## Acceptance

Demo: 40 x 30 x 10 mm, volume 12000 mm³. Select Extrude and set depth to 20;
volume must become 24000 mm³. Download .fshape, reopen it, export STEP/STL.
CI uses a real Chromium browser and disables networking after offline caching.

## Limits

Prototype, not full CAD: no assembly/drawing editing, plugin or derived-document
execution, persistent local project catalogue, complete original tool/dialog parity,
or general feature editing. Sketch constraints cover a subset; selection is
entity-level, and there is no constrained point dragging yet. Current edge
picking is screen-space and may select an occluded edge. Arc preview is a polyline
until committed. Existing sketches with text/image entities do not render these
entities in the editor. Existing Part Studios with supported operations
can be rebuilt; other operations may fail due to browser-specific OCP
or OS limitations. Use only trusted documents and keep backups. JSON mesh
transfer is intentionally simple; large projects may exhaust browser memory.
No claim of Firefox or other browser compatibility before testing.

FreeShape copyright and GPL-3.0-or-later retained. Runtime dependencies
retain their own licenses; upstream sources: Pyodide, NumPy, OCP.wasm,
OpenCascade, Three.js. See their upstream projects and distributed notices.

## 0.3.0

Separate worker request correlation IDs from feature/point IDs. Added point selection and drag-on-release with native weighted solve, sketch undo/redo, editable numeric dimensions, constraint deletion, point coincidence/fix/point-on/midpoint/concentric and horizontal/vertical dimensions. Drag feedback is a local marker, not continuous constrained geometry preview. Tests exercise dimension edits and sketch history. Feature parity remains incomplete.
