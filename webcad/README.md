# FreeShape Web — experimental serverless port

The browser loads Pyodide 0.29.5, NumPy, OCP.wasm 7.9.3.1 and the original
FreeShape Python source into a Web Worker. Three.js draws tessellated geometry.
nginx only serves files; no Python process, upload API or remote CAD computation
exists. Dependencies are vendored during image build.

## Deploy

For a local Git checkout on the `experiment/browser-wasm` branch, run from the repository root:

    ./update-web.sh

The script pulls from `origin` (fast-forward only), builds `freeshape-web:local`, replaces the local standalone container, checks `/healthz`, and prints the browser URL. It refuses to modify a Compose/Portainer-managed container and preserves the old container if the new one fails to start. Requires Bash, Git and access to a local Docker daemon. Defaults: `WEB_PORT=8086`, `WEB_CONTAINER=freeshape-web`, `WEB_IMAGE=freeshape-web:local`. Optionally set `WEB_URL` to print your reverse-proxy URL. Example: `WEB_PORT=8090 ./update-web.sh`. Existing local edits must be committed or stashed first.


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

## 0.3.1 workbench

Desktop-style menu, original QPainter icons exported at Docker build time, separate modeling/sketch toolbars, tree and parts list, floating operation dialogs. No startup demo or architectural footer. Diagnostics are in Tools. Right drag rotates; middle drag pans; left click selects. Assembly and drawing editors are not implemented. The under-constrained rectangle smoke check uses solved dimensions rather than assuming the un-dimensioned height stays fixed.

## 0.3.2

Finishing a new empty sketch discards the draft without adding a feature or undo entry, matching desktop behavior. Existing sketches can still be saved after edits, including deletion of geometry. Python tracebacks are logged in the browser developer console; the workspace displays concise errors. Regression tests cover empty finish/cancel and cancel of an existing sketch.

## 0.3.3

Sketch length, X/Y and circular dimensions have viewport dimension lines and editable labels, with Escape to cancel. Solid creation uses the native preview API with debounced requests and stale-result rejection. Preview geometry is separate from committed bodies and does not create undo entries. The committed geometry is still rebuilt by the native feature operation. Angular annotations and custom placement of dimension lines are not included yet.

## 0.3.4

Fixed dimension labels remaining disabled after solving. Closed sketch areas are tessellated from native OpenCascade faces, shown in the sketch editor (toggle Show sketch regions) and in the 3D viewport for the active sketch. While creating an extrusion or revolution, click an area to select it; Shift-click toggles it. Checkboxes remain synchronized. Region IDs follow the native region list and persistent feature references still use native signatures. Tests exercise viewport selection and preview cancellation.

The centre rectangle tool matches the desktop construction: four constrained sides plus a construction diagonal with a midpoint constraint. The diagonal is excluded from solid profiles but remains available for snapping. Regression tests also cover multiple independent sketch regions and extrusion of only one selected region.


## 0.3.5

The sketch toolbar now includes native ellipses (centre, first axis endpoint,
second radius), inscribed and circumscribed regular polygons (3–64 sides),
and interpolating splines (open or closed, up to 128 points). Polygons use the
desktop sketch operations, equal-length constraints and construction circles,
including orientation snapping. Ellipses expose their second radius/diameter
and a construction axis for dimensioning. New tools support construction mode,
sketch history and native closed-region extrusion. Spline construction uses a
local control polyline until committed; the actual curve is generated by OCP.
Ellipse point-on snapping uses a sampled cursor candidate and the native solver;
ellipse intersections and spline point-on constraints are not implemented.
Ellipse arcs, trimming, offsets, mirror and sketch fillets remain future work.

Native regression: `python -m unittest -v webcad.test_sketch_tools`.
The Chromium smoke suite additionally exercises each new tool through clicks,
undo/redo, saving the native profile, and extrusion.


## 0.3.6

Sketch editing tools: trim a line between its neighbouring line/circle/arc
intersections, split a line or arc using the desktop kernel operation, and
extend a line or arc to the next curve. Tool hints, hover highlighting, cut
point/end markers, undo/redo and rollback on failure. Trim retains surviving
endpoints and horizontal/vertical constraints, and adds point-on constraints at
cuts; other constraints referring to the original trimmed entity are removed.
Trim of curves other than lines is not yet supported. Trim with no intersections
removes the entire line, like desktop FreeShape. Helper geometry cannot be edited
with these tools. Region selection now displays exact native face area;
the selective-extrusion test compares the result to the solved region area
rather than nominal click coordinates.


Compatibility correction: OCP 7.x collection names are supported alongside
OCP 8.x, so spline interpolation and control-point splines can use the native
kernel in either environment. Failed generation of sketch display geometry
now rolls back the edit before adding any undo entry.


## 0.3.7 — drawing interaction parity

Line tool chains shared endpoints until Escape, tool change or closure onto an
existing point. Optional drawing dimensions are offered for line length,
rectangle width/height, circle diameter, ellipse minor radius and regular
polygon diameter (across flats for circumscribed polygons). Confirm with
Enter; continuing to draw or Escape dismisses the offer without adding a
constraint. Each accepted dimension has its own undo step. Three-point arcs
now use desktop click order (start, end, point on arc), keep the third point
as native constrained geometry and show a true circular preview. Interpolating
splines close on the first point or finish on double-click/Enter, and the
debounced cursor preview uses the native OCP curve without editing history.
Advanced smart-inference (tangent, parallel, equal-circle and model-derived
references), expressions/variables, constraint and selection parity are separate
milestones; this release does not claim those capabilities.

## 0.3.8 — geometric constraint parity

Manual geometric constraints now accept desktop-style combinations: tangent
(line/circular curve or internal/external circular pairs), normal (including
ellipses), symmetry (points, lines, circular curves about a line), equal radii,
coincidence, concentricity, group fixation and horizontal/vertical replacement.
Point-on and arc midpoint remain supported. Select first with Shift, or choose
a constraint then pick objects. New original toolbar icons, selection hints,
constraint list glyphs and hover highlighting. Uses the native solver, preserves
undo/redo, rejects invalid picks and rolls back unsatisfiable new constraints.
Exact feasible point dragging uses a temporary constraint, with weighted
fallback for constrained targets. No temporary constraint is persisted.
Automatic inference and viewport dimension placement remain separate milestones.

## 0.3.9 — smart snapping

Hover over characteristic points to awaken up to eight alignment sources, or
over curves to awaken direction/equal-size references. Horizontal and vertical
guides can combine and intersect finite sketch/model edges. Virtual rectangle
centres and midpoint/intersection sources become real constrained sketch
geometry only on commit. Native solver applies inferred parallel,
perpendicular, equal length/radius and tangent constraints. Model edges are
cached from the state before the sketch, filtered to its plane; corners and
midpoints are fixed references, straight/circular edges are fixed construction
helpers reused within the sketch. Arbitrary model curves use a sampled fixed
point, matching the desktop fallback. Shift disables snapping temporarily;
the sketch panel also exposes snapping, characteristic points, guides and
relations switches. Model references are static projections as in desktop,
not associative external links. Automatic intersection with ellipses/splines
and live constrained dragging remain outside this milestone.

## 0.3.10 — sketch interaction parity

Window selection (left-to-right) encloses complete objects; crossing selection
(right-to-left) includes intersected curves, with Shift/Ctrl additive selection.
Dragging points, lines and other curves previews native solved geometry using a
single in-flight worker request; circles resize from the rim. The final drag
is one undo step. Dimension labels can be dragged to persisted sketch positions
or clicked to edit. Angle and point-to-line dimensions, an automatic dimension
tool (D), numeric expressions and named document variables are supported.
Create or edit a variable in the Tools menu before editing a sketch; expressions
such as #width + 5 mm remain native and re-evaluate on rebuild. Full desktop dimension interaction is not yet implemented.

## 0.3.10.1 — inline variables

All sketch dimension fields complete existing variables, including partial
tokens within expressions. Use arrows and Enter/Tab or click a suggestion.
Entering one unknown #name offers to create a length or angle variable with
the current dimension as the default value. Creation is staged in the sketch
transaction, available immediately to subsequent dimensions, and undoable
with the dimension. Cancel discards pending variables. Finishing the sketch
inserts native typed Measure Value features before it, as one document undo
step. Fixed variables remain editable in the existing variable menu.

## 0.3.11 — existing body feature dialogs

Extrude and revolve expose Solid, Surface and Thin, sketch regions across
multiple sketches, model faces, sketch curves and edges, merge scope and
separate bodies/colours. Extrude exposes blind/symmetric/through and up-to
ends, offsets, independent second end and draft. Revolve exposes world,
sketch-line and model-edge axes, full/one/two/symmetric and up-to ends.
Fillet supports variable radius; chamfer supports equal/two/angle, flip and
tangent propagation. Existing features can be reopened in their original
history context and edited atomically; cancel restores the final model.
All previews use the native kernel. Selection is available from the view
and enumerated reference lists; the lists also expose planes and vertices.

## 0.3.11.1 — body dialog interaction

Native automatic contact/scope and up-to direction inference; draggable
extrude and fillet arrows, click-to-flip revolve and up-to arrows; curve
preselection and connected chains; selection transfer between body modes;
unit-aware numeric expressions and inline typed variables; invalid reference
recovery and oversized-fillet diagnostics. Surface-only geometry contributes
zero to the solid volume metric. See PARITY_GATE.md for the acceptance gate;
publication alone does not close the milestone.

## 0.4.0 — sketch editing operations

Native corner fillet and equal-distance chamfer (including virtual sharp and
native constraints), signed chain/circle offset, two-centre straight slot,
mirror, linear and circular patterns, move/rotate and copy/rotate are now
available in the browser. The input card previews every edit against the
original sketch using the native solver; confirmation makes a single undoable
transaction. Existing expressions, document units and variable completion work
in numeric fields; fillet, chamfer and slot retain the native dimension
expression. Multi-value tools use a single anchored card with Enter to move
between fields, rather than separate desktop text popups. Esc cancels without
modifying geometry. Pattern requests have a bounded size (256 instances /
4096 selected-entity instances) to avoid exhausting the browser.
