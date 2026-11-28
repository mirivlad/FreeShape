# Browser CAD parity gate

A version number, successful compilation, or a visible tool button is not an
acceptance criterion. Before declaring a milestone complete or beginning the
next milestone, compare each in-scope desktop tool with its current native
implementation and dialog, and demonstrate parity for:

- all available parameters, modes, constraints, reference types and defaults;
- selection, hover, snapping, dragging, keyboard interaction, live feedback,
  automatic inference, editing and cancellation;
- expressions, variables, units, saved references and native document roundtrip;
- actual native geometry (not just the preview), errors and recovery, undo/redo;
- regressions of previous milestones, real browser interaction, offline use
  and successful CI.

List exact verified scenarios and remaining differences; any remaining material
difference keeps the milestone OPEN. Never advance to the next milestone while
the preceding one is open. A successful intermediate Docker publication does
not imply milestone closure.

## 0.3.11 acceptance

Scope: the existing extrude, revolve, fillet and chamfer tools, including
their native dialogs and behavior. Check the desktop schemas in
`freeshape/ui/dialogs.py` and native runners in `freeshape/features.py`.
The originally published 0.3.11 is an intermediate build, not proof of parity.

## 0.4.0 acceptance

Scope: sketch editing tools, not the entire CAD feature catalogue. Compare
`Sketcher._ops_click`, `Sketcher._prompt` and `freeshape/sketch_ops.py`.
Implemented: fillet, chamfer, offset, slot, mirror, linear/circular pattern,
transform and copy. Verification: `webcad/test_sketch_operations.py` checks
native geometry, constraints, preview isolation, invalid input and undo/redo;
`webcad/smoke.mjs` exercises real clicks, live inputs, cancel and saved native
features for the nine tools. Known interface difference: one anchored input
card with explicit confirmation instead of chained desktop popups. Large
patterns have a browser resource bound. Unverified or missing desktop
geometry types from prior stages are not made complete by this release.
