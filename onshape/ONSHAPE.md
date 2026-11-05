# Driving Onshape from the browser

How an agent reads, writes, tests and publishes FeatureScript, and designs printable parts and
assemblies, in the user's real Onshape session. It uses the chrome-devtools MCP and Onshape's own REST API
(`/api/v6`) from inside the page. Everything here was done for real: the
[onshape-pegboard-pegs](https://github.com/rt3norio/onshape-pegboard-pegs) custom feature (sections 1-9) and a
series of 3D-printed parts designed with the user (pegboard boxes and holders, a modular bread-slicing guide
with an assembly, tolerance test fits; sections 10-15).

Files in this folder:

| File | Use |
|---|---|
| `onshape-helpers.js` | Inject once per page load; defines `window.__api`, `__fsEval`, `__features`, `__pushFeatureStudio`, `__uploadBlob`, … |
| `onshape-modeling.js` | `window.__om`: build real Part Studio features (sketch from polygons, extrude, offset plane, fillet, chamfer), edit them in place, rename parts/tabs, measure bodies, export STL |
| `onshape-assembly.js` | `window.__oa`: insert a Part Studio into an assembly, mate connectors at the world origin, fastened/slider mates with limits, mate groups |
| `stl_to_3mf.py` | Exported STLs (JSON) → one 3MF with every part named, rotated to its print orientation and laid on the bed |
| `wrap_js.py` | Turns a local file (`.fs`, `.svg`, `.png`, `.pdf`, …) into `window.<var> = "…"` so it can be injected |

Two ways of working, pick by what the user wants:

- **Custom feature** (reusable tool for many models): FeatureScript in a Feature Studio, sections 1-9.
- **A part to print** (one object, iterated with the user): a local builder script that creates ordinary
  features through the API, sections 10-15. No FeatureScript to maintain; the user can still open and edit
  every sketch and extrude in Onshape.

## Quick start

```text
1. list_pages → select_page(pageId)                     the user's cad.onshape.com tab
2. evaluate_script(pageId, sourcePath="<skill>/onshape/onshape-helpers.js", format="script")
3. async () => __ids()                                  {d, wvm, w, e} of the open tab
4. async () => await __elements(d, w)                   tabs + microversions
5. async () => await __features({d, w, e})              read a Part Studio (sketches, params, states)
6. async () => await __fsEval('function(context is Context, queries) { return 1 + 1; }', {d, w, e})
7. python wrap_js.py myFeature.fs __src out.js → evaluate_script(sourcePath=out.js, format="script")
8. async () => await __pushFeatureStudio(window.__src, {d, w, e: featureStudioId})   save + commit, returns specs
9. test with __fsEval harness (below) — nothing is saved
10. only with user OK: add features / make public / version / publish
```

Printable part (sections 10-15):

```text
1. AskUserQuestion: measurements, concept, joints, printer/nozzle
2. __api('POST', '/documents', {name, isPublic: true})  → new doc per project (free plan: public only)
3. write <scratchpad>/<project>.js: params on top + build(opts) using window.__om
4. evaluate_script(sourcePath=".../onshape-modeling.js", format="script"), then the builder, then build()
5. __om.status() == [] ; __om.bodies() ; __om.renamePart(...) ; take_screenshot → report, wait for feedback
6. changes: __om.replaceSketch / __om.setExpr (in place)   |   big redesign: new Part Studio tab
7. joints: print a tolerance test fit first (section 14), apply the winning clearance
8. assembly: onshape-assembly.js → __oa.insertPartStudio / connector / mate / group ; Fix + explode in UI
9. ONLY after "approved": __om.exportStls() with filePath → python stl_to_3mf.py → user's Desktop
```

Re-inject step 2 after **any** navigation. Onshape sometimes navigates the tab by itself (it happened right
after a feature was added through the API), which silently wipes every `window.__*` helper.

## 1. Connecting

- The chrome-devtools MCP is attached to the user's own Chrome (see the user's memory notes for how it was set
  up). `list_pages` shows the Onshape tab; `select_page(pageId)`.
- URL anatomy: `https://cad.onshape.com/documents/<d>/w/<w>/e/<e>`. `d` = document, `w` = workspace
  (`v` = version, `m` = microversion), `e` = element (tab). `__ids()` parses it.
- Same-origin `fetch('/api/v6/...')` runs with the user's session cookies: no API keys, no OAuth.
- **GET** works with plain fetch. **POST/DELETE** need header `X-XSRF-TOKEN` = `decodeURIComponent` of the
  `XSRF-TOKEN` cookie, otherwise **401** with an empty body. `__api` adds it.
- Bodies are BT JSON: objects carry `btType` (e.g. `"BTMFeature-134"`) directly. There is **no** `message`
  wrapper (older docs/examples show `{message: …}`; v6 does not).

## 2. Reading a Part Studio

`GET /partstudios/d/{d}/w/{w}/e/{e}/features` → `{features[], featureStates{}, …}`.
`__features(ids)` summarizes it:

- each feature: `name`, `featureType` (`newSketch`, `extrude`, `fillet`, `assignVariable`, custom type…),
  `featureId`, `namespace` (custom features), `suppressed`;
- parameters keyed by `parameterId`: quantities as `expression` (`"#PegHeight"`, `"5/16 in"`), enums/booleans
  as `value`, queries as compressed `queryString`/`deterministicIds`;
- sketches: `entities` (geometry in **meters**, e.g. circles `xCenter/yCenter/radius`, lines `pnt/dir`) and
  `constraints` (`DISTANCE length=#var`, `DIAMETER`, `COINCIDENT`, …);
- `featureStates[featureId].featureStatus`: `OK` / `WARNING` / `ERROR`.

Compressed query strings can't be decoded by hand; to know what a feature touches, measure it with `__fsEval`
(e.g. bounding boxes of `qCreatedBy(makeId("<featureId>"), EntityType.FACE)`). That is how we found that the
user's "Fillet 1" was the concave neck/head corner, not the head rim.

## 3. FeatureScript eval endpoint (the test bench)

`POST /partstudios/d/{d}/w/{w}/e/{e}/featurescript` body
`{ "script": "function(context is Context, queries) { … return …; }", "queries": {} }`.

- Runs against the Part Studio's **regenerated context at the end of the feature list**, then throws the
  context away. Nothing is saved: you can `fCuboid`, `opExtrude`, `opBoolean`… freely to test.
- `queries` **must be a map** (`{}`); an array → 400 "Cannot deserialize … LinkedHashMap".
- Result comes back as `BTFSValue*` trees → `__unwrap`. Return strings/arrays/maps; `toString(v)` and
  `roundToPrecision(x / inch, 4)` make values readable. `ValueWithUnits` → divide by a unit first.
- Syntax/runtime errors come back in `notices` (with line numbers counted inside your script string);
  `result` is then `null`.
- `transientQueriesToStrings(evaluateQuery(context, q))` gives the ids to put in API queries
  (`BTMIndividualQuery-138.deterministicIds`). Default planes: `JDC` Top, `JCC` Front, `JEC` Right.
- `evPlane` of the Right plane: normal +X, x = +Y → sketches on Right use (u, v) = (world Y, world Z).

### Harness pattern for testing a custom feature before using it

The eval script can't import or declare top-level things, so inline the feature:

1. Copy the feature **body block** (`{ … }` after the precondition) and bind it: `const runFeature = function(context is Context, id is Id, definition is map) { … };`.
   When slicing source text, don't lose the body's closing brace (the `});` that ends `defineFeature` contains it).
2. Top-level helper `function f(...) returns T { … }` → `const f = function(...) returns T { … };` placed **before** use.
3. Enums → `const MyEnum = { "A" : "A", "B" : "B" };` (comparisons with `==` keep working on strings).
4. Build fixtures with `fCuboid(context, newId() + "Tplate", {...})`, pick faces with
   `qCreatedBy(newId() + "Tplate", EntityType.FACE)` + filters, pass a full `definition` map
   (every parameter, including empty `qNothing()` queries).
5. Run each case in `try { runFeature(context, newId() + ("T" ~ k), def); } catch (e) { … e.message … }`
   and return one summary string per case (status, body count, volume delta, positions).

Build the script with a small Python generator (read the `.fs`, slice, concat with a tests file), write it with
`wrap_js.py`, inject, then `__fsEval(window.__harness, ids)`. Cases that paid off: single item, many items,
zero-size options (fillet 0), alternate placement mode, flipped direction, off-face/out-of-bounds, invalid
sizes. The flipped case found a real bug (pegs silently swallowed by the part) that a quick visual check missed.

Query gotchas seen in practice:
- `qFarthestAlong(q, dir)` returns **all ties** (every face touching the extreme plane). Pick faces by
  `evPlane(...).normal` + `evArea` instead.
- `qContainsPoint(qOwnerBody(face), p)` is a reliable "is this point inside the solid" test.
- `qClosestTo(q, point)` is good for picking one face of a test cuboid.

## 4. Feature Studios

- Read: `GET /featurestudios/d/{d}/w/{w}/e/{e}` → `{contents, serializationVersion, sourceMicroversion}`.
- Write: `POST` same path with `{contents, serializationVersion, sourceMicroversion, rejectMicroversionSkew:false}`.
  This **replaces the whole text and commits it**; Part Studios in the same workspace pick it up
  (their custom-feature namespace `e<eid>::m<microversion>` updates automatically).
- Verify: `GET …/featurespecs` → one spec per feature. Spec present = precondition parsed; check parameter
  count, `namespace`, `iconUri`, `descriptionImageUri`, `featureNameTemplate`. `__pushFeatureStudio` does all three.
- New Feature Studio: `POST /featurestudios/d/{d}/w/{w}` `{name}` → it starts with the
  `FeatureScript N;` + `common.fs` import header; keep that version number.
- Keep the source of truth in a local `.fs` file; push with `wrap_js.py` → `__pushFeatureStudio`.

## 5. Documents, tabs, blobs

| Action | Call |
|---|---|
| New document | `POST /documents {name, description, isPublic}` → `id`, `defaultWorkspace.id` (new docs come with Part Studio 1 + Assembly 1 + BOM) |
| List tabs | `GET /documents/d/{d}/w/{w}/elements` → `id`, `elementType`, `microversionId`, `dataType` (`__elements`) |
| Delete tab | `DELETE /elements/d/{d}/w/{w}/e/{e}` (deleting the Assembly also removed its BOM) |
| Upload file tab | multipart `POST /blobelements/d/{d}/w/{w}` fields `file`, `encodedFilename` (`__uploadBlob`) |
| Rename tab | `POST /metadata/d/{d}/w/{w}/e/{e} {jsonType:'metadata-element', properties:[{propertyId:'57f3fb8efa3416c06701d60d', value}]}` (`__om.renameTab`). `POST /elements/…/name` → 404 |
| Rename part | `POST /metadata/d/{d}/w/{w}/e/{e}/p/{partId} {jsonType:'metadata-part', partId, properties:[{propertyId:'57f3fb8efa3416c06701d60d', value}]}` (`__om.renamePart`) |
| New Part Studio tab | `POST /partstudios/d/{d}/w/{w} {name}` → `id` (`__om.newPartStudio`) |

Same-document imports need the tab's **element microversion** from `GET elements`:
`PegIcon::import(path : "<blobEid>", version : "<microversionId>");` then `"Icon" : PegIcon::BLOB_DATA`,
`"Description Image" : PegImage::BLOB_DATA`.

## 6. Adding features through the API (modifies the model)

`POST /partstudios/d/{d}/w/{w}/e/{e}/features {feature}` → `{feature: {featureId…}, featureState: {featureStatus}}`.
Update: `POST …/features/featureid/{fid}` with the full feature (include `featureId`).

Sketch (lines in meters, closed loop; coincident constraints keep it solved):
```json
{ "btType": "BTMSketch-151", "featureType": "newSketch", "name": "Profile",
  "parameters": [{ "btType": "BTMParameterQueryList-148", "parameterId": "sketchPlane",
                   "queries": [{ "btType": "BTMIndividualQuery-138", "deterministicIds": ["JEC"] }] }],
  "entities": [{ "btType": "BTMSketchCurveSegment-155", "entityId": "l0",
                 "startPointId": "l0.start", "endPointId": "l0.end", "startParam": 0, "endParam": 0.0635,
                 "geometry": { "btType": "BTCurveGeometryLine-117", "pntX": 0, "pntY": 0, "dirX": 1, "dirY": 0 } }],
  "constraints": [{ "btType": "BTMSketchConstraint-2", "constraintType": "COINCIDENT", "entityId": "c0",
                    "parameters": [{ "btType": "BTMParameterString-149", "parameterId": "localFirst", "value": "l0.end" },
                                   { "btType": "BTMParameterString-149", "parameterId": "localSecond", "value": "l1.start" }] }] }
```

Extrude of that sketch's region:
```json
{ "btType": "BTMFeature-134", "featureType": "extrude", "name": "Shelf", "parameters": [
  { "btType": "BTMParameterEnum-145", "parameterId": "bodyType", "enumName": "ExtendedToolBodyType", "value": "SOLID" },
  { "btType": "BTMParameterEnum-145", "parameterId": "operationType", "enumName": "NewBodyOperationType", "value": "NEW" },
  { "btType": "BTMParameterQueryList-148", "parameterId": "entities",
    "queries": [{ "btType": "BTMIndividualSketchRegionQuery-140", "featureId": "<sketchFeatureId>" }] },
  { "btType": "BTMParameterEnum-145", "parameterId": "endBound", "enumName": "BoundingType", "value": "BLIND" },
  { "btType": "BTMParameterQuantity-147", "parameterId": "depth", "expression": "4 in" },
  { "btType": "BTMParameterBoolean-144", "parameterId": "symmetric", "value": true } ] }
```

Custom feature instance:
- `featureType` = the exported const name (`pegboardPegs`), `namespace` = spec `namespace` (`e<eid>::m<mv>`).
- **Pass every parameter.** Missing ones are *not* filled from the precondition defaults; the feature just goes
  `ERROR` (cost us one round trip).
- Parameter shapes: quantity `BTMParameterQuantity-147 {expression:"5/32 in"}` (integers too: `"2"`),
  boolean `BTMParameterBoolean-144 {value}`, enum `BTMParameterEnum-145 {namespace, enumName, value}`
  (custom enums need the feature's namespace), query list `BTMParameterQueryList-148 {queries:[BTMIndividualQuery-138 {deterministicIds:[…]}]}`
  (empty optional query: `queries: []`).
- After adding, confirm with `featureState` and a `__fsEval` measurement (body count, volume delta, bounding box).

## 7. Versions, publishing, toolbar

- Version: `POST /documents/d/{d}/versions {documentId, workspaceId, name, description}`.
- Publishing FeatureScript has no API we found → UI:
  1. Open the Versions panel: `__byTooltip('Versions and history').click()` (left bar, class `os-panel-selector-button`).
     If a new version doesn't show, click the button twice (close/open) to refresh.
  2. Right-click the row: `__rightClick([...document.querySelectorAll('.version-name')].find(e => e.textContent === 'v1.1'))`.
  3. `__clickText('Publish FeatureScript')` → dialog "Publish custom features and tables at vX" lists requirements;
     wait for it (`wait_for` text), then the button "Publish custom features and tables" enables.
  4. Requirements (all must be green): document is **public**; defines ≥1 custom feature/table; **document contains a PDF**;
     Feature Studios have no errors **or warnings**; every custom feature has a description; every custom feature is
     used in ≥1 Part Studio; all Feature Studios committed. The version itself must contain these (a PDF added later
     needs a new version).
  5. Toast "Published custom features and tables at version vX." The history legend gains "Published FeatureScript".
- PDF without extra tools: write an HTML guide and print it with headless Edge (doesn't touch the user's Chrome):
  `msedge.exe --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="out.pdf" "file:///…/guide.html"`.
- Add a published feature to the user's toolbar (per user, every document): in a Part Studio,
  `__byTooltip('Add custom features').click()` → "Other documents" tab is active with a focused search box →
  `type_text("<name>", submitKey:"Enter")` → wait for results → click
  `document.querySelector('.select-item-dialog-item.parent-item[data-bs-original-title="<Feature Studio name>"]')` →
  toast "Custom feature … was added to your toolbar from published version vX".
- Users update by clicking the blue link icon on the feature; never rename the feature const or parameter ids after release.

## 8. UI gotchas

- **Never `type_text` unless an input has focus.** Keystrokes hit the graphics area as shortcuts: `p` toggles
  planes, `f` fits view, etc. (A failed tab rename typed "Example shelf" into the viewport.)
- `take_snapshot` is sparse for Onshape (canvas + Angular); use `evaluate_script` with tooltips
  (`data-bs-original-title`, list them with `__tooltips(/regex/)`), `document.elementFromPoint(x, y)` for icon
  bars, and class names (`.version-name`, `.os-panel-selector-button`, `.select-item-dialog-item`).
- The MCP `click` has no right click → dispatch `mousedown/mouseup/contextmenu` (`__rightClick`).
- A "Poor connection…" banner means dialogs load slowly → `wait_for` on expected text instead of guessing.
- Screenshots for description images: hide planes (`p` with canvas focused), `take_screenshot(filePath)`,
  crop/resize with PIL to ~300 px, upload as blob.
- Large payloads: never paste file contents into `evaluate_script` arguments; use `wrap_js.py` + `sourcePath`.

## 9. Safety

- `__fsEval` and all GETs are read-only. Adding/updating features, pushing Feature Studio contents, deleting tabs,
  creating versions, making documents public and publishing change the user's account: confirm first (the user
  may pre-authorize, as with the pegboard project).
- Publishing and public documents are effectively irreversible (copies, search index). Onshape free plan
  documents are always public.
- Test in a fresh document or through `__fsEval` fixtures, not by adding features to the user's real models.
- Printed parts: building in a project document the user asked for is pre-authorized by the request;
  exporting STL/3MF, slicing and printing are not. They wait for explicit design approval.

## 10. Designing a printable part with the user (the loop)

This is the workflow that worked across every printed-part project. Follow it in order.

1. **Ask the few questions that change the design**, with `AskUserQuestion` and a recommended option:
   real measurements of the thing it must fit (and which number is the hard limit), concept (2-3 sketched
   alternatives), how parts join (pins, tenons, snap, glue), printer and nozzle. Don't ask what you can
   default sensibly.
2. **One document per project.** `POST /documents {name, isPublic:true}`. Free Onshape accounts can't create
   private documents (409); say the document will be public. Never build a new project inside another
   project's document.
3. **Write a local builder script** `<project>.js` (scratchpad): every dimension a named parameter with a
   default at the top, one `async build(opts)` that uses `__om` to create a new Part Studio and its features
   with readable names ("Floor profile", "Ring pockets", "Crown cut"). Coordinates in mm, X/Y/Z stated in a
   header comment (e.g. "X across the loaf, Y along it, Z up; knife plane y = 0").
4. **Inject `onshape-modeling.js`, then the builder; run it.** Check `await __om.status()` is `[]` and
   `await __om.bodies()` gives the expected part count, volumes and bounding boxes. Rename parts
   (`__om.renamePart`) to real names, since they become STL/3MF object names and assembly instance names.
5. **Look at it and show it.** `take_screenshot` of the Part Studio (isometric view), read it yourself, then
   report to the user in a few lines: what changed, key dimensions, volume/weight, anything you're unsure of.
   Say what you did NOT verify (e.g. "didn't open the tab to look at the new ribs").
6. **Iterate on feedback.** Small change → edit in place (section 11). Big change ("make everything
   modular", "v5") → new Part Studio in the same document from an updated builder, keeping the old tab until
   the user says to delete it. Ask before deleting tabs.
7. **Tolerances come from a test fit, not from guesses** (section 14).
8. **Export only after explicit approval** of the design ("aprovado", "gera o 3mf"). Never export, slice or
   print a design the user hasn't approved, even if the request sounds like "so I can print it"; confirm first.
   When the user says they'll do the rest (slicing, printing), deliver the file and stop.

Design rules learned along the way:

- Separate parts that touch must be **separate bodies**: create them with `NEW`, and give `ADD`/`REMOVE`
  extrudes a `scope` (`booleanScope`) when they touch another part's face. A default-scope `ADD` that touches
  the base merges into it silently; a default-scope `REMOVE` cuts every part it crosses.
- Big parts that would print badly in one piece: split into modules that slot together (tenons, pockets,
  pins) and print each in its best orientation ("one big lego").
- Thin walls: in print orientation, every wall should be ≥ 2 extrusion lines (≈ 2 × nozzle × 1.05) and,
  better, close to a whole number of lines. Check fits and hole sizes in the orientation they'll print in.
- Lightening patterns (isogrid, honeycomb) with `clipRect` + `polyArea` to drop slivers; align the lattice so
  solid cells land where loads/pins are.
- Write geometry so a re-run with the same counts produces the same sketch entity ids (see `__om.sketch`),
  which keeps in-place edits safe.

## 11. Editing a model in place

Rebuilding from scratch changes part ids and breaks assemblies. To change dimensions of an existing model:

- `await __om.replaceSketch('Ring pockets sketch', newPolys)` keeps the feature id and, with the same number
  of polygons and vertices, every downstream face/edge id. Compare the first entity before/after (sketch
  coords are meters in the API; `old.entities[0].geometry.pntX * 1000`) to confirm you rebuilt the polygons
  in the same order and orientation.
- `await __om.setExpr('Floor', 'depth', '161.2 mm')` for extrude depths, offsets, radii.
- `await __om.del(featureId)` for features the new design doesn't need.
- To restructure one part while keeping its part id, edit the feature that created the body (`NEW`) and add
  new features after it with `scope` on that body.
- After editing: `__om.status()`, `__om.bodies()`, and if there is an assembly, `__oa.status()` and
  `__oa.positions()` (section 12). A connector whose vertex moved puts the part out of place: fix with
  `__oa.recenter(name, partId)`.
- Keep the builder script's defaults in sync with what's in Onshape, so a future rebuild gives the same model.

Getting ids for fillets/chamfers: select by measurement, e.g. the 8 tall slot edges
`await __om.idsWhere('EDGE', 'b.maxCorner[2] - b.minCorner[2] > 100 * millimeter && abs(abs(b.minCorner[1] / millimeter) - 1.7) < 1e-4')`.

Plane orientation: `__om.offsetPlane` returns `origin` and `xDir`. An offset of Front (`JCC`) goes to **-Y**
unless `opposite = true`. If `xDir[0] < 0`, sketch u runs along -X: mirror polygons (`u → -u`).

FeatureScript in eval scripts: one declaration per statement (`const a = 1, b = 2;` silently returns null);
`qCreatedBy(makeId(featureId), EntityType.FACE)` to reach a plane you just made.

## 12. Assemblies

What works through the API (`__oa`, standalone file):

```text
__oa.use({d, w, a: assemblyId, ps: partStudioId})
await __oa.insertPartStudio()                    every part lands where it was modeled (all translations 0)
await __oa.instances()                           [{name, id, partId}]
await __oa.connector('MC base', baseInst, baseId)               connector at the world origin, world axes
await __oa.connector('MC base rail', baseInst, baseId, 'Y')     Z along world +Y (slider axis)
await __oa.mate('Tower on base', 'FASTENED', mcBase.id, mcTower.id)
await __oa.mate('Stop on rail', 'SLIDER', mcRail.id, mcStop.id, {min: '-8 mm', max: '16 mm'})
await __oa.group('Frame', [baseInst, towerInst, crownInst])
await __oa.status()  /  await __oa.positions()   [] and all [0, 0, 0] = nothing moved
```

- Because every connector sits at the world origin of its part, fastened mates keep the modeled layout and
  sliders start at the modeled position. Slider limits are relative to that.
- Connector origin = inference `POINT` on a vertex id from
  `GET /parts/d/{d}/w/{w}/e/{ps}/partid/{pid}/bodydetails`, then `translation{X,Y,Z}` = minus that vertex.
  These failed: mate connectors created in the Part Studio and referenced from the assembly
  ("Missing mate connector"), `CENTROID` inference, transient ids.
- Mate group parameter is `occurrencesQuery` (`occurrences` → ERROR).
- Assembly feature ids can contain `/` and `+`: `encodeURIComponent` them.
- Rename the assembly tab with `__om.renameTab`.

UI-only (no API that works):

- **Fix** a part: dispatch a right-click on its name in the instance list
  (`mousedown/mouseup/contextmenu` with `button: 2` on the leaf element whose text is `"Base <1>"`), then
  `take_snapshot` and `click` the uid of the "Fix" menu item. Don't press Escape afterwards: it undid the Fix.
- **Exploded view**: the `BTExplosion-2754` feature can't be edited through the API ("Feature has invalid
  type"); posting `explosionStep` features is a silent no-op. In the UI:
  1. Click the split toggle button whose HTML mentions "xploded" (right panel), then the button
     "Add exploded view".
  2. Click an instance in the left list → the step dialog opens with a triad on the part.
  3. Drag a triad arrow: dispatch `pointermove/pointerdown/pointermove×12/pointerup` (plus matching mouse
     events) on the canvas element at the arrow tip, found from a screenshot.
  4. The distance input appears (`input` whose value ends in `mm`, in the dialog): `focus()` + `select()`,
     `type_text("90 mm")`, `press_key("Enter")`.
  5. Click the dialog's ✓ (find it with `document.elementFromPoint` from the screenshot). While a step dialog
     is open, clicking another instance in the list adds it to the same step (ctrl-click opens a hover menu).
  6. Repeat per step; "Done" closes the view. Verify step names with `GET …/features` (`explodeSteps`).

## 13. Export: STL and 3MF

Only after the user approved the design (section 10).

```text
1. evaluate_script(pageId, filePath="<scratchpad>/parts.json",
     function="async () => { window.__om.use({d, w, e}); return await window.__om.exportStls(); }")
2. python stl_to_3mf.py parts.json "<Desktop>/<project>.3mf" --rot "Lid=x180" --rot "Tower*=y90" [--copies "Pin=4"]
```

- `filePath` keeps the base64 out of the conversation. The JSON is `{part name: base64 binary STL}`; a value
  that is an object instead of a string is an export error for that part.
- Translation API details: enums uppercase (`stlMode:'BINARY'`, `unit:'MILLIMETER'`, `resolution:'FINE'`),
  `partIds` as a plain string; poll `GET /translations/{id}` until `DONE`, then download
  `GET /documents/d/{d}/externaldata/{resultExternalDataIds[0]}`. The synchronous
  `GET /parts/…/partid/{pid}/stl` redirects to another host and fails inside the page ("Failed to fetch").
- Print orientation per part (`--rot`, multiples of 90°, applied left to right): the flat, accurate face down,
  pins and tenons printed in the same orientation as the test fit that set their clearance, no supports when
  avoidable. The script prints each object's size after rotation: check that the expected dimension is Z.
- The 3MF holds geometry only (objects named after the parts, laid out on the bed). Printer/process/filament
  are chosen in the slicer by the user. Bambu Studio: a project 3MF written by the slicer CLI keeps its
  settings only if they're listed in `different_settings_to_system`; a geometry-only 3MF like this one just
  takes the presets selected in the GUI.

## 14. Tolerance test fit

Never guess clearances for parts that slot together. Model a small coupon in its own Part Studio and let the
user print it before the real parts:

- A plate as thick as the real female part, with through holes for each joint type (e.g. a 6×10 tenon and a
  4.4 mm square pin), at several clearances per side (0.1 / 0.2 / 0.3 / 0.4 / 0.5 mm). Mark each column with
  1…n notches on the edge so the printed coupon is readable.
- Male bars of each joint, separate bodies, printed in the **same orientation** as the real parts, so the
  measured fit includes the printer's real error in that direction (layer stepping included).
- The user reports the best column per joint, and whether the joint is fixed or taken in and out. In
  practice (0.8 mm nozzle, 0.32 mm layers, PLA): 0.1 mm per side for fixed press fits, 0.2 mm per side for
  pins the user removes often. Apply them with section 11 and keep them as the default for that printer.

## 15. Things that went wrong (don't repeat)

- Exported and started slicing before the user approved the design → the user was annoyed. Ask first.
- Built a new project inside the previous project's document → user asked for a new document.
- Escape to close a stale dialog undid the last UI action (the Fix).
- Ctrl-click in the assembly instance list opens a hover menu instead of multi-selecting.
- `type_text` with no focused input hits the canvas as shortcuts (section 8).
- After any navigation (or Onshape reloading the tab on its own) every injected `window.__*` is gone:
  re-inject `onshape-modeling.js`, `onshape-assembly.js` and the builder before calling them.
- The Onshape tab can be closed by the user mid-task: `list_pages` first; if it's gone, ask before reopening.
