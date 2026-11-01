# featurescript-skill

A [Claude Code](https://claude.com/claude-code) skill for writing, reading, debugging and explaining **Onshape FeatureScript**: custom features, custom tables, computed part properties, Feature Studio imports, manipulators and editing logic.

The skill has three parts:

1. **`SKILL.md`**: a compact field guide that Claude loads when a task involves FeatureScript. It covers the mental model, the feature skeleton, every precondition parameter kind, Id rules, the `q*`/`ev*`/`op*`/`sk*` vocabulary, errors, debugging and language gotchas.
2. **`references/`**: the full official documentation as greppable markdown. That's the 17 guide and language-reference pages, both tutorials, and the whole Standard Library reference (217 modules, about 1,300 symbols, one file per module, plus a symbol index). `scripts/build_references.py` generates this folder from the live docs at <https://cad.onshape.com/FsDoc/>. This repo doesn't ship it (see [Docs and copyright](#docs-and-copyright)).
3. **`onshape/`**: how Claude drives Onshape itself in your browser through the chrome-devtools MCP and Onshape's REST API, called from inside the page with your session. It reads Part Studios, pushes and commits Feature Studio code, tests FeatureScript with the eval endpoint without saving anything, creates documents, tabs and file uploads, adds features, and versions and publishes custom features. [`onshape/ONSHAPE.md`](onshape/ONSHAPE.md) is the guide, `onshape-helpers.js` holds the injectable helpers, and `wrap_js.py` turns local files into injectable JS. It's all based on a real project: [onshape-pegboard-pegs](https://github.com/rt3norio/onshape-pegboard-pegs).

The main rule the skill gives Claude: **don't guess a std-library signature or definition-map key. Look it up.** FeatureScript calls take untyped maps (`opExtrude(context, id, { "entities" : …, "endBound" : … })`). A model working from memory gets those keys subtly wrong, and the code fails only at regeneration time inside Onshape. Looking the symbol up in the index and reading its entry before writing the call avoids that.

> Português: skill do Claude Code para FeatureScript (Onshape). O `SKILL.md` é um guia condensado. O script `scripts/build_references.py` baixa a documentação oficial e a converte em markdown pesquisável (guia, referência da linguagem, tutoriais e a Standard Library inteira). Instalação: clone em `~/.claude/skills/featurescript` e rode o script uma vez.

---

## Install

Requirements: Claude Code, Python 3.8+ (standard library only, no `pip install`), and network access to `cad.onshape.com` while building.

```bash
# macOS / Linux / Git Bash
git clone https://github.com/rt3norio/featurescript-skill ~/.claude/skills/featurescript
python ~/.claude/skills/featurescript/scripts/build_references.py
```

```powershell
# Windows PowerShell
git clone https://github.com/rt3norio/featurescript-skill "$env:USERPROFILE\.claude\skills\featurescript"
python "$env:USERPROFILE\.claude\skills\featurescript\scripts\build_references.py"
```

The build takes a few seconds and ends with:

```
done: 17 guide pages, 2 tutorials, 217 modules, 1296 symbols -> .../references
```

Start a new Claude Code session, and `featurescript` shows up in the skill list. To install it for one project only, clone into `<project>/.claude/skills/featurescript` instead.

### Update

```bash
cd ~/.claude/skills/featurescript && git pull
python scripts/build_references.py   # re-fetch the docs when Onshape releases a new std version
```

The build overwrites files in place and never deletes any. If Onshape removes a module, delete `references/` before rebuilding.

---

## Usage

There's nothing to call by hand. Claude picks the skill when a request mentions FeatureScript, Onshape, a Feature Studio, a custom feature or a `.fs` file, or uses calls like `defineFeature`, `opExtrude` or `qCreatedBy`. You can also force it with `/featurescript`.

Example prompts:

- "Write a custom feature that puts a counterbored hole at every selected vertex, with a lookup table for M3/M4/M5."
- "Why does my feature fail on the second loop iteration?" The usual cause is a non-contiguous `Id` hierarchy, which the skill knows about.
- "Turn this Part Studio code ("Show code") into a reusable feature with a length parameter and a flip toggle."
- "Add a custom table listing the volume and material of every part."
- "Add a linear manipulator that drives the `depth` parameter."
- "What keys does `opSweep` take, and which ones are optional?"

How Claude answers a lookup question:

```text
1. Grep  references/lib/INDEX.md                     "opSweep"            -> modeling/geomOperations
2. Grep  references/lib/modeling/geomOperations.md   "^### opSweep " -A 40
3. Answer from that entry:
     - `profiles` (Query): Edges and faces to sweep.
     - `path` (Query): Edges that comprise the path along which to sweep. …
     - `keepProfileOrientation` (boolean): [optional] …
```

Without browser access, Claude writes the FeatureScript, and you paste it into a Feature Studio and press **Commit**. To debug, paste back the contents of the notices `{!}` flyout, or use *Monitor Part Studio* and paste what it shows.

With the [chrome-devtools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) attached to a Chrome where you're logged in to Onshape, Claude does the loop itself (see [`onshape/ONSHAPE.md`](onshape/ONSHAPE.md)):

```text
inject onshape/onshape-helpers.js into the Onshape tab
__features(ids)                 read the Part Studio you're working in
__fsEval(script, ids)           run FeatureScript tests on throwaway geometry (nothing is saved)
__pushFeatureStudio(src, ids)   save + commit the Feature Studio, check that it compiles
__addFeature / __createVersion  only with your OK; publishing goes through the Versions panel
```

Example prompts: "Read my Part Studio and turn the peg I modeled into a custom feature", "Test the feature on a 4 × 3 in plate before I use it", "Publish it and add it to my toolbar".

---

## What the skill teaches Claude

| Area | Content in `SKILL.md` |
|---|---|
| Model | Part Studio = FeatureScript `build` function; features = function calls; commit vs. live edits; regeneration triggers; determinism |
| Skeleton | `FeatureScript N;` + std import, `annotation { "Feature Type Name" … }`, `defineFeature(function(context, id, definition) precondition {…} {…}, defaults)` |
| Feature dialog | boolean / string / enum / `isLength` `isAngle` `isInteger` `isReal` `isAnything` / Query + `Filter` + `MaxNumberOfPicks` / lookup tables / arrays / groups / reference params (`PartStudioData`, `ImageData`, `TableData`, `JSONData`, `TextData`, `CADImportData`, `VariableStudioData`) / custom `LengthBoundSpec` / `UIHint` / conditional visibility / icons |
| Interaction | editing logic function signature and arguments, manipulator change function, `addManipulators` |
| Ids | hierarchy must be contiguous in history (the classic loop bug), allowed characters, `ANY_ID`, `unstableIdComponent`, `forEachEntity` |
| Modeling | queries as criteria and their order caveats; evaluations; operations; primitives; std features as subfeatures; geometry value types; units; variables, attributes, properties |
| Sketching | the coordinate-system → `newSketchOnPlane` → `sk*` → `skSolve` → region query → extrude/boolean/cleanup recipe |
| Errors & debugging | `regenError`, warnings and infos, `setErrorEntities`, `try` / `try silent`, `debug()` (visible only with the dialog open), timers, Monitor, Profile, feature-pattern support |
| Language | semicolons, no `++`, `^` and `~`, no truthiness, value semantics and `box`, map quirks, safe navigation, `->` call syntax, predicates, overloads, custom types, enums |
| Imports & data | workspace vs. version imports, `BLOB_DATA` (CSV/JSON/text/image/BREP), Part Studio instantiation and configurations, Variable Studios |
| Tables & properties | `defineTable` and `defineComputedPartProperty` templates and their constraints |
| Driving Onshape | quick start and safety rules, pointing to `onshape/ONSHAPE.md`: XSRF header, re-injecting after navigation, the eval endpoint and test harness, pushing to a Feature Studio, sketch/extrude/custom-feature JSON, the publish requirements, UI gotchas |

Every std-library function named in `SKILL.md` was checked against the generated symbol index.

---

## Repository layout

```
featurescript-skill/
├── SKILL.md                     # loaded by Claude Code (frontmatter: name, description)
├── onshape/
│   ├── ONSHAPE.md               # guide: driving Onshape via chrome-devtools MCP + in-page REST API
│   ├── onshape-helpers.js       # inject with evaluate_script(sourcePath=…, format:"script")
│   └── wrap_js.py               # local file (.fs/.svg/.png/.pdf) -> window.<var> = "…" for injection
├── scripts/
│   └── build_references.py      # FsDoc HTML -> markdown (stdlib-only Python)
└── references/                  # generated, git-ignored
    ├── guide/                   # intro, feature-types, uispec, output, variables, modeling, tables,
    │                            # computed-part-properties, imports, debugging-in-feature-studios,
    │                            # tokens, type-tags, top-level, syntax, annotations, exceptions, relational
    ├── tutorials/               # 1-create-a-slot-feature, 2-add-sketch-geometry
    └── lib/
        ├── INDEX.md             # "## modeling/geomOperations" + comma-separated symbol list
        ├── modeling/            # geomOperations (op*), evaluate (ev*), query (q*), sketch (sk*), primitives, context
        ├── math/                # units, vector, coordSystem, transform, curve/surface geometry, matrix…
        ├── utilities/           # feature, error, valueBounds, manipulator, attributes, properties, table, instantiator, debug…
        ├── features/            # std feature definitions: extrude, fillet, hole, sweep, sheetMetal*…
        └── enums/               # BoundingType, BooleanOperationType, UIHint, DebugColor… (*.gen.md)
```

Format of a library entry:

```markdown
### opExtrude (context is Context, id is Id, definition is map)

Extrudes one or more edges or faces in a given direction with one or two end conditions. …
- `definition` (`map`)
  - `entities` (`Query`): Edges and faces to extrude.
  - `direction` (`Vector`): The 3d direction in which to extrude. EX: `evOwnerSketchPlane(context, {"entity" : entities}).normal` …
  - `endBound` (`BoundingType`): The type of bound at the end of the extrusion. Cannot be `SYMMETRIC` or `UP_TO_VERTEX`. EX: `BoundingType.BLIND`
  - `endDepth` (`ValueWithUnits`): Required if `endBound` is `BLIND`. How far from the `entities` to extrude. EX: `1 * inch`
  - `startBound` (`BoundingType`): [optional] The type of start bound. …
```

### How the converter works

`build_references.py` uses only `urllib` and `html.parser`:

- **Guide and tutorial pages**: headings become `#`, `<pre>` blocks become fenced code with indentation kept, lists become `-`, and site navigation is dropped.
- **`library.html`**: the page is split at its `module-*.fs` headers into one file per module, grouped by the page's sections (Modeling, Math, Utilities, Onshape features, enums). Each `node-signature` becomes a `###` heading. Parameter tables become nested bullet lists, with `Optional` / `Required if …` and `EXAMPLE` notes kept inline. Operator overloads, which have no name in the HTML, are labeled `operator(...)`.
- Output uses LF line endings on every OS, so diffs between rebuilds stay readable.
- If the page layout changes and no module parses, the script exits non-zero.

---

## Docs and copyright

The FeatureScript documentation belongs to Onshape (PTC) and carries no open license, so this repo doesn't redistribute it. You download it yourself from the public site when you run the build script, and `references/` is in `.gitignore`. The MIT license below covers only the code and text written for this repo (`SKILL.md`, `scripts/`, this README).

The Standard Library *source code* is public inside Onshape, in the document named "std". To read an implementation, ctrl/cmd-click a symbol in a Feature Studio.

## Limitations

- Claude can't run FeatureScript. Regeneration only happens inside Onshape, so test in a Part Studio and paste the notices back.
- The docs don't list `ErrorStringEnum` values. Use custom `regenError("message")` strings, or check the values with Feature Studio autocomplete.
- The tutorials' `FeatureScript 1890;` header is only an example. Keep the version line your own Feature Studio template inserts. The `FeatureScript N;` line and the std import version must match.
- The docs show a snapshot of the latest std version. Features pinned to older std versions may behave differently.

## License

MIT, see [LICENSE](LICENSE). This applies to this repository's own content only. Onshape and FeatureScript are trademarks of PTC Inc. This project is not affiliated with or endorsed by Onshape or PTC.
