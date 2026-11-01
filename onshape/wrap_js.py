#!/usr/bin/env python3
"""Wrap a local file into a one-line JS script that sets a window variable, so it can be
pushed into an Onshape tab with chrome-devtools evaluate_script(sourcePath=..., format="script").

Text files (.fs, .svg, .txt, .json, .csv, .html, .md) become a JSON string;
everything else (png, jpg, pdf, ...) becomes base64 (pass it to __uploadBlob as {base64: ...}).

Usage:
    python wrap_js.py <input> <varName> <output.js> [--base64 | --text]
Example:
    python wrap_js.py myFeature.fs __src /tmp/src.js
    -> evaluate_script(sourcePath="/tmp/src.js", format="script")
    -> async () => await __pushFeatureStudio(window.__src, {d, w, e})
"""
import base64
import json
import os
import sys

TEXT_EXT = {".fs", ".svg", ".txt", ".json", ".csv", ".html", ".htm", ".md", ".js", ".xml"}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if len(args) != 3:
        sys.exit(__doc__)
    src, name, out = args
    as_text = "--text" in flags or ("--base64" not in flags and os.path.splitext(src)[1].lower() in TEXT_EXT)
    if as_text:
        value = open(src, encoding="utf-8").read()
    else:
        value = base64.b64encode(open(src, "rb").read()).decode()
    # Trailing "0" keeps evaluate_script from echoing the whole payload back.
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"window.{name} = {json.dumps(value)};0")
    print(f"{out}: window.{name} = {'text' if as_text else 'base64'} ({len(value)} chars)")


if __name__ == "__main__":
    main()
