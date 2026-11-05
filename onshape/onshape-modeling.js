// Onshape part-modeling helpers: build and edit real Part Studio features (sketch / extrude / plane /
// fillet / chamfer) from the browser, export STL. Everything is in millimeters.
//
// Inject into a cad.onshape.com tab with the chrome-devtools MCP (re-inject after any navigation):
//   evaluate_script(pageId, sourcePath: "<skill>/onshape/onshape-modeling.js", format: "script")
// Then:
//   async () => { const m = window.__om; m.use({d, w, e}); ... }
//
// Pattern used for every project: keep a local "<project>.js" builder (params at the top, one async
// build(opts) that calls these helpers), inject it after this file, run build, check m.status() and
// m.bodies(), screenshot, show the user. To change a dimension later edit the existing features in
// place (m.replaceSketch / m.setExpr): part ids, assembly references and mates survive.
//
// All writes change the user's document. Read-only: use, features, byName, evalFs, status, bodies.

(() => {
  const MM = 0.001;
  const xsrf = () => decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
  const api = async (method, path, body) => {
    const r = await fetch('/api/v6' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { j = t.slice(0, 600); }
    return { status: r.status, j };
  };
  const un = (v) => {
    if (v === null || typeof v !== 'object') return v;
    const bt = v.btType || '';
    if (/Array/.test(bt)) return v.value.map(un);
    if (/Map/.test(bt)) return Object.fromEntries(v.value.map((x) => [un(x.key), un(x.value)]));
    if ('value' in v) return un(v.value);
    return v;
  };

  // Target Part Studio. Defaults to the open tab.
  const S = { d: null, w: null, e: null };
  const use = (ids) => {
    if (!ids) {
      const m = location.pathname.match(/documents\/(\w+)\/w\/(\w+)\/e\/(\w+)/);
      ids = m ? { d: m[1], w: m[2], e: m[3] } : {};
    }
    Object.assign(S, ids);
    return { ...S };
  };
  const ps = () => `/partstudios/d/${S.d}/w/${S.w}/e/${S.e}`;

  // ---------- feature list ----------
  const brief = (r) => ({ s: r.status, id: r.j.feature?.featureId, st: r.j.featureState?.featureStatus,
    err: r.status !== 200 ? JSON.stringify(r.j).slice(0, 300) : undefined });
  const add = async (feature) => brief(await api('POST', ps() + '/features', { feature }));
  const update = async (featureId, feature) =>
    brief(await api('POST', `${ps()}/features/featureid/${encodeURIComponent(featureId)}`, { feature: { ...feature, featureId } }));
  const del = async (featureId) => (await api('DELETE', `${ps()}/features/featureid/${encodeURIComponent(featureId)}`)).status;
  const features = async () => (await api('GET', ps() + '/features')).j;
  const byName = async (name) => (await features()).features.find((f) => f.name === name);
  // Features whose state is not OK (empty array = model regenerates cleanly).
  const status = async () => {
    const f = await features();
    return f.features.map((x) => [x.name, f.featureStates[x.featureId]?.featureStatus]).filter(([, s]) => s !== 'OK');
  };

  // ---------- FeatureScript eval (read-only, nothing saved) ----------
  const evalFs = async (script) => {
    const r = await api('POST', ps() + '/featurescript', { queries: {}, script });
    return { s: r.status, result: un(r.j.result),
      notices: (r.j.notices || []).map((n) => (JSON.stringify(n).match(/"message":"([^"]*)"/) || [])[1]) };
  };
  // [name, volume mm3, min corner, max corner] per solid part.
  const bodies = async () => (await evalFs(`function(context is Context, queries) { var r = [];
    for (var b in evaluateQuery(context, qAllModifiableSolidBodies())) { const bb = evBox3d(context, {"topology" : b});
      r = append(r, [getProperty(context, {"entity" : b, "propertyType" : PropertyType.NAME}), roundToPrecision(evVolume(context, {"entities" : b}) / millimeter^3, 2),
        toString(bb.minCorner / millimeter), toString(bb.maxCorner / millimeter)]); } return r; }`)).result;
  // Deterministic ids of edges (or faces) of all parts whose bounding box b passes a FeatureScript
  // boolean expression, e.g. idsWhere('EDGE', 'b.maxCorner[2] - b.minCorner[2] > 100 * millimeter').
  // Use the ids in fillet()/chamfer(). Select geometry by measurement, never by guessing ids.
  const idsWhere = async (type, cond) => (await evalFs(`function(context is Context, queries) { var ids = [];
    for (var x in evaluateQuery(context, qOwnedByBody(qAllModifiableSolidBodies(), EntityType.${type}))) {
      const b = evBox3d(context, {"topology" : x}); if (${cond}) ids = append(ids, transientQueriesToStrings(x)); } return ids; }`)).result;

  // ---------- feature JSON builders (pure, return the feature) ----------
  // Closed polygons [[[u, v], ...], ...] in mm, sketch-plane coordinates. Line ids are p<k>l<i>, so
  // rewriting a sketch with the same polygon/vertex counts keeps every downstream face/edge id.
  const sketch = (name, planeId, polys) => {
    const entities = [], constraints = [];
    polys.forEach((pts, k) => pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const dx = (q[0] - p[0]) * MM, dy = (q[1] - p[1]) * MM, L = Math.hypot(dx, dy);
      const id = `p${k}l${i}`, nid = `p${k}l${(i + 1) % pts.length}`;
      entities.push({ btType: 'BTMSketchCurveSegment-155', entityId: id, startPointId: id + '.start', endPointId: id + '.end',
        startParam: 0, endParam: L,
        geometry: { btType: 'BTCurveGeometryLine-117', pntX: p[0] * MM, pntY: p[1] * MM, dirX: dx / L, dirY: dy / L } });
      constraints.push({ btType: 'BTMSketchConstraint-2', constraintType: 'COINCIDENT', entityId: `c${k}_${i}`, parameters: [
        { btType: 'BTMParameterString-149', parameterId: 'localFirst', value: id + '.end' },
        { btType: 'BTMParameterString-149', parameterId: 'localSecond', value: nid + '.start' }] });
    }));
    return { btType: 'BTMSketch-151', featureType: 'newSketch', name, entities, constraints, parameters: [
      { btType: 'BTMParameterQueryList-148', parameterId: 'sketchPlane',
        queries: [{ btType: 'BTMIndividualQuery-138', deterministicIds: [planeId] }] }] };
  };
  // op: 'NEW' | 'ADD' | 'REMOVE' | 'INTERSECT'. depth: '12 mm'. scope: body ids the boolean may touch
  // (an ADD/REMOVE with default scope merges into / cuts EVERY body it touches, including other parts).
  const extrude = (name, sketchId, depth, op, { opposite = false, symmetric = false, scope = null } = {}) => {
    const f = { btType: 'BTMFeature-134', featureType: 'extrude', name, parameters: [
      { btType: 'BTMParameterEnum-145', parameterId: 'bodyType', enumName: 'ExtendedToolBodyType', value: 'SOLID' },
      { btType: 'BTMParameterEnum-145', parameterId: 'operationType', enumName: 'NewBodyOperationType', value: op },
      { btType: 'BTMParameterQueryList-148', parameterId: 'entities',
        queries: [{ btType: 'BTMIndividualSketchRegionQuery-140', featureId: sketchId }] },
      { btType: 'BTMParameterEnum-145', parameterId: 'endBound', enumName: 'BoundingType', value: 'BLIND' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'depth', expression: depth },
      { btType: 'BTMParameterBoolean-144', parameterId: 'oppositeDirection', value: opposite },
      { btType: 'BTMParameterBoolean-144', parameterId: 'symmetric', value: symmetric },
      { btType: 'BTMParameterBoolean-144', parameterId: 'defaultScope', value: !scope }] };
    if (scope) f.parameters.push({ btType: 'BTMParameterQueryList-148', parameterId: 'booleanScope',
      queries: [{ btType: 'BTMIndividualQuery-138', deterministicIds: scope }] });
    return f;
  };
  const fillet = (name, ids, r) => ({ btType: 'BTMFeature-134', featureType: 'fillet', name, parameters: [
    { btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{ btType: 'BTMIndividualQuery-138', deterministicIds: ids }] },
    { btType: 'BTMParameterQuantity-147', parameterId: 'radius', expression: r },
    { btType: 'BTMParameterBoolean-144', parameterId: 'tangentPropagation', value: true }] });
  const chamfer = (name, ids, w) => ({ btType: 'BTMFeature-134', featureType: 'chamfer', name, parameters: [
    { btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{ btType: 'BTMIndividualQuery-138', deterministicIds: ids }] },
    { btType: 'BTMParameterEnum-145', parameterId: 'chamferType', enumName: 'ChamferType', value: 'EQUAL_OFFSETS' },
    { btType: 'BTMParameterQuantity-147', parameterId: 'width', expression: w },
    { btType: 'BTMParameterBoolean-144', parameterId: 'tangentPropagation', value: false }] });

  // ---------- features that need a round trip ----------
  // Offset plane from a default plane (JDC Top, JCC Front, JEC Right) or a planar face id.
  // Returns {featureId, id (plane face id for sketches), origin, xDir}. Check origin: an offset of the
  // Front plane (JCC) goes to -Y by default; pass opposite=true for +Y. xDir tells you whether sketch u
  // runs along +world X or -X on that plane (mirror your polygons if xDir[0] < 0).
  const offsetPlane = async (name, baseId, mm, opposite = false) => {
    const r = await add({ btType: 'BTMFeature-134', featureType: 'cPlane', name, parameters: [
      { btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{ btType: 'BTMIndividualQuery-138', deterministicIds: [baseId] }] },
      { btType: 'BTMParameterEnum-145', parameterId: 'cplaneType', enumName: 'CPlaneType', value: 'OFFSET' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'offset', expression: `${mm} mm` },
      { btType: 'BTMParameterBoolean-144', parameterId: 'oppositeDirection', value: opposite }] });
    // qCreatedBy(featureId) works; qTransient on the plane id does not.
    const q = await evalFs(`function(context is Context, queries) { const q = qCreatedBy(makeId("${r.id}"), EntityType.FACE);
      const p = evPlane(context, {"face" : q}); return [transientQueriesToStrings(evaluateQuery(context, q))[0], p.origin / millimeter, p.x]; }`);
    const [id, origin, xDir] = q.result;
    return { featureId: r.id, st: r.st, id, origin, xDir };
  };
  // Sketch + extrude in one call; returns {sketch, extrude}.
  const prism = async (name, planeId, polys, depth, op, opts) => {
    const s = await add(sketch(name + ' sketch', planeId, polys));
    return { sketch: s, extrude: await add(extrude(name, s.id, depth, op, opts)) };
  };

  // ---------- edit in place (keeps part ids, mates, references) ----------
  // Rewrite an existing sketch's polygons on the same plane. Same polygon and vertex counts = same
  // entity ids = downstream features keep resolving.
  const replaceSketch = async (name, polys) => {
    const old = await byName(name);
    if (!old) return { err: 'no feature ' + name };
    const plane = old.parameters.find((x) => x.parameterId === 'sketchPlane').queries[0].deterministicIds[0];
    const r = await update(old.featureId, sketch(name, plane, polys));
    return { ...r, oldEntities: old.entities.length };
  };
  // Change one quantity parameter, e.g. setExpr('Floor', 'depth', '161.2 mm').
  const setExpr = async (name, parameterId, expression) => {
    const f = await byName(name);
    if (!f) return { err: 'no feature ' + name };
    const p = f.parameters.find((x) => x.parameterId === parameterId);
    if (!p) return { err: 'no parameter ' + parameterId, have: f.parameters.map((x) => x.parameterId) };
    const before = p.expression; p.expression = expression;
    return { ...(await update(f.featureId, f)), before };
  };

  // ---------- tabs, names ----------
  const NAME = '57f3fb8efa3416c06701d60d'; // metadata property id of "Name"
  const newPartStudio = async (name) => {
    const r = await api('POST', `/partstudios/d/${S.d}/w/${S.w}`, { name });
    if (r.status === 200) S.e = r.j.id;
    return { status: r.status, e: r.j.id };
  };
  const parts = async () => (await api('GET', `/parts/d/${S.d}/w/${S.w}/e/${S.e}`)).j.map((p) => ({ name: p.name, partId: p.partId }));
  const renamePart = async (partId, name) => (await api('POST', `/metadata/d/${S.d}/w/${S.w}/e/${S.e}/p/${encodeURIComponent(partId)}`,
    { jsonType: 'metadata-part', partId, properties: [{ propertyId: NAME, value: name }] })).status;
  const renameTab = async (elementId, name) => (await api('POST', `/metadata/d/${S.d}/w/${S.w}/e/${elementId}`,
    { jsonType: 'metadata-element', properties: [{ propertyId: NAME, value: name }] })).status;

  // ---------- export ----------
  // Binary STL (mm) of one part, base64. Uses the async translation API (the synchronous
  // /parts/.../stl endpoint redirects cross-origin and fails inside the page).
  // Enums must be UPPERCASE; partIds is a plain string (an array gives 400).
  const stlBase64 = async (partId) => {
    const t = await api('POST', ps() + '/translations', { formatName: 'STL', storeInDocument: false,
      stlMode: 'BINARY', unit: 'MILLIMETER', resolution: 'FINE', partIds: partId });
    if (t.status !== 200) return { err: t.status + ' ' + JSON.stringify(t.j).slice(0, 200) };
    let st = t.j;
    for (let i = 0; i < 90 && st.requestState === 'ACTIVE'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      st = (await api('GET', `/translations/${t.j.id}`)).j;
    }
    if (st.requestState !== 'DONE') return { err: st.requestState + ' ' + st.failureReason };
    const u8 = new Uint8Array(await (await fetch(`/api/v6/documents/d/${S.d}/externaldata/${st.resultExternalDataIds[0]}`)).arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // {name: base64 STL} for every part (or the given names). Call with evaluate_script(filePath=...)
  // so the payload goes to a local JSON file instead of the conversation; feed it to stl_to_3mf.py.
  const exportStls = async (names) => {
    const out = {};
    for (const p of await parts()) if (!names || names.includes(p.name)) out[p.name] = await stlBase64(p.partId);
    return out;
  };

  // ---------- 2D geometry ----------
  const rect = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d]];
  const sq = (cx, cy, s) => rect(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2);
  const polyArea = (pl) => Math.abs(pl.reduce((s, p, i) => { const q = pl[(i + 1) % pl.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  // Flat-top regular hexagon, ff = across flats.
  const hex = (cx, cy, ff) => { const R = ff / Math.sqrt(3);
    return Array.from({ length: 6 }, (_, i) => [cx + R * Math.cos(i * Math.PI / 3), cy + R * Math.sin(i * Math.PI / 3)]); };
  // Sutherland-Hodgman clip of a polygon against an axis-aligned rectangle {u0, u1, v0, v1}.
  const clipRect = (poly, { u0, u1, v0, v1 }) => {
    const edges = [
      [(p) => p[0] >= u0, (a, b) => [u0, a[1] + (b[1] - a[1]) * (u0 - a[0]) / (b[0] - a[0])]],
      [(p) => p[0] <= u1, (a, b) => [u1, a[1] + (b[1] - a[1]) * (u1 - a[0]) / (b[0] - a[0])]],
      [(p) => p[1] >= v0, (a, b) => [a[0] + (b[0] - a[0]) * (v0 - a[1]) / (b[1] - a[1]), v0]],
      [(p) => p[1] <= v1, (a, b) => [a[0] + (b[0] - a[0]) * (v1 - a[1]) / (b[1] - a[1]), v1]]];
    let out = poly;
    for (const [inside, cut] of edges) {
      const src = out; out = [];
      src.forEach((cur, i) => {
        const prev = src[(i + src.length - 1) % src.length];
        if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); }
        else if (inside(prev)) out.push(cut(prev, cur));
      });
      if (!out.length) return [];
    }
    return out.filter((p, i) => Math.hypot(p[0] - out[(i + 1) % out.length][0], p[1] - out[(i + 1) % out.length][1]) > 0.05);
  };

  window.__om = { S, use, api, un, add, update, del, features, byName, status, evalFs, bodies, idsWhere,
    sketch, extrude, fillet, chamfer, offsetPlane, prism, replaceSketch, setExpr,
    newPartStudio, parts, renamePart, renameTab, stlBase64, exportStls,
    rect, sq, polyArea, hex, clipRect };
})();
'onshape modeling helpers loaded: window.__om (use, add, update, sketch, extrude, offsetPlane, prism, replaceSketch, setExpr, bodies, status, exportStls, ...)';
