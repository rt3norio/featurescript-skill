// Onshape assembly helpers: insert a Part Studio, create mate connectors, mates (fastened / slider
// with limits) and mate groups through the REST API. Fix and exploded views are UI-only (see
// ONSHAPE.md section "Assemblies").
//
// Inject after onshape-modeling.js is not required; this file is standalone:
//   evaluate_script(pageId, sourcePath: "<skill>/onshape/onshape-assembly.js", format: "script")
//   async () => { const a = window.__oa; a.use({d, w, a: assemblyId, ps: partStudioId}); ... }
//
// Strategy that works: every part keeps the position it has in the Part Studio. Each part gets ONE
// assembly-level mate connector placed exactly at the world origin (origin on a real vertex of the part,
// then translated by minus that vertex). Fastened mates between such connectors keep parts where they
// were modeled; sliders use connectors rotated so their Z axis is the slide direction.

(() => {
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
  const S = { d: null, w: null, a: null, ps: null };
  const use = (ids) => Object.assign(S, ids);
  const asm = () => `/assemblies/d/${S.d}/w/${S.w}/e/${S.a}`;

  const num = (id, e) => ({ btType: 'BTMParameterQuantity-147', parameterId: id, expression: e });
  const nnum = (id, e) => ({ btType: 'BTMParameterNullableQuantity-807', parameterId: id, expression: e, isNull: false });
  const en = (id, enumName, value) => ({ btType: 'BTMParameterEnum-145', parameterId: id, enumName, value });
  const bool = (id, value) => ({ btType: 'BTMParameterBoolean-144', parameterId: id, value });
  const brief = (r) => ({ s: r.status, id: r.j.feature?.featureId, st: r.j.featureState?.featureStatus,
    err: r.status !== 200 ? JSON.stringify(r.j).slice(0, 300) : undefined });
  const add = async (feature) => brief(await api('POST', asm() + '/features', { feature }));
  const update = async (featureId, feature) =>
    brief(await api('POST', `${asm()}/features/featureid/${encodeURIComponent(featureId)}`, { feature: { ...feature, featureId } }));
  // Feature ids in assemblies can contain '/', '+': always encodeURIComponent them in URLs.
  const del = async (featureId) => (await api('DELETE', `${asm()}/features/featureid/${encodeURIComponent(featureId)}`)).status;
  const features = async () => (await api('GET', asm() + '/features')).j;
  const status = async () => {
    const f = await features();
    return f.features.map((x) => [x.featureType, x.name, f.featureStates[x.featureId]?.featureStatus]).filter(([, , s]) => s !== 'OK');
  };

  // Insert every part of a Part Studio (each part lands where it was modeled).
  const insertPartStudio = async (psId = S.ps) =>
    (await api('POST', asm() + '/instances', { documentId: S.d, elementId: psId, isWholePartStudio: true, includePartTypes: ['PARTS'] })).status;
  // [{name, id (instance id = occurrence path element), partId}]
  const instances = async () => (await api('GET', asm())).j.rootAssembly.instances
    .map((i) => ({ name: i.name, id: i.id, partId: i.partId }));
  // Translation (mm) of every occurrence; after mating everything should still read [0, 0, 0].
  const positions = async () => Object.fromEntries((await api('GET', asm())).j.rootAssembly.occurrences
    .map((o) => [o.path.join('/'), [3, 7, 11].map((i) => +(o.transform[i] * 1000).toFixed(3))]));

  // A real vertex of the part (deterministic id + position in mm) from the Part Studio.
  const vertexOf = async (partId, pick = (vs) => vs[0]) => {
    const b = (await api('GET', `/parts/d/${S.d}/w/${S.w}/e/${S.ps}/partid/${encodeURIComponent(partId)}/bodydetails`)).j.bodies[0];
    const v = pick(b.vertices);
    return { id: v.id, p: [v.point.x, v.point.y, v.point.z].map((t) => +(t * 1000).toFixed(4)) };
  };

  // Mate connector at the world origin, owned by instance instId.
  // slideAxis: undefined (world axes), 'X' or 'Y' -> connector Z points along that world axis (for sliders).
  // Origin must be an inference of type POINT on a vertex id from bodydetails. CENTROID, transient ids and
  // Part-Studio-level mate connectors referenced from the assembly all failed ("Missing mate connector").
  const connector = async (name, instId, partId, slideAxis) => {
    const v = await vertexOf(partId);
    const params = [
      en('originType', 'Origin type', 'ON_ENTITY'),
      { btType: 'BTMParameterQueryWithOccurrenceList-67', parameterId: 'originQuery', queries: [
        { btType: 'BTMInferenceQueryWithOccurrence-1083', inferenceType: 'POINT', path: [instId], deterministicIds: [v.id] }] },
      bool('transform', true),
      num('translationX', `${-v.p[0]} mm`), num('translationY', `${-v.p[1]} mm`), num('translationZ', `${-v.p[2]} mm`)];
    if (slideAxis === 'Y') params.push(en('rotationType', 'Rotation axis', 'ABOUT_X'), num('rotation', '-90 deg'));
    if (slideAxis === 'X') params.push(en('rotationType', 'Rotation axis', 'ABOUT_Y'), num('rotation', '90 deg'));
    return { ...(await add({ btType: 'BTMMateConnector-66', featureType: 'mateConnector', name, parameters: params })), vertex: v };
  };

  // Mate between two assembly connectors. type: FASTENED | SLIDER | REVOLUTE | CYLINDRICAL | PLANAR | ...
  // limits (sliders): {min: '-8 mm', max: '16 mm'}.
  const mcRef = (featureId) => ({ btType: 'BTMFeatureQueryWithOccurrence-157', path: [], featureId, queryData: '' });
  const mate = async (name, type, mcA, mcB, limits) => {
    const parameters = [en('mateType', 'Mate type', type),
      { btType: 'BTMParameterQueryWithOccurrenceList-67', parameterId: 'mateConnectorsQuery', queries: [mcRef(mcA), mcRef(mcB)] }];
    if (limits) parameters.push(bool('limitsEnabled', true), nnum('limitZMin', limits.min), nnum('limitZMax', limits.max));
    return add({ btType: 'BTMMate-64', featureType: 'mate', name, parameters });
  };
  // Mate group: instances that move together. Parameter id is occurrencesQuery ("occurrences" -> ERROR).
  const group = async (name, instIds) => add({ btType: 'BTMMateGroup-65', featureType: 'mateGroup', name, parameters: [
    { btType: 'BTMParameterQueryWithOccurrenceList-67', parameterId: 'occurrencesQuery',
      queries: instIds.map((id) => ({ btType: 'BTMIndividualOccurrenceQuery-626', path: [id] })) }] });

  // After a Part Studio edit moves the vertex a connector sits on: re-read the vertex and reset the
  // translation so the connector is back at the world origin (check positions() afterwards).
  const recenter = async (connectorName, partId) => {
    const f = (await features()).features.find((x) => x.name === connectorName);
    const id = f.parameters.find((p) => p.parameterId === 'originQuery').queries[0].deterministicIds[0];
    const v = await vertexOf(partId, (vs) => vs.find((x) => x.id === id));
    ['X', 'Y', 'Z'].forEach((k, i) => { f.parameters.find((p) => p.parameterId === 'translation' + k).expression = `${-v.p[i]} mm`; });
    return { ...(await update(f.featureId, f)), vertex: v };
  };

  window.__oa = { S, use, api, add, update, del, features, status, insertPartStudio, instances, positions,
    vertexOf, connector, mate, group, recenter, num, nnum, en, bool };
})();
'onshape assembly helpers loaded: window.__oa (use, insertPartStudio, instances, connector, mate, group, recenter, positions, status)';
