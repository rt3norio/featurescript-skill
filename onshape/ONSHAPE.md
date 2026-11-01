# Driving Onshape from the browser

How an agent reads, writes, tests and publishes FeatureScript in the user's real Onshape session, using the
chrome-devtools MCP and Onshape's own REST API (`/api/v6`) from inside the page. Everything here was done
for real while building the [onshape-pegboard-pegs](https://github.com/rt3norio/onshape-pegboard-pegs)
custom feature; ids marked "example" come from that session.

Files in this folder:

| File | Use |
|---|---|
| `onshape-helpers.js` | Inject once per page load; defines `window.__api`, `__fsEval`, `__features`, `__pushFeatureStudio`, `__uploadBlob`, … |
| `wrap_js.py` | Turns a local file (`.fs`, `.svg`, `.png`, `.pdf`, …) into `window.<var> = "…"` so it can be injected |

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
| Rename tab | **no working endpoint found** (`POST /elements/…/name` → 404); double-clicking the tab via MCP didn't open the editor either; ask the user to rename |

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
