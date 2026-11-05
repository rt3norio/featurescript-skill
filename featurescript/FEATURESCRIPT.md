# FeatureScript field guide

Part of the Onshape skill. Read this before writing, reviewing or debugging FeatureScript (custom features,
tables, computed properties, eval scripts). For getting code into Onshape (push, commit, test with the eval
endpoint, publish) see `../onshape/ONSHAPE.md` sections 3-7.

Source: https://cad.onshape.com/FsDoc/ (guide, language reference, tutorials, `library.html`); `references/` is generated from it by `scripts/build_references.py` (rerun to refresh).
Std library source is public: Onshape document "std" (`cad.onshape.com/documents/12312312345abcabcabcdeff`).

## Looking things up

Base dir: the skill folder (the one holding SKILL.md, normally `~/.claude/skills/onshape/`) — every `references/...` path below is relative to it; cwd is usually elsewhere, so pass absolute paths to Grep/Read.
If `references/` is missing, build it once: `python <base>/scripts/build_references.py` (downloads FsDoc, ~10 s).

Never guess a std-library signature or definition-map key. Look it up:

1. `Grep` symbol in `references/lib/INDEX.md` → gives `<category>/<module>`.
2. `Grep -A 40 "^### opExtrude "` in `references/lib/<category>/<module>.md` (or Read section). Entries look like:
   `### opExtrude (context is Context, id is Id, definition is map)` + description + `- \`key\` (Type): [optional]/Required if … EX: …`.
3. Concepts / language rules → `references/guide/*.md`. Worked examples → `references/tutorials/*.md`.

Reference map (all under `references/`):

| File | Covers |
|---|---|
| `guide/intro.md` | Part Studio = FeatureScript build function; determinism; units overview |
| `guide/feature-types.md` | defineFeature basics, regeneration triggers |
| `guide/uispec.md` | **Feature dialog**: annotations, every param kind, lookup tables, arrays, groups, UIHint, conditional visibility, icons, manipulator change fn, editing logic fn |
| `guide/output.md` | print/println, debug, timers, error reporting |
| `guide/variables.md` | var/const, value semantics, standard types, box, lambdas, enums, custom types |
| `guide/modeling.md` | Context, bodies, queries, ev/op/primitives, sketches, geometry, feature patterns |
| `guide/tables.md` / `computed-part-properties.md` | defineTable, defineComputedPartProperty |
| `guide/imports.md` | import paths, BLOB_DATA (CSV/JSON/TEXT/image), Part/Variable Studio import, reference params, instantiator, configurations |
| `guide/debugging-in-feature-studios.md` | analysis vs execution, commit, monitor, typecheck, profiling, notice filters |
| `guide/tokens.md`, `type-tags.md`, `top-level.md`, `syntax.md`, `annotations.md`, `exceptions.md`, `relational.md` | Language reference |
| `tutorials/1-create-a-slot-feature.md`, `2-add-sketch-geometry.md` | End-to-end feature with full final code |
| `lib/INDEX.md` + `lib/{modeling,math,utilities,features,enums}/*.md` | Whole Standard Library reference |

Key modules: `modeling/geomOperations` (all `op*`), `modeling/evaluate` (`ev*`), `modeling/query` (`q*`, EntityType, BodyType, GeometryType…), `modeling/sketch` (`sk*`), `modeling/primitives` (`fCuboid`…), `modeling/context` (Id rules, variables), `utilities/feature` (defineFeature, subfeatures, patterns, tracking), `utilities/error` (regenError, warnings), `utilities/valueBounds` (bounds consts), `utilities/manipulator`, `utilities/attributes`, `utilities/properties`, `utilities/table`, `utilities/instantiator`, `utilities/debug`, `utilities/containers`, `utilities/string`, `math/{units,vector,coordSystem,transform,math,curveGeometry,surfaceGeometry}`, `enums/*.gen.md` (BoundingType, BooleanOperationType, UIHint, DebugColor…).
Std features (`features/extrude.md`, `fillet.md`, `hole.md`, sheetMetal*…) document feature-level definition maps, useful with `callSubfeatureAndProcessStatus`.

## Mental model

- Part Studio = FeatureScript `build` function; each feature in the tree = function call; params = `definition` map; rollback bar = early return. Right-click Part Studio tab → "Show code".
- Custom features live in a **Feature Studio** tab. Edits are saved live, but Part Studios only see **committed** code (Commit button). Execution feedback only for committed code; static analysis on current text.
- Feature body re-runs on every regen: on add, param change, any upstream change, rollback move. Queries are re-evaluated each run (no stale references).
- Deterministic: no time, randomness, I/O. External data must be uploaded as a tab and imported.
- `Context` (builtin) holds all bodies/entities/variables. Bodies: solid, sheet, wire, point (+ mate connectors). Entities = bodies, faces, edges, vertices.

## File skeleton

Keep the header lines the Feature Studio template inserted — `FeatureScript N;` and std import version `"N.0"` must match; don't invent a version.

```
FeatureScript 1890;                                          // use version from your template
import(path : "onshape/std/common.fs", version : "1890.0");  // common.fs is lighter; geometry.fs = everything

annotation { "Feature Type Name" : "My Feature",
             "Feature Type Description" : "What it does" }
export const myFeature = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Faces", "Filter" : EntityType.FACE && ConstructionObject.NO }
        definition.faces is Query;
        annotation { "Name" : "Depth" }
        isLength(definition.depth, LENGTH_BOUNDS);
    }
    {
        // body: ev* to measure, op*/f*/sk* to build, q* to refer to geometry
    }, { /* defaults for FeatureScript callers only, e.g. "flip" : false */ });
```

- Other feature annotation keys: `"Feature Name Template"`, `"Tooltip Template"`, `"Filter Selector"`, `"Icon"`, `"Description Image"`, `"UIHint"` (e.g. `UIHint.NO_PREVIEW_PROVIDED`), `"Editing Logic Function"`, `"Manipulator Change Function"`.
- `export` is required for the feature (and for any enum/bounds/lookup-table const used in the precondition) to be visible to Part Studios.
- Renaming the const (`myFeature`) breaks existing instances; "Feature Type Name" can change freely.
- Defaults map (2nd arg of `defineFeature`) only applies when called from code; UI defaults come from `"Default"` annotation or bounds spec.

## Precondition = UI (static analysis, not executed)

| Kind | Spec |
|---|---|
| Boolean | `annotation { "Name" : "Flip", "Default" : true, "UIHint" : UIHint.OPPOSITE_DIRECTION } definition.flip is boolean;` |
| String | `definition.s is string;` + optional `"Default"`, `"MaxLength"`, `"MinLength"` |
| Enum | `definition.e is MyEnum;` (enum must be exported; values annotated `{ "Name", "Icon", "Hidden" }`; `"Default" : "VALUE"`; `UIHint.HORIZONTAL_ENUM` for tabs) |
| Length / Angle / Integer / Real | `isLength(definition.x, LENGTH_BOUNDS)`, `isAngle(.., ANGLE_360_BOUNDS)`, `isInteger(.., POSITIVE_COUNT_BOUNDS)`, `isReal(.., POSITIVE_REAL_BOUNDS)` |
| Anything (any expression/type) | `isAnything(definition.x);` default must be a string expression, e.g. `"\"text\""` |
| Query (selection) | `annotation { "Name" : "Edge", "Filter" : EntityType.EDGE && SketchObject.YES, "MaxNumberOfPicks" : 1 } definition.edge is Query;` |
| Lookup table | `annotation { "Name" : "Size", "Lookup Table" : sizeTable } definition.size is LookupTablePath;` then `getLookupTable(sizeTable, definition.size)` |
| Array | `annotation { "Name" : "Items", "Item name" : "Item", "Item label template" : "Item (#w)" } definition.items is array; for (var item in definition.items) { isLength(item.w, LENGTH_BOUNDS); }` (also `"Driven query"`, `"Show labels only"`; no nesting; inner names unique feature-wide) |
| Group | `annotation { "Group Name" : "Options", "Collapsed By Default" : false, "Driving Parameter" : "useOptions" } { ...params... }` |
| References | `is PartStudioData` (`"Filter" : PartStudioItemType.SOLID \|\| PartStudioItemType.ENTIRE_PART_STUDIO`, `"ComputedConfigurationInputs"`), `VariableStudioData`, `ImageData`, `TableData` (CSV), `JSONData`, `TextData` (<100KB), `CADImportData` |

- Custom bounds (also sets per-unit default): `{ (meter) : [1e-5, 0.0025, 500], (millimeter) : 2.5, (inch) : 0.1 } as LengthBoundSpec` → `[min, default, max]` in first unit, per-unit defaults for others. Inline: `{ (inch) : [0, 1.75, 10000] } as LengthBoundSpec`.
- Bound consts: `LENGTH_BOUNDS`, `NONNEGATIVE_LENGTH_BOUNDS`, `NONNEGATIVE_ZERO_DEFAULT_LENGTH_BOUNDS`, `ZERO_DEFAULT_LENGTH_BOUNDS`, `BLEND_BOUNDS`, `SHELL_OFFSET_BOUNDS`, `ANGLE_360_BOUNDS`, `ANGLE_STRICT_90_BOUNDS`, `ANGLE_180_MINUS_180_BOUNDS`, `POSITIVE_COUNT_BOUNDS`, `POSITIVE_REAL_BOUNDS`, `SCALE_BOUNDS` … (`lib/utilities/valueBounds.md`).
- Query `"Filter"` enums: `EntityType`, `BodyType`, `GeometryType`, `ConstructionObject`, `SketchObject`, `EdgeTopology`, `ModifiableEntityOnly`, `ActiveSheetMetal`, `SheetMetalDefinitionEntityType`, `AllowMeshGeometry`, `AllowFlattenedGeometry`, `AllowEdgePoint`, `QueryFilterCompound`; combine with `&& || !`. Filters are client-side only → body must re-validate (upstream edits can change what the query resolves to).
- Conditional params: `if (definition.flag)` / `if (definition.mode == MyEnum.A)`, using only earlier boolean/enum params with `== != && || !`; may nest. Each param may be specified only once per feature.
- `UIHint.ALWAYS_HIDDEN` for hidden state; `UIHint.REMEMBER_PREVIOUS_VALUE`, `UIHint.READ_ONLY`, `UIHint.COLLAPSE_ARRAY_ITEMS`, `UIHint.MATCH_LAST_ARRAY_ITEM`; arrays of hints allowed. Full list: `lib/enums/uihint.gen.md`.
- `"Description"` on params, `"Feature Type Description"` on feature; basic HTML allowed, join lines with `~`.
- Icons: `Icons::import(...)` an SVG blob then `"Icon" : Icons::BLOB_DATA`, or a std `Icon.*` enum value. `"Description Image"` takes JPG/PNG/SVG blob (~300px).

### Editing logic & manipulators

```
export function onFeatureChange(context is Context, id is Id, oldDefinition is map, definition is map,
        isCreating is boolean, specifiedParameters is map, hiddenBodies is Query,
        clickedButton is string, libraryInfo is ParameterLibraryInfo) returns map
{ return definition; }   // first 4 args required; later ones optional but keep order; omit isCreating => only called on create

export function onManipulatorChange(context is Context, definition is map, newManipulators is map) returns map
{ definition.depth = abs(newManipulators["depthManip"].offset); return definition; }
```
Register via annotation keys `"Editing Logic Function" : "onFeatureChange"`, `"Manipulator Change Function" : "onManipulatorChange"`. In body: `addManipulators(context, id, { "depthManip" : linearManipulator({ "base" : p, "direction" : n, "offset" : definition.depth, "primaryParameterId" : "depth" }) });`. Others: `angularManipulator`, `flipManipulator`, `triadManipulator`, `fullTriadManipulator`, `pointsManipulator`. Changed fields: `offset` (linear/triad), `angle`, `flipped`, `transform`. Context changes in these functions are rolled back; programmatic defaults are not applied to `definition`. Quantities may be returned as strings (`"3/8 in"`) to set the expression.

## Ids (most common runtime failure)

- Every op needs a unique `Id` under the feature `id`: `id + "extrude1"`. Sketch entity ids are plain strings unique within the sketch (`"line1"`).
- Hierarchy must be **contiguous in history**: `id + "extrude" + i` inside a loop that also does other ops fails on 2nd iteration. Use `id + ("extrude" ~ i)` or `id + i + "extrude"` / `id + ("loop" ~ i) + "extrude"`.
- Allowed chars: `a-z A-Z 0-9 _ + - /` (leading `*` = unstable). `unstableIdComponent(i)` for index-based components; `ANY_ID` wildcard in queries (`qCreatedBy(id + ANY_ID + "fillet")`).
- Prefer `forEachEntity(context, id + "each", query, function(entity is Query, id is Id) { ... })` over index loops: ids tied to entities → downstream references stay stable. Closure can't mutate outer vars except via `box`.
- Default geometry: `qTopPlane(EntityType.FACE)`, `qFrontPlane(..)`, `qRightPlane(..)`, `qOrigin(EntityType.VERTEX)`, `qDefaultBodies()` (`lib/utilities/defaultFeatures.md`); docs also use `qCreatedBy(makeId("Top"), EntityType.FACE)`.

## Modeling vocabulary

- `q*` **Query** = criteria, not references; may resolve to 0..n entities; order unpredictable (`qNthElement` only when order doesn't matter). Core: `qCreatedBy(id + "op", EntityType.BODY)`, `qEverything(EntityType.EDGE)`, `qBodyType`, `qGeometry`, `qEntityFilter`, `qOwnerBody`, `qOwnedByBody`, `qAdjacent(q, AdjacencyType.VERTEX, EntityType.VERTEX)`, `qSketchRegion(id + "sketch1")`, `qContainsPoint`, `qClosestTo`, `qFarthestAlong`, `qLargest`, `qSmallest`, `qCapEntity`, `qNonCapEntity`, `qUnion([...])`, `qSubtraction`, `qIntersection`, `qAllModifiableSolidBodies()`, `qHasAttribute`, `qNothing()`. `evaluateQuery(context, q)` → array of single-entity queries; `isQueryEmpty`, `evaluateQueryCount`.
- `ev*` **Evaluations** `(context, map)` → values: `evVertexPoint({"vertex"})`, `evOwnerSketchPlane({"entity"})`, `evPlane({"face"})`, `evLine({"edge"})`, `evAxis`, `evEdgeTangentLine({"edge","parameter"})`, `evFaceTangentPlane({"face","parameter" : vector(0.5, 0.5)})`, `evBox3d`, `evDistance`, `evLength`, `evArea`, `evVolume`, `evMateConnector`, `evCurveDefinition`, `evSurfaceDefinition`, `evRaycast`, `evCollision`. They throw on failure → wrap with `try`.
- `op*` **Operations** `(context, id, map)` mutate context: `opExtrude`, `opRevolve`, `opSweep`, `opLoft`, `opThicken`, `opShell`, `opFillet`, `opChamfer`, `opDraft`, `opBoolean`, `opSplitPart`, `opDeleteBodies`, `opTransform`, `opPattern`, `opPlane`, `opPoint`, `opMateConnector`, `opFitSpline`, `opHelix`, `opImportForeign`, `opMergeContexts`, `opOffsetFace`, `opMoveFace`, `opReplaceFace`, `opHole`, `opWrap`…
- `f*` primitives: `fCuboid({"corner1","corner2"})`, `fCylinder({"bottomCenter","topCenter","radius"})`, `fCone`, `fEllipsoid`.
- Std **features** (`extrude`, `fillet`, `revolve`…) can be called as subfeatures: `callSubfeatureAndProcessStatus(id, extrude, context, id + "ext", {...})` (propagates info/warn/error). In code prefer `op*` directly.
- Geometry values ≠ entities: `Vector`, `Line`, `Plane`, `CoordSystem`, `Transform`, `Box3d`. Build with `vector(x, y, z) * inch`, `line(origin, dir)`, `plane(origin, normal)` / `plane(cSys)`, `coordSystem(origin, xDir, zDir)`, `toWorld(cSys)`, `fromWorld`, `rotationAround(line, angle)`, `transform(...)`, `normalize`, `norm`, `cross`, `dot`, `worldToPlane`, `planeToWorld`. Compare with `tolerantEquals`, not `==`.
- Units: every length/angle is `ValueWithUnits` (`2 * inch`, `30 * degree`, `meter`, `millimeter`, `radian`); mismatched dimensions throw; `1 * meter == 1000 * millimeter`. Same-dimension division gives plain `number`.
- Context variables: `setVariable(context, "w", 2 * inch)` / `getVariable(context, "w")` (Part Studio `#w`). Attributes: `setAttribute(context, {"entities","name","attribute"})`, `getAttribute(context, {"entity","name"})`, `qHasAttribute(name)`. Properties: `setProperty(context, {"entities","propertyType" : PropertyType.APPEARANCE, "value" : color(1, 0, 0)})`; `getProperty` only in tables/editing logic/other contexts. `setFeatureComputedParameter(context, id, {"name","value"})` feeds `#name` in "Feature Name Template".

### Sketch recipe (from tutorial 2)

```
const pts = qAdjacent(definition.edge, AdjacencyType.VERTEX, EntityType.VERTEX);
const p0 = evVertexPoint(context, { "vertex" : qNthElement(pts, 0) });
const p1 = evVertexPoint(context, { "vertex" : qNthElement(pts, 1) });
const zDir = evOwnerSketchPlane(context, { "entity" : definition.edge }).normal;
const cSys = coordSystem(p0, normalize(p1 - p0), zDir);
const sketch1 = newSketchOnPlane(context, id + "sketch1", { "sketchPlane" : plane(cSys) }); // newSketch takes a Query instead
skRectangle(sketch1, "rect1", { "firstCorner" : vector(0 * inch, w / 2), "secondCorner" : vector(norm(p1 - p0), -w / 2) });
skSolve(sketch1);                                                    // required, even without constraints
opExtrude(context, id + "extrude1", {
    "entities" : qSketchRegion(id + "sketch1")->qContainsPoint(cSys.origin),
    "direction" : zDir, "endBound" : BoundingType.THROUGH_ALL, "startBound" : BoundingType.THROUGH_ALL });
opBoolean(context, id + "boolean1", { "tools" : qCreatedBy(id + "extrude1", EntityType.BODY),
    "targets" : definition.part, "operationType" : BooleanOperationType.SUBTRACTION });
opDeleteBodies(context, id + "delete1", { "entities" : qCreatedBy(id + "sketch1", EntityType.BODY) }); // clean up
```
Sketch fns: `skLineSegment`, `skCircle`, `skArc` (start/mid/end), `skEllipse`, `skEllipticalArc`, `skRectangle`, `skRegularPolygon`, `skPolyline`, `skFitSpline`, `skBezier`, `skPoint`, `skText`, `skImage`, `skConstraint`. 2D coords are lengths in the sketch plane frame (`worldToPlane` to project 3D points). No sketch offset/fillet in FeatureScript — extrude then `opThicken`/`opFillet` instead.

## Errors, output, debugging

- `throw regenError("Message", ["paramId"], entitiesQuery);` → feature red, all its changes undone, entities highlighted. Custom messages ASCII only, ≤200 chars shown. Also `regenError(ErrorStringEnum.POINTS_COINCIDENT, ["points"])` — `ErrorStringEnum` values are NOT in the bundled docs (look them up in the Onshape "std" document source or via Feature Studio autocomplete); prefer custom strings.
- `reportFeatureWarning(context, id, "msg")`, `reportFeatureInfo(...)`; `setErrorEntities(context, id, { "entities" : q })` to highlight without failing; `verify(cond, "msg")`.
- Ops throw; catch to rephrase: `try { opFillet(...); } catch { throw regenError("Failed to fillet rib", edges); }`. `try silent { ... }` hides notice spam (use sparingly). Expression form `try(expr)` → `undefined` on error. Lang errors are usually strings; lib errors maps with `message : ErrorStringEnum`.
- `println(x)`, `print`; `"" ~ x` shows raw repr. `debug(context, queryOrVectorOrLineOrPlaneOrCSys[, DebugColor.RED])` — **visible only while that feature's dialog is open**. `startTimer("t")`/`printTimer("t")`.
- Workflow: commit → open Part Studio using the feature → notices `{!}` flyout; or "Monitor <Part Studio>" in the Feature Studio to see execution output inline (also runs typechecks on tagged values). "Profile" shows per-line timings. Keep test Part Studios for edge cases.
- Feature patterns: call `getRemainderPatternTransform(context, { "references" : qUnion([...inputs]) })` before ops, then `transformResultIfNecessary(context, id, t)` on results; otherwise custom features misbehave inside Pattern features.

## Language essentials (C/JS-like, but…)

- Semicolons mandatory; no `++`/`--`; `^` = power; `~` = string concat; `%` sign follows divisor; `??` undefined-coalescing; `?.` / `?[i]` / `?[]` safe navigation; compound ops `+= -= *= /= ^= %= ||= &&= ??= ~=`.
- `if` needs a real boolean (no truthiness: `if (x != 0)`, `if (q != undefined)`). NaN doesn't exist → error. Numbers = doubles; integers exact to 2^53.
- Value semantics everywhere: assignment/args/returns deep-copy arrays & maps. Shared mutable state only via `new box(v)`; read/write `b[]`. Lambdas capture by value.
- Arrays don't grow on write: use `append`, `concatenateArrays`, `resize`, `makeArray`, `mapArray`, `filter`, `sort`, `size`, `isValueIn` (`lib/utilities/containers.md`).
- Maps: `{ "a" : 1 }` or unquoted keys; `{ (var) : v }` to use a variable as key; missing key → `undefined`; assigning `undefined` deletes the key; `m.k += 1` on a missing key throws. Iterate `for (var k, v in m)`; one-var form gives `{ key, value }`. Map key order is a deterministic total order (not insertion order).
- Loops: `for (var i = 0; i < n; i += 1)`, `for (var x in arr)`, `for (var i, x in arr)`, `while`, `break`, `continue`.
- Lambdas: `function(x) { return x + 1; }`, `x => x + 1`, `(a is number, b) => { ... }`. Arrow call: `q->qContainsPoint(p)` ≡ `qContainsPoint(q, p)`.
- Types: standard `undefined boolean number string array map box builtin function`, plus at most one type tag. `x is Vector`, `v as Lumber`. Custom type: `export type Lumber typecheck canBeLumber;` + `export predicate canBeLumber(value) { value is map; isLength(value.length); }` + constructor `lumber(...)` returning `{...} as Lumber`. Enum value = string tagged with the enum (`"A" as MyEnum`); no trailing comma in enums.
- Top-level: `import`, `function`, `predicate` (only expression statements; all must be true), `operator+(a is MyType, b is MyType)` (overloadable `+ - * / % ^ <`), `const`, `enum`, `type`. Overloads resolved by most specific `is` constraints. Function preconditions: `function f(n is number) precondition n > 0; { ... }`.
- Namespaced import: `M::import(path : "...", version : "...");` → `M::symbol`. `export import(...)` re-exports.

## Imports & data

- Same-document tab: `import(path : "<elementId>", version : "<microversion>")` (auto-updates). Other doc: `"docId/versionId/elementId"` (pinned version; re-insert via import dialog to update). Std: `"onshape/std/<module>.fs"`.
- Uploaded tab → `BLOB_DATA` map: `csvData` (array / array of rows), `jsonData` (JSON null → `undefined`), `textData`, `imageWidth`/`imageHeight`, `dataId` (BREP → `opImportForeign`).
- Part Studio import exposes `build(configuration)`; place with `newInstantiator(id + "inst")` → `addInstance(inst, Ns::build, { "transform" : t, "configuration" : {...} })` → `instantiate(context, inst)`. List config value: `Ns::Size_conf.Small`. Variable Studio: `Ns::getVariableMap(config)` → `{ name : { value, description } }`.
- Performance: import `common.fs` unless `geometry.fs` is needed; avoid >600 modules or multiple std versions.

## Custom tables & computed properties

```
annotation { "Table Type Name" : "Part volumes" }
export const partVolumes = defineTable(function(context is Context, definition is map) returns Table
    precondition { }   // only boolean/string/enum/quantity params
    {
        var rows = [];
        for (var part in evaluateQuery(context, qAllModifiableSolidBodies()))
            rows = append(rows, tableRow({ "name" : getProperty(context, { "entity" : part, "propertyType" : PropertyType.NAME }),
                                           "volume" : evVolume(context, { "entities" : part }) }, part));
        return table("Part volumes", [tableColumnDefinition("name", "Part"), tableColumnDefinition("volume", "Volume")], rows);
    });

annotation { "Property Function Name" : "computeVolume" }
export const computeVolume = defineComputedPartProperty(function(context is Context, part is Query, definition is map) returns ValueWithUnits
    { return evVolume(context, { "entities" : part }); });   // return string|number|boolean|ValueWithUnits; import common.fs; don't throw
```
Cells: string, `ValueWithUnits`, `templateString("d = #d", { "d" : x })`, `tableCellError(v, "tooltip")`. Multiple tables → `tableArray([...])`. Pass a Query as last arg of `tableRow`/`tableColumnDefinition` for cross-highlighting. Computed props: commit, create a document version, then link in company custom properties (types Text/Double/Boolean/Value with units, category Part).

## Writing good features — checklist

1. Validate inputs in the body (`isQueryEmpty` → `throw regenError(..., ["param"])`); don't trust Filter/MaxNumberOfPicks.
2. Unique, contiguous ids; `forEachEntity` for per-entity loops.
3. Compute geometry from data you already have instead of extra `ev*` calls (consistency).
4. Delete construction bodies (sketches, tool bodies) at the end.
5. Wrap fragile ops in `try` and emit specific messages; partial failure → `reportFeatureWarning`.
6. Support feature patterns (`getRemainderPatternTransform`/`transformResultIfNecessary`) when the feature can be patterned.
7. Export everything the precondition references (enums, bounds, lookup tables).
8. Unsure of a key or enum value → grep `references/lib`, e.g. `Grep "^### opRevolve " -A 30 references/lib/modeling/geomOperations.md`, `Read references/lib/enums/boundingtype.gen.md`.
