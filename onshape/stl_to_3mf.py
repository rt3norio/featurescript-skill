#!/usr/bin/env python3
"""Onshape STL export (JSON of base64 binary STLs, one per part) -> one 3MF with every part as a
named object, rotated into its print orientation, dropped on the bed and laid out in rows.

The JSON comes from window.__om.exportStls() saved with evaluate_script(filePath=...):
    {"Base": "<base64 binary STL>", "Lid": "...", ...}

usage:
    python stl_to_3mf.py parts.json out.3mf [--rot "Lid=x180" --rot "Tower*=y90"] [--bed 320x320] [--gap 8]
                                            [--only "Base,Lid"] [--copies "Pin=4"]

--rot NAME=SPEC   rotate a part before laying it on the bed. SPEC is a sequence of axis+degrees
                  (multiples of 90), applied left to right, e.g. x90, y-90, x90z180. NAME may end in *.
                  Pick the rotation so the face that must touch the bed ends up at the minimum Z.
--bed WxH         bed size in mm used for the row layout (objects are centered on it).
--only a,b        export only these parts.
--copies NAME=N   repeat a part N times.

Only stdlib. Prints each object's size so you can check the orientation before opening the slicer.
"""
import argparse
import base64
import fnmatch
import json
import math
import struct
import zipfile


def read_stl(b64):
    data = base64.b64decode(b64)
    if data[:5] == b'solid' and b'facet' in data[:2000]:
        v = [tuple(float(x) for x in l.split()[1:4]) for l in data.decode().splitlines() if l.strip().startswith('vertex')]
        return [v[i:i + 3] for i in range(0, len(v), 3)]
    n = struct.unpack('<I', data[80:84])[0]
    out = []
    for i in range(n):
        f = struct.unpack('<12f', data[84 + 50 * i:84 + 50 * i + 48])
        out.append([f[3:6], f[6:9], f[9:12]])
    return out


def rot_matrix(spec):
    """'x90y-90' -> 3x3 proper rotation (det +1, so triangle winding stays valid)."""
    m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    i = 0
    while i < len(spec):
        axis = spec[i].lower(); i += 1
        j = i
        while j < len(spec) and (spec[j] in '+-' or spec[j].isdigit()):
            j += 1
        deg = int(spec[i:j]); i = j
        c, s = round(math.cos(math.radians(deg))), round(math.sin(math.radians(deg)))
        r = {'x': [[1, 0, 0], [0, c, -s], [0, s, c]],
             'y': [[c, 0, s], [0, 1, 0], [-s, 0, c]],
             'z': [[c, -s, 0], [s, c, 0], [0, 0, 1]]}[axis]
        m = [[sum(r[a][k] * m[k][b] for k in range(3)) for b in range(3)] for a in range(3)]
    return m


def mesh(tris, m):
    idx, verts, faces = {}, [], []
    for t in tris:
        ids = []
        for p in t:
            q = tuple(round(sum(m[a][k] * p[k] for k in range(3)), 5) for a in range(3))
            if q not in idx:
                idx[q] = len(verts); verts.append(q)
            ids.append(idx[q])
        if len(set(ids)) == 3:
            faces.append(ids)
    xs, ys, zs = zip(*verts)
    off = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs))  # centre on XY, drop to bed
    verts = [(x - off[0], y - off[1], z - off[2]) for x, y, z in verts]
    return verts, faces, (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('json'); ap.add_argument('out')
    ap.add_argument('--rot', action='append', default=[])
    ap.add_argument('--bed', default='320x320')
    ap.add_argument('--gap', type=float, default=8)
    ap.add_argument('--only', default='')
    ap.add_argument('--copies', action='append', default=[])
    a = ap.parse_args()

    parts = json.load(open(a.json, encoding='utf-8'))
    bad = {k: v for k, v in parts.items() if not isinstance(v, str)}
    if bad:
        raise SystemExit(f'export errors: {bad}')
    if a.only:
        keep = [s.strip() for s in a.only.split(',')]
        parts = {k: v for k, v in parts.items() if k in keep}
    rots = [r.split('=', 1) for r in a.rot]
    copies = {k: int(v) for k, v in (c.split('=', 1) for c in a.copies)}
    bw, bh = (float(x) for x in a.bed.lower().split('x'))

    objs = []
    for name, b64 in parts.items():
        spec = next((s for pat, s in rots if fnmatch.fnmatch(name, pat)), '')
        verts, faces, size = mesh(read_stl(b64), rot_matrix(spec))
        for k in range(copies.get(name, 1)):
            objs.append((name if k == 0 else f'{name} {k + 1}', verts, faces, size))
        print(f'{name:30s} rot={spec or "-":10s} {size[0]:7.1f} x {size[1]:7.1f} x {size[2]:6.1f} mm  {len(faces)} tris')

    # Shelf layout: rows along X, biggest footprint first.
    order = sorted(range(len(objs)), key=lambda i: -objs[i][3][1])
    place, x, y, row_h = {}, 0.0, 0.0, 0.0
    for i in order:
        w, h = objs[i][3][0], objs[i][3][1]
        if x > 0 and x + w > bw:
            x, y, row_h = 0.0, y + row_h + a.gap, 0.0
        place[i] = (x + w / 2, y + h / 2)
        x += w + a.gap; row_h = max(row_h, h)
    used_w = max(px + objs[i][3][0] / 2 for i, (px, py) in place.items())
    used_h = max(py + objs[i][3][1] / 2 for i, (px, py) in place.items())
    if used_w > bw or used_h > bh:
        print(f'warning: layout {used_w:.0f} x {used_h:.0f} mm does not fit {bw:.0f} x {bh:.0f}; '
              'the slicer can split it over plates (Arrange)')
    ox, oy = (bw - used_w) / 2, (bh - used_h) / 2

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
             ' <resources>']
    for i, (name, verts, faces, _) in enumerate(objs, 1):
        lines += [f'  <object id="{i}" type="model" name="{name}">', '   <mesh>', '    <vertices>']
        lines += [f'     <vertex x="{vx:.5f}" y="{vy:.5f}" z="{vz:.5f}"/>' for vx, vy, vz in verts]
        lines += ['    </vertices>', '    <triangles>']
        lines += [f'     <triangle v1="{p}" v2="{q}" v3="{r}"/>' for p, q, r in faces]
        lines += ['    </triangles>', '   </mesh>', '  </object>']
    lines += [' </resources>', ' <build>']
    for i in range(len(objs)):
        px, py = place[i]
        lines.append(f'  <item objectid="{i + 1}" transform="1 0 0 0 1 0 0 0 1 {px + ox:.3f} {py + oy:.3f} 0"/>')
    lines += [' </build>', '</model>']

    with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr('3D/3dmodel.model', '\n'.join(lines))
    print(f'{a.out}: {len(objs)} objects, layout {used_w:.0f} x {used_h:.0f} mm')


if __name__ == '__main__':
    main()
