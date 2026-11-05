---
name: onshape
description: Work in Onshape with the user from their browser (chrome-devtools MCP + Onshape REST API in-page) — design 3D-printable parts and multi-part kits (builder script → real sketches/extrudes/planes/chamfers via API, in-place edits that keep part ids, tolerance test fits, assemblies with mates, STL/3MF export for the slicer), read and modify Part Studios and assemblies, create documents/tabs, rename parts, and write, test, push, commit and publish FeatureScript (custom features, defineFeature, precondition UI, op*/ev*/q*/sk*, custom tables, computed part properties, manipulators, editing logic). Use whenever the user mentions Onshape, a Part Studio, Assembly, Feature Studio, FeatureScript, a custom feature/.fs file, modeling something to 3D-print in Onshape, or calls like defineFeature, opExtrude, qCreatedBy, evVertexPoint, regenError. Bundles injectable JS helpers for modeling/assemblies/FeatureScript, an STL→3MF converter, and the full FeatureScript guide + Standard Library reference (217 modules, ~1300 symbols) as greppable markdown.
---

# Onshape

Base dir: the folder holding this SKILL.md (normally `~/.claude/skills/onshape/`). Every path below is relative
to it; cwd is usually elsewhere, so pass absolute paths to Read/Grep/evaluate_script.

| Path | What |
|---|---|
| `onshape/ONSHAPE.md` | **The guide.** Connecting, reading, eval endpoint, Feature Studios, documents/tabs, adding features, publishing, UI gotchas, safety (§1-9); designing printed parts, in-place edits, assemblies, export, test fits, lessons (§10-15) |
| `onshape/onshape-helpers.js` | `window.__api`, `__ids`, `__elements`, `__features`, `__fsEval`, `__pushFeatureStudio`, `__uploadBlob`, `__createVersion`, UI helpers |
| `onshape/onshape-modeling.js` | `window.__om`: sketch/extrude/offsetPlane/prism/fillet/chamfer, `replaceSketch`/`setExpr` (edit in place), `status`, `bodies`, `idsWhere`, `renamePart`/`renameTab`, `exportStls` |
| `onshape/onshape-assembly.js` | `window.__oa`: `insertPartStudio`, `connector`, `mate` (fastened/slider + limits), `group`, `recenter`, `positions` |
| `onshape/stl_to_3mf.py` | exported STLs → one 3MF, parts named, rotated to print orientation, laid on the bed |
| `onshape/wrap_js.py` | local file → `window.<var> = "…"` for injection (`.fs` sources, icons, PDFs) |
| `featurescript/FEATURESCRIPT.md` | FeatureScript field guide (language, precondition UI, ids, q/ev/op/sk, errors, tables, checklist) |
| `references/` | generated FsDoc markdown (`python scripts/build_references.py` once if missing) |

## Pick the mode

| The user wants | Do |
|---|---|
| An object to 3D-print, a jig, a holder, a multi-part kit | **Printable part** (below + ONSHAPE.md §10-15). Ordinary features from a builder script; no FeatureScript. |
| A reusable tool that works on any model (feature with a dialog) | **Custom feature**: FeatureScript (FEATURESCRIPT.md) pushed to a Feature Studio (ONSHAPE.md §3-7). |
| To read, measure, fix or explain an existing model | Connect, `__features`, `__fsEval` measurements, then edit in place (ONSHAPE.md §2-3, §11). |
| FeatureScript help without browser access | Write the code from FEATURESCRIPT.md + references; the user pastes it and commits. |

## Connecting (every mode)

1. chrome-devtools MCP: `list_pages` → `select_page` on the `cad.onshape.com/documents/<d>/w/<w>/e/<e>` tab. If no
   Onshape tab is open, ask before opening one.
2. Inject what you need with `evaluate_script(pageId, sourcePath="<base>/onshape/<file>.js", format="script")`.
   Navigation (including Onshape reloading the tab by itself) wipes `window.*`: re-inject.
3. Same-origin `fetch('/api/v6/…')` runs as the user. POST/DELETE need `X-XSRF-TOKEN` from the cookie; the
   helpers add it.
4. Read first: `__elements(d, w)`, `__features({d, w, e})` (sketch geometry in meters), `__om.bodies()`.
5. Big payloads go through files: `wrap_js.py` + `sourcePath` in, `evaluate_script(filePath=…)` out.
6. Never `type_text` unless an input has focus (keys are canvas shortcuts). Find buttons by tooltip
   (`data-bs-original-title`) or text; right-click by dispatching `contextmenu`.
7. Confirm before anything outward-facing or hard to undo: deleting tabs, making documents public,
   versions, publishing, exporting for print.

## Printable part

1. Ask only what changes the design (real measurements and which one is the hard limit, concept options,
   joint type, printer/nozzle) with `AskUserQuestion`, recommended option first.
2. New public document per project (`POST /documents {name, isPublic:true}`; the free plan can't create private
   ones: 409). Never build inside another project's document.
3. Builder `<scratchpad>/<project>.js`: named parameters with defaults at the top, axes stated in a comment,
   `build(opts)` that creates a Part Studio with readable feature names using `__om.sketch/extrude/offsetPlane/
   prism/chamfer/fillet`. Separate parts = separate `NEW` bodies; an `ADD`/`REMOVE` that touches another part
   needs `scope`.
4. Inject `onshape-modeling.js` then the builder; run. `__om.status()` must be `[]`; check `__om.bodies()` (count,
   volumes, boxes); rename parts; screenshot; report in a few lines (what changed, sizes, volume, what you didn't
   check). Wait for feedback.
5. Changes go in place (`__om.replaceSketch` with the same polygon/vertex counts, `__om.setExpr`): part ids,
   assembly connectors and mates survive. Big redesigns → new tab in the same doc; ask before deleting old tabs.
   Keep the builder defaults in sync.
6. Joints: model a tolerance test-fit coupon (several clearances per side, males in real print orientation),
   let the user print it, apply what they measured. Remember the result per printer.
7. Thin features ≥ 2 extrusion lines for the nozzle, measured in print orientation.
8. Assembly: `onshape-assembly.js` → `__oa.insertPartStudio`, one connector per part at the world origin
   (POINT inference on a bodydetails vertex), fastened/slider mates, groups. Fix and exploded views only via UI.
9. **Export only after explicit approval of the design.** `__om.exportStls()` with `evaluate_script(filePath=…)`
   → `python <base>/onshape/stl_to_3mf.py parts.json out.3mf --rot "Part=x90"` (check printed sizes). If the
   user will slice/print themselves, deliver the file and stop.

## Custom feature (FeatureScript)

**Read `featurescript/FEATURESCRIPT.md` before writing FeatureScript.** Its core rule: never guess a
std-library signature or definition-map key; look it up (`Grep` the symbol in `references/lib/INDEX.md` →
`Grep -A 40 "^### opExtrude "` in `references/lib/<category>/<module>.md`).

1. Keep the source in a local `.fs`; header lines (`FeatureScript N;` + std import version) come from the
   Feature Studio template, never invented.
2. Test without saving: `__fsEval('function(context is Context, queries) { … }', ids)` (`queries` must be
   `{}`); inline the feature body as a lambda + fixtures (harness in ONSHAPE.md §3).
3. Push: `python wrap_js.py f.fs __src out.js`, inject, `__pushFeatureStudio(window.__src, ids)` = save +
   commit; check the returned specs (compiles, params, namespace).
4. Add an instance via API: `featureType` + `namespace` from specs and **all** parameters (defaults are not
   auto-filled).
5. Publish: version via API, then UI (Versions panel → right-click version → Publish FeatureScript; needs a
   public doc, a PDF, descriptions, the feature used in a Part Studio, no warnings).

Worked example: https://github.com/rt3norio/onshape-pegboard-pegs
