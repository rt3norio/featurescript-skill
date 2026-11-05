#!/usr/bin/env python3
"""Download Onshape's FeatureScript docs (https://cad.onshape.com/FsDoc/) and
convert them into the greppable markdown tree the skill reads:

    references/guide/*.md        guide + language reference
    references/tutorials/*.md    tutorials
    references/lib/INDEX.md      symbol index (module -> symbols)
    references/lib/<category>/<module>.md   Standard Library reference

Standard library only (no pip installs). Usage:
    python scripts/build_references.py [--out references]
"""
import argparse
import os
import re
import sys
import urllib.request
from html.parser import HTMLParser

BASE = "https://cad.onshape.com/FsDoc/"
GUIDE = ["intro", "feature-types", "uispec", "output", "variables", "modeling", "tables",
         "computed-part-properties", "imports", "debugging-in-feature-studios",
         "tokens", "type-tags", "top-level", "syntax", "annotations", "exceptions", "relational"]
TUTORIALS = {"create-a-slot-feature": "1-create-a-slot-feature",
             "add-sketch-geometry": "2-add-sketch-geometry"}
CATEGORIES = {"Modeling": "modeling", "Math": "math", "Utilities": "utilities",
              "Onshape features": "features", "enums": "enums"}


def fetch(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "onshape-skill"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8")


# ---------- guide / tutorial pages ----------

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0
        self.pre = 0

    def handle_starttag(self, t, a):
        if t in ("script", "style", "nav"):
            self.skip += 1
        if t == "pre":
            self.pre += 1
            self.out.append("\n```\n")
        if t in ("h1", "h2", "h3", "h4", "h5"):
            self.out.append("\n\n" + "#" * int(t[1]) + " ")
        if t in ("p", "div", "br", "tr", "dt", "dd", "section"):
            self.out.append("\n")
        if t == "li":
            self.out.append("\n- ")
        if t == "td":
            self.out.append(" | ")
        if t == "code" and not self.pre:
            self.out.append("`")

    def handle_endtag(self, t):
        if t in ("script", "style", "nav"):
            self.skip -= 1
        if t == "pre":
            self.pre -= 1
            self.out.append("\n```\n")
        if t == "code" and not self.pre:
            self.out.append("`")
        if t in ("p", "h1", "h2", "h3", "h4", "dd"):
            self.out.append("\n")

    def handle_data(self, d):
        if self.skip:
            return
        self.out.append(d if self.pre else re.sub(r"\s+", " ", d))


def page_to_md(html):
    p = PageParser()
    p.feed(html)
    lines, fence = [], False
    for line in "".join(p.out).split("\n"):
        if line.strip() == "```":
            fence = not fence
            lines.append("```")
            continue
        lines.append(line.rstrip() if fence else line.strip())
    t = "\n".join(lines)
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = re.sub(r"```\n\n", "```\n", t)
    start = re.search(r"^# ", t, re.M)  # drop site navigation before the page title
    return t[start.start():] if start else t


# ---------- standard library (library.html) ----------

class LibParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.mods = []  # (category, module, [chunks])
        self.cat = None
        self.cur = None
        self.skip = 0
        self.pre = 0
        self.in_h2 = False
        self.h2txt = ""
        self.h2id = None
        self.sig = False
        self.cell = None
        self.row = None
        self.rowclass = None
        self.thead = False
        self.ncell = -1

    def w(self, t):
        if self.cur is None:
            return
        if self.cell is not None:
            self.row[self.cell] += t
        else:
            self.cur[2].append(t)

    def handle_starttag(self, t, a):
        a = dict(a)
        cls = a.get("class") or ""
        if t in ("script", "style", "nav"):
            self.skip += 1
            return
        if self.skip:
            return
        if t == "h2":
            self.in_h2, self.h2txt, self.h2id = True, "", a.get("id")
            return
        if t == "p" and "node-signature" in cls:
            self.sig = True
            self.w("\n\n### ")
            return
        if t == "thead":
            self.thead = True
        if t == "tr" and not self.thead:
            self.row, self.rowclass, self.ncell = ["", "", ""], cls, -1
        if t == "td" and self.row is not None:
            self.ncell += 1
            self.cell = min(self.ncell, 2)
        if t == "pre":
            self.pre += 1
            self.w("\n```\n")
        if t == "code" and not self.pre and not self.sig:
            self.w("`")
        if t == "p" and "fs-example-label" in cls:
            self.w(" EX: ")
            return
        if t in ("p", "div", "br"):
            self.w("\n" if self.cell is None else " ")
        if t == "li" and self.cell is None:
            self.w("\n- ")
        if t in ("h3", "h4"):
            self.w("\n\n#### ")

    def handle_endtag(self, t):
        if t in ("script", "style", "nav"):
            self.skip -= 1
            return
        if self.skip:
            return
        if t == "h2":
            self.in_h2 = False
            if self.h2id and self.h2id.startswith("module-"):
                self.cur = (self.cat, self.h2id[7:], [f"# {self.h2id[7:]}\n"])
                self.mods.append(self.cur)
            else:
                self.cat, self.cur = self.h2txt.strip(), None
            return
        if t == "p" and self.sig:
            self.sig = False
            self.w("\n")
            return
        if t == "thead":
            self.thead = False
        if t == "tr" and self.row is not None and not self.thead:
            n, ty, d = [re.sub(r"\s+", " ", x).strip() for x in self.row]
            ind = "  " if "subfield" in (self.rowclass or "") else ""
            self.cell, self.row = None, None
            self.w(f"\n{ind}- {n}" + (f" ({ty})" if ty else "") + (f": {d}" if d else ""))
            return
        if t == "pre":
            self.pre -= 1
            self.w("\n```\n")
        if t == "code" and not self.pre and not self.sig:
            self.w("`")
        if t == "p" and self.cell is None:
            self.w("\n")

    def handle_data(self, d):
        if self.skip:
            return
        if self.in_h2:
            self.h2txt += d
            return
        self.w(d if self.pre else re.sub(r"\s+", " ", d))


def clean_module(t):
    t = t.replace("\xa0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n (?=\S)", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = re.sub(r"(?<!`)``(?!`)", "", t)                    # empty inline code
    t = re.sub(r"^`\n", "```\n", t, flags=re.M)            # <code> blocks used as fences
    t = re.sub(r"\n`$", "\n```", t, flags=re.M)
    t = re.sub(r"^###\s+", "### ", t, flags=re.M)
    t = re.sub(r"^### \(", "### operator(", t, flags=re.M)  # operator overloads have no name in the HTML
    t = re.sub(r"^\s*ParameterTypeAdditional Info\s*\n", "", t, flags=re.M)
    t = t.replace("EX: EXAMPLE", "EX:").replace("EX: EX:", "EX:")
    t = re.sub(r"\): Optional ", "): [optional] ", t)
    return t


def build_lib(html, outdir):
    p = LibParser()
    p.feed(html)
    index = []
    for cat, mod, chunks in p.mods:
        sub = CATEGORIES.get(cat, "other")
        name = mod[:-3] if mod.endswith(".fs") else mod
        text = clean_module("".join(chunks))
        os.makedirs(os.path.join(outdir, sub), exist_ok=True)
        with open(os.path.join(outdir, sub, name + ".md"), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        sigs = re.findall(r"^### (.+)$", text, re.M)
        names = sorted({n for n in (re.split(r"[\s(]", s.strip())[0] for s in sigs) if n})
        index.append((sub, name, names))
    with open(os.path.join(outdir, "INDEX.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("# Standard library symbol index (module -> symbols)\n\nFile: lib/<category>/<module>.md\n")
        for sub, name, names in index:
            f.write(f"\n## {sub}/{name}\n" + ", ".join(names) + "\n")
    return len(p.mods), sum(len(n) for _, _, n in index)


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(here, "references"), help="output dir (default: <skill>/references)")
    args = ap.parse_args()

    for sub in ("guide", "tutorials", "lib"):
        os.makedirs(os.path.join(args.out, sub), exist_ok=True)

    for page in GUIDE:
        print(f"guide/{page}")
        with open(os.path.join(args.out, "guide", page + ".md"), "w", encoding="utf-8", newline="\n") as f:
            f.write(page_to_md(fetch(page + ".html")))
    for page, name in TUTORIALS.items():
        print(f"tutorials/{name}")
        with open(os.path.join(args.out, "tutorials", name + ".md"), "w", encoding="utf-8", newline="\n") as f:
            f.write(page_to_md(fetch(f"tutorials/{page}.html")))

    print("library.html (~1.8 MB)...")
    mods, syms = build_lib(fetch("library.html"), os.path.join(args.out, "lib"))
    print(f"done: {len(GUIDE)} guide pages, {len(TUTORIALS)} tutorials, {mods} modules, {syms} symbols -> {args.out}")
    if mods == 0:
        sys.exit("library.html layout changed: no modules parsed")


if __name__ == "__main__":
    main()
