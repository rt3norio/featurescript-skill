// Onshape browser helpers for agents.
//
// Inject into a cad.onshape.com tab with the chrome-devtools MCP:
//   evaluate_script(pageId, sourcePath: "<skill>/onshape/onshape-helpers.js", format: "script")
// Then call them from later evaluate_script calls, e.g.
//   async () => await window.__api('GET', '/documents/d/<d>/w/<w>/elements')
// Any page navigation (including Onshape switching documents by itself) wipes window.*: re-inject.
//
// All calls are same-origin fetches to /api/v6 using the user's session cookies.
// Writes (POST/DELETE) need the X-XSRF-TOKEN header (value of the XSRF-TOKEN cookie), else 401.

(() => {
    const xsrf = () => decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');

    const readBody = async (r) => {
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return t.slice(0, 2000); }
    };

    // Ids of the tab currently open: { d, wvm: 'w'|'v'|'m', w, e }.
    window.__ids = () => {
        const m = location.pathname.match(/documents\/(\w+)\/([wvm])\/(\w+)\/e\/(\w+)/);
        return m ? { d: m[1], wvm: m[2], w: m[3], e: m[4] } : null;
    };

    // Generic REST call. path starts after /api/v6, e.g. '/documents/d/<d>/w/<w>/elements'.
    window.__api = async (method, path, body) => {
        const r = await fetch('/api/v6' + path, {
            method,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: r.status, j: await readBody(r) };
    };

    // Turns BTFSValue* trees returned by the FeatureScript eval endpoint into plain JSON.
    window.__unwrap = (v) => {
        if (v === null || typeof v !== 'object') return v;
        const bt = v.btType || v.typeName || '';
        if (/Array/.test(bt)) return v.value.map(window.__unwrap);
        if (/Map/.test(bt)) return Object.fromEntries(v.value.map((e) => [window.__unwrap(e.key), window.__unwrap(e.value)]));
        if ('value' in v) return window.__unwrap(v.value);
        return v;
    };

    // Runs FeatureScript against a Part Studio's context WITHOUT saving anything.
    // script must be 'function(context is Context, queries) { ... return ...; }'.
    // Returns { status, result, notices (messages), console }.
    window.__fsEval = async (script, ids = window.__ids()) => {
        const r = await window.__api('POST', `/partstudios/d/${ids.d}/w/${ids.w}/e/${ids.e}/featurescript`,
            { script, queries: {} }); // queries must be a MAP; an array gives 400
        if (r.status !== 200) return { status: r.status, raw: r.j };
        return {
            status: r.status,
            result: window.__unwrap(r.j.result),
            notices: (r.j.notices || []).map((n) => {
                const s = JSON.stringify(n);
                const msg = (s.match(/"message":"([^"]*)"/) || [])[1];
                const line = (s.match(/"line":(\d+)/) || [])[1];
                return line ? `${msg} (line ${line})` : msg || s.slice(0, 300);
            }),
            console: r.j.console
        };
    };

    // Readable summary of a Part Studio's feature list (sketch geometry, constraints, parameters).
    window.__features = async (ids = window.__ids()) => {
        const r = await window.__api('GET', `/partstudios/d/${ids.d}/${ids.wvm || 'w'}/${ids.w}/e/${ids.e}/features`);
        if (r.status !== 200) return r;
        const simp = (p) => {
            if (p.expression !== undefined) return p.expression;
            if (p.value !== undefined && typeof p.value !== 'object') return p.value;
            if (p.queries) return p.queries.map((q) => q.queryString || (q.deterministicIds || []).join('|') || q.featureId || q.btType);
            if (p.items) return p.items.map((it) => Object.fromEntries((it.parameters || []).map((x) => [x.parameterId, simp(x)])));
            return undefined;
        };
        return {
            states: Object.fromEntries(Object.entries(r.j.featureStates || {}).map(([k, s]) => [k, s.featureStatus])),
            features: r.j.features.map((f) => {
                const o = { name: f.name, type: f.featureType, id: f.featureId };
                if (f.namespace) o.namespace = f.namespace;
                if (f.suppressed) o.suppressed = true;
                for (const p of f.parameters || []) {
                    if (p.parameterId === 'initEntities') continue;
                    const v = simp(p);
                    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) o[p.parameterId] = v;
                }
                if (f.entities) o.entities = f.entities.map((e) => e.entityId + ' ' + (e.isConstruction ? '(construction) ' : '')
                    + JSON.stringify(e.geometry || {}).replace(/"btType":"[^"]+",?/g, '').slice(0, 160));
                if (f.constraints) o.constraints = f.constraints.map((c) => c.constraintType + ' '
                    + (c.parameters || []).map((p) => p.parameterId + '=' + (p.expression ?? p.value ?? '')).join(','));
                return o;
            })
        };
    };

    // Feature Studio: read, replace (= edit + commit), list compiled feature specs.
    window.__readFeatureStudio = async (ids) =>
        (await window.__api('GET', `/featurestudios/d/${ids.d}/w/${ids.w}/e/${ids.e}`)).j;

    window.__featureSpecs = async (ids) => {
        const s = (await window.__api('GET', `/featurestudios/d/${ids.d}/w/${ids.w}/e/${ids.e}/featurespecs`)).j;
        return (s.featureSpecs || []).map((f) => ({
            name: f.featureTypeName, featureType: f.featureType, namespace: f.namespace,
            params: (f.parameters || []).map((p) => p.parameterId),
            iconUri: f.iconUri, descriptionImageUri: f.descriptionImageUri, nameTemplate: f.featureNameTemplate
        }));
    };

    window.__pushFeatureStudio = async (contents, ids) => {
        const cur = await window.__readFeatureStudio(ids);
        const r = await window.__api('POST', `/featurestudios/d/${ids.d}/w/${ids.w}/e/${ids.e}`, {
            contents, serializationVersion: cur.serializationVersion,
            sourceMicroversion: cur.sourceMicroversion, rejectMicroversionSkew: false
        });
        const after = await window.__readFeatureStudio(ids);
        return { status: r.status, saved: after.contents === contents, specs: await window.__featureSpecs(ids) };
    };

    // Uploads a file as a new blob tab. data: string (text) or { base64 } (binary).
    window.__uploadBlob = async (d, w, filename, mime, data) => {
        const bytes = typeof data === 'string' ? data : Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: mime }), filename);
        fd.append('encodedFilename', filename);
        const r = await fetch(`/api/v6/blobelements/d/${d}/w/${w}`, {
            method: 'POST', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrf() }, body: fd
        });
        return { status: r.status, j: await readBody(r) };
    };

    window.__elements = async (d, w) =>
        (await window.__api('GET', `/documents/d/${d}/w/${w}/elements`)).j
            .map((e) => ({ name: e.name, type: e.elementType, id: e.id, microversion: e.microversionId, dataType: e.dataType }));

    // Part Studio features (these DO modify the model).
    window.__addFeature = async (ids, feature) =>
        window.__api('POST', `/partstudios/d/${ids.d}/w/${ids.w}/e/${ids.e}/features`, { feature });
    window.__updateFeature = async (ids, featureId, feature) =>
        window.__api('POST', `/partstudios/d/${ids.d}/w/${ids.w}/e/${ids.e}/features/featureid/${featureId}`,
            { feature: Object.assign({ featureId }, feature) });

    window.__createVersion = async (d, w, name, description = '') =>
        window.__api('POST', `/documents/d/${d}/versions`, { documentId: d, workspaceId: w, name, description });

    // UI helpers. The a11y snapshot is sparse in Onshape; tooltips live in data-bs-original-title.
    window.__byTooltip = (title) => [...document.querySelectorAll('[data-bs-original-title]')]
        .find((e) => e.getAttribute('data-bs-original-title') === title);
    window.__tooltips = (re = /./) => [...document.querySelectorAll('[data-bs-original-title]')]
        .map((e) => e.getAttribute('data-bs-original-title')).filter((t) => re.test(t));
    window.__rightClick = (el) => {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2, buttons: 2 };
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new MouseEvent('contextmenu', o));
    };
    window.__clickText = (text, selector = 'span,a,li,button,div') => {
        const el = [...document.querySelectorAll(selector)].find((e) => e.children.length === 0 && e.textContent.trim().startsWith(text));
        if (!el) return false;
        (el.closest('a,li,button,[role=menuitem]') || el).click();
        return true;
    };
})();
'onshape helpers loaded: __ids __api __unwrap __fsEval __features __readFeatureStudio __featureSpecs __pushFeatureStudio '
    + '__uploadBlob __elements __addFeature __updateFeature __createVersion __byTooltip __tooltips __rightClick __clickText';
