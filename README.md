# onshape-skill

A [Claude Code](https://claude.com/claude-code) skill for working in **Onshape** together with Claude: designing 3D-printable parts and assemblies, reading and editing Part Studios, and writing, testing and publishing **FeatureScript**.

With the [chrome-devtools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) attached to a Chrome where you're logged in to Onshape, Claude works in your real documents. It calls Onshape's REST API from inside the page with your session, so there are no API keys or OAuth to set up. Without browser access it still writes FeatureScript for you to paste.

> Português: skill do Claude Code para Onshape. Modela peças para impressão 3D direto no seu Onshape (sketches e extrudes de verdade, criados por um script parametrizado), ajusta no lugar sem quebrar a montagem, faz test fit de tolerância, monta assembly com mates e exporta STL/3MF. Também escreve, testa e publica FeatureScript. Instalação: clone em `~/.claude/skills/onshape` e rode `scripts/build_references.py` uma vez.

---

## What it does

| Mode | How Claude works |
|---|---|
| **Printable part** (holder, box, jig, multi-part kit) | Asks only the questions that change the design. Creates a new document, writes a local builder script with every dimension as a parameter, and runs it to create ordinary Part Studio features (sketches, extrudes, offset planes, chamfers) that you can open and edit by hand. Checks that every feature regenerates, measures part volumes and sizes, then screenshots and reports to you. Later changes edit the existing features in place, so part ids, assembly connectors and mates survive. Before parts that slot together, it models a tolerance test-fit coupon for you to print. Exports only after you approve the design. |
| **Assembly** | Inserts the Part Studio and puts one mate connector per part at the world origin, so every part stays where it was modeled. Adds fastened and slider mates (with limits) and mate groups. Fixing a part and building exploded views happen in the UI. |
| **Export** | Exports each part as STL through the translation API, then `stl_to_3mf.py` packs them into one 3MF. Each part is named, rotated to its print orientation and laid on the bed, ready for the slicer. |
| **Custom feature** (FeatureScript) | Writes the `.fs` file, looking up every std-library call instead of guessing. Tests it against throwaway geometry with the FeatureScript eval endpoint, which saves nothing. Pushes and commits it to a Feature Studio, adds it to a Part Studio, then versions and publishes it. |
| **Inspect / fix** | Reads Part Studio features, measures geometry with FeatureScript, renames parts and tabs, and edits sketches and parameters. |

Main rules the skill gives Claude:
- **Ask before anything outward-facing**: exporting for print, deleting tabs, making documents public, versions, publishing.
- **Don't guess a FeatureScript std-library signature or definition-map key.** Look it up in the bundled reference.
- **Edit models in place** instead of rebuilding them, so assemblies don't break.

---

## Install

Requirements: Claude Code, Python 3.8+ (standard library only), network access to `cad.onshape.com` while building the references. For the browser workflow you also need the chrome-devtools MCP connected to your Chrome.

```bash
# macOS / Linux / Git Bash
git clone https://github.com/rt3norio/onshape-skill ~/.claude/skills/onshape
python ~/.claude/skills/onshape/scripts/build_references.py
```

```powershell
# Windows PowerShell
git clone https://github.com/rt3norio/onshape-skill "$env:USERPROFILE\.claude\skills\onshape"
python "$env:USERPROFILE\.claude\skills\onshape\scripts\build_references.py"
```

The build takes a few seconds and ends with `done: 17 guide pages, 2 tutorials, 217 modules, 1296 symbols -> …/references`. Start a new Claude Code session; `onshape` shows up in the skill list. You can also force it with `/onshape`.

Update: `git pull`, then rerun `build_references.py` when Onshape releases a new std version.

---

## Example prompts

- "My bread pan is 17.5 × 13.5 × 14 cm. Design a slicing guide in Onshape that I can 3D-print, with several slice thicknesses."
- "Make the stop thinner, use a honeycomb pattern instead of the posts, keep both versions."
- "Make a test fit with different clearances so we can pick the right one." Then: "0.1 was best for the big joint, use 0.2 for the removable pin."
- "Create the assembly: fix the base, mate everything, add an exploded view."
- "Approved, export the 3MF to my Desktop."
- "Read my Part Studio and turn the peg I modeled into a custom feature, test it on a 4 × 3 in plate, then publish it."
- "What keys does `opSweep` take, and which ones are optional?"

---

## Repository layout

```
onshape-skill/
├── SKILL.md                     # loaded by Claude Code: modes, connecting, printable-part and FeatureScript workflows
├── onshape/
│   ├── ONSHAPE.md               # the guide (§1-9 API/FeatureScript/publishing, §10-15 printed parts, assemblies, export, test fits)
│   ├── onshape-helpers.js       # __api, __features, __fsEval, __pushFeatureStudio, __uploadBlob, UI helpers
│   ├── onshape-modeling.js      # __om: sketch/extrude/plane/fillet/chamfer, edit in place, measure, rename, export STL
│   ├── onshape-assembly.js      # __oa: insert, mate connectors at the origin, mates, groups
│   ├── stl_to_3mf.py            # STL JSON -> named, oriented, laid-out 3MF
│   └── wrap_js.py               # local file -> injectable JS
├── featurescript/
│   └── FEATURESCRIPT.md         # FeatureScript field guide
├── scripts/
│   └── build_references.py      # FsDoc HTML -> markdown (stdlib-only Python)
└── references/                  # generated, git-ignored: guide/, tutorials/, lib/ (INDEX.md + one file per std module)
```

The JS helpers are injected into the Onshape tab with `evaluate_script(pageId, sourcePath="<skill>/onshape/<file>.js", format="script")`. They're plain same-origin `fetch` calls to `/api/v6`. Writes add the `X-XSRF-TOKEN` header from the session cookie.

### FeatureScript reference

`build_references.py` uses only `urllib` and `html.parser`. It converts the guide and tutorial pages to markdown, and splits `library.html` into one file per std module (`### signature` headings, parameter tables as bullet lists with `Optional` / `Required if …` / `EXAMPLE` notes), plus a symbol index. Claude answers lookup questions like this:

```text
1. Grep  references/lib/INDEX.md                     "opSweep"            -> modeling/geomOperations
2. Grep  references/lib/modeling/geomOperations.md   "^### opSweep " -A 40
3. Answer from that entry
```

---

## Docs and copyright

The FeatureScript documentation belongs to Onshape (PTC) and has no open license, so this repo doesn't redistribute it. The build script downloads it from the public site, and `references/` is in `.gitignore`. The MIT license covers only this repository's own content.

## Limitations

- The Onshape work needs the chrome-devtools MCP and a logged-in Chrome tab. Without it, Claude only writes code and instructions.
- A few things have no working API and go through the UI: fixing a part in an assembly, exploded views, and publishing FeatureScript. They're more fragile because Claude has to find buttons from screenshots.
- Free Onshape accounts can only create public documents.
- The docs don't list `ErrorStringEnum` values. Use custom `regenError("message")` strings.

## License

MIT, see [LICENSE](LICENSE). Onshape and FeatureScript are trademarks of PTC Inc. This project is not affiliated with or endorsed by Onshape or PTC.
