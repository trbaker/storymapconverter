/* Classic StoryMap Extractor, step 1: read a classic Esri Story Map, from ArcGIS or a self-hosted website, and export its content as a text file.
   Signals step 2 with a 'classic-read' event on window. */
(() => {
  const $ = id => document.getElementById(id);
  const ID_RE = /[0-9a-f]{32}/i;

  // Known classic Story Map templates: typeKeyword or URL path fragment -> display name
  const TEMPLATES = [
    ['mapseries', 'Map Series'], ['mapjournal', 'Map Journal'], ['cascade', 'Cascade'],
    ['shortlist', 'Shortlist'], ['swipe', 'Swipe and Spyglass'], ['maptour', 'Map Tour'],
    ['crowdsource', 'Crowdsource'], ['storymapbasic', 'Basic'], ['basic', 'Basic'],
    ['countdown', 'Countdown'], ['playlist', 'Playlist'], ['spyglass', 'Swipe and Spyglass']
  ];

  let state = { text: '', filename: 'story.txt' };

  // ---------- helpers ----------
  function log(msg, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    const s = document.createElement('span'); s.textContent = msg; li.appendChild(s);
    $('log').appendChild(li);
  }

  function parseSource(raw, portalOverride) {
    raw = raw.trim();
    const m = raw.match(ID_RE);
    if (!m) throw new Error('No 32-character item ID found. Paste the full story URL (it contains appid=…) or the item ID itself.');
    const id = m[0].toLowerCase();
    const bases = [];
    if (portalOverride) bases.push(portalOverride.replace(/\/+$/, '').replace(/\/sharing\/rest$/, '') + '/sharing/rest');
    let pageUrl = null, templateHint = null;
    try {
      const u = new URL(raw);
      pageUrl = u.href;
      const prefix = u.pathname.split('/apps/')[0].replace(/\/+$/, '');
      const pathLower = u.pathname.toLowerCase();
      for (const [k, name] of TEMPLATES) if (pathLower.includes('/' + k)) { templateHint = name; break; }
      if (!portalOverride) {
        if (/storymaps\.arcgis\.com$/i.test(u.hostname)) bases.push('https://www.arcgis.com/sharing/rest');
        else {
          // Old story links often start with http://. ArcGIS Online and current portals only answer on https,
          // and a secure page can't call an http address anyway, so try https first.
          bases.push('https://' + u.host + prefix + '/sharing/rest');
          if (u.protocol === 'http:' && location.protocol !== 'https:') bases.push('http://' + u.host + prefix + '/sharing/rest');
        }
      }
    } catch (_) { /* bare ID */ }
    if (!bases.includes('https://www.arcgis.com/sharing/rest')) bases.push('https://www.arcgis.com/sharing/rest');
    return { id, bases: bases.filter((b, i, a) => a.indexOf(b) === i), pageUrl, templateHint };
  }

  async function getJson(url, token) {
    const u = new URL(url);
    u.searchParams.set('f', 'json');
    if (token) u.searchParams.set('token', token);
    const r = await fetch(u.href, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.error) throw new Error((j.error.code ? j.error.code + ' ' : '') + (j.error.message || 'ArcGIS error'));
    return j;
  }

  // Convert classic story HTML to readable plain text
  const BLOCK = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','UL','OL','TABLE','TR','BLOCKQUOTE','SECTION','FIGURE','FIGCAPTION','PRE','HR']);
  function htmlToText(html) {
    if (html == null) return '';
    const doc = new DOMParser().parseFromString('<div>' + String(html) + '</div>', 'text/html');
    let out = '';
    const walk = (node, listDepth) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, ' '); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (tag === 'BR') { out += '\n'; continue; }
        if (tag === 'IMG') { out += `[image: ${n.getAttribute('alt') || ''} ${n.getAttribute('src') || ''}]`.replace(/\s+\]/, ']'); continue; }
        if (tag === 'IFRAME') { out += `[embed: ${n.getAttribute('src') || ''}]`; continue; }
        if (tag === 'LI') out += '\n' + '  '.repeat(Math.max(0, listDepth - 1)) + '- ';
        else if (BLOCK.has(tag)) out += '\n';
        walk(n, tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth);
        if (tag === 'A' && n.getAttribute('href') && !/^#/.test(n.getAttribute('href'))) {
          const href = n.getAttribute('href');
          if (!n.textContent.includes(href)) out += ` <${href}>`;
        }
        if (BLOCK.has(tag) && tag !== 'LI') out += '\n';
        if (tag === 'TD' || tag === 'TH') out += '\t';
      }
    };
    walk(doc.body.firstChild, 0);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+(?!- )/g, '\n').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function describeMedia(media) {
    if (!media || typeof media !== 'object') return { type: 'none', ref: '', thumb: '' };
    const type = media.type || Object.keys(media).find(k => typeof media[k] === 'object') || 'unknown';
    const body = media[type] || media;
    let ref = '', thumb = '';
    if (body && typeof body === 'object') {
      ref = body.id || body.url || body.href || '';
      if (!ref && body.frameTag) { const m = String(body.frameTag).match(/src=["']([^"']+)/i); ref = m ? m[1] : '[iframe embed]'; }
      if (type === 'image') thumb = body.thumbUrl || body.url || '';
      if (type === 'webmap' && body.extent) ref += ' (custom extent)';
    }
    return { type, ref: String(ref), thumb };
  }

  // ---------- place layers: Map Tour, Shortlist and Crowdsource ----------
  // These templates keep their places in a point layer of their web map: a feature collection stored in the
  // web map, or a hosted feature service (whose photos may be attachments). Services are read, never copied.
  const TOUR_FIELDS = {
    // candidates from the classic Map Tour's FIELDS_CANDIDATE, plus common variants
    oid: ['__objectid', 'objectid', 'fid', 'id', 'object_id'],
    name: ['name', 'title', 'name-short', 'name_short', 'name-long', 'label'],
    description: ['description', 'caption', 'snippet', 'comment', 'comments', 'text', 'desc'],
    pic: ['pic_url', 'url', 'pic', 'picture', 'image', 'image_url', 'photo', 'photo_url', 'media_url'],
    thumb: ['thumb_url', 'thumb', 'thumbnail', 'thumbnail_url', 'thumb_link'],
    video: ['is_video', 'video', 'isvideo'],
    color: ['icon_color', 'color', 'style']
  };
  function pickField(attrs, names) {
    const keys = Object.keys(attrs || {});
    for (const n of names) {
      if (!n) continue;
      const k = keys.find(x => x.toLowerCase() === String(n).toLowerCase());
      if (k && attrs[k] !== null && attrs[k] !== undefined && String(attrs[k]).trim() !== '') return attrs[k];
    }
    return '';
  }
  const fromMercator = (x, y) => [x / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI];
  const isPointLayer = l => !!(l && (l.featureCollection || (l.url && /\/(FeatureServer|MapServer)\/\d+\/?$/i.test(l.url))));

  // Find a layer by id (allowing the "_<n>" feature-collection suffix), by title, or as the uppermost visible point layer
  function findPointLayer(ops, { id, title, idHint } = {}) {
    const sid = String(id || '');
    return (sid && (ops.find(l => l.id === sid) || ops.find(l => l.id && sid.startsWith(l.id + '_')) || ops.find(l => l.id && sid.startsWith(l.id)))) ||
      (title && ops.find(l => (l.title || '').trim().toLowerCase() === String(title).trim().toLowerCase())) ||
      (idHint && ops.find(l => idHint.test(l.id || '') && isPointLayer(l))) ||
      // classic templates used the web map's uppermost visible point layer (last in drawing order)
      [...ops].reverse().find(l => l.visibility !== false && isPointLayer(l)) || [...ops].reverse().find(isPointLayer) || null;
  }

  // Read every feature of a point layer, with longitude/latitude
  async function readPointFeatures(src, sid, token, where) {
    if (src.featureCollection) {
      const layers = src.featureCollection.layers || [];
      const idx = (String(sid || '').match(/_(\d+)$/) || [])[1];
      const fl = (idx !== undefined && layers[+idx]) || layers.find(l => l.featureSet && (l.featureSet.features || []).length) || layers[0] || {};
      const sr = (fl.featureSet && fl.featureSet.spatialReference) || (fl.layerDefinition && fl.layerDefinition.spatialReference) || { wkid: 102100 };
      const geo = (sr.latestWkid || sr.wkid) === 4326;
      return { kind: 'stored in the web map', oidField: (fl.layerDefinition && fl.layerDefinition.objectIdField) || '', url: '',
        features: ((fl.featureSet && fl.featureSet.features) || []).map(f => ({ attributes: f.attributes || {}, lonlat: lonLat(f, geo) })) };
    }
    const url = src.url.replace(/^http:/i, 'https:').replace(/\/+$/, '');
    const info = await getJson(url, token).catch(() => ({}));
    const feats = [];
    let offset = 0, oidField = info.objectIdField || '';
    for (let page = 0; page < 10; page++) {
      const q = await getJson(`${url}/query?where=${encodeURIComponent(where || '1=1')}&outFields=*&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=1000`, token);
      oidField = oidField || q.objectIdFieldName || ((q.fields || []).find(f => f.type === 'esriFieldTypeOID') || {}).name || '';
      (q.features || []).forEach(f => feats.push({ attributes: f.attributes || {}, lonlat: lonLat(f, true) }));
      if (!q.exceededTransferLimit || !(q.features || []).length) break;
      offset += q.features.length;
    }
    return { kind: 'hosted feature layer', oidField, url, hasAttachments: !!info.hasAttachments, features: feats };
  }
  function lonLat(f, geo) {
    const g = f.geometry || {}, a = f.attributes || {};
    if (typeof g.x === 'number' && typeof g.y === 'number') return geo ? [g.x, g.y] : fromMercator(g.x, g.y);
    const lon = Number(pickField(a, ['long', 'lon', 'longitude', 'x'])), lat = Number(pickField(a, ['lat', 'latitude', 'y']));
    return Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat) ? [lon, lat] : null;
  }
  // Photos stored as feature attachments (classic Map Tour: first = picture, second = thumbnail)
  async function attachmentUrls(url, oid, token, prefer) {
    const r = await getJson(`${url}/${oid}/attachments`, token).catch(() => null);
    const infos = ((r && r.attachmentInfos) || []).filter(a => !a.contentType || /^image\//i.test(a.contentType));
    if (!infos.length) return [];
    if (prefer) infos.sort((a, b) => (prefer.test(b.name || '') || prefer.test(b.keywords || '') ? 1 : 0) - (prefer.test(a.name || '') || prefer.test(a.keywords || '') ? 1 : 0));
    return infos.map(a => `${url}/${oid}/attachments/${a.id}`);
  }
  async function mapLimited(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp)(\?|#|$)/i;

  async function loadMapTour(v, base, token) {
    if (!v || !/^[0-9a-f]{32}$/i.test(String(v.webmap || ''))) return null;
    const wm = await getJson(`${base}/content/items/${v.webmap}/data`, token).catch(() => null);
    if (!wm) return { webmap: v.webmap, error: "the tour's web map couldn't be read (it may be deleted or private)", points: [] };
    const ops = wm.operationalLayers || [];
    const src = findPointLayer(ops, { id: v.sourceLayer, title: v.sourceLayerTitle, idHint: /maptour/i });
    if (!src) return { webmap: v.webmap, error: "no point layer for the tour was found in its web map", points: [] };
    let layer;
    try { layer = await readPointFeatures(src, v.sourceLayer, token); }
    catch (e) { return { webmap: v.webmap, sourceLayer: src.id, error: `the tour's point layer couldn't be read (${e.message || e})`, points: [] }; }
    const fo = v.fieldsOverride || v.fields || {};
    const v21 = /^2\.1(\.|$)/.test(String(v.templateCreation || ''));
    let points = layer.features.filter(f => f.lonlat).map((f, i) => {
      const a = f.attributes;
      const oid = (layer.oidField && a[layer.oidField] !== undefined) ? a[layer.oidField] : pickField(a, TOUR_FIELDS.oid);
      let pic = String(pickField(a, [fo.fieldURL, ...TOUR_FIELDS.pic]) || '');
      let isVideo = /^(true|1|yes)$/i.test(String(pickField(a, [fo.fieldIsVideo, ...TOUR_FIELDS.video])));
      // classic qualifiers: "isVideo" anywhere in the URL marks a video; 2.1 tours treat non-image URLs as videos
      if (/isVideo/i.test(pic)) { isVideo = true; pic = pic.replace(/[#&?]isVideo\b/i, ''); }
      if (/#isImage$/i.test(pic)) { isVideo = false; pic = pic.replace(/#isImage$/i, ''); }
      else if (v21 && pic && !IMAGE_EXT.test(pic) && !layer.url) isVideo = true;
      return {
        oid: oid === '' ? i + 1 : oid,
        name: htmlToText(String(pickField(a, [fo.fieldName, ...TOUR_FIELDS.name]) || '')),
        description: String(pickField(a, [fo.fieldDescription, ...TOUR_FIELDS.description]) || ''),
        pic, thumb: String(pickField(a, [fo.fieldThumb, ...TOUR_FIELDS.thumb]) || ''),
        isVideo, color: String(pickField(a, [fo.fieldIconColor, ...TOUR_FIELDS.color]) || ''),
        lon: f.lonlat[0], lat: f.lonlat[1]
      };
    });
    // the classic order, without hidden places
    if (Array.isArray(v.order) && v.order.length) {
      const byId = new Map(points.map(p => [String(p.oid), p]));
      const ordered = v.order.filter(o => o && o.visible !== false).map(o => byId.get(String(o.id))).filter(Boolean);
      if (ordered.length) points = ordered;
    }
    // pictures kept only as attachments (tours made by uploading photos)
    let fromAttachments = 0;
    if (layer.url && points.some(p => !p.pic)) {
      await mapLimited(points.filter(p => !p.pic), 6, async p => {
        const urls = await attachmentUrls(layer.url, p.oid, token);
        if (urls[0]) { p.pic = urls[0]; p.thumb = p.thumb || urls[1] || ''; fromAttachments++; }
      });
    }
    return {
      webmap: v.webmap, sourceLayer: src.id, layerTitle: src.title || '', sourceKind: layer.kind, fromAttachments,
      basemapTitle: (wm.baseMap && wm.baseMap.title) || '', otherLayers: ops.filter(l => l !== src).length,
      zoomLevel: v.zoomLevel, layout: v.layout, firstRecordAsIntro: !!v.firstRecordAsIntro, points
    };
  }

  // Classic Shortlist: places in the web map's shortlist layer, grouped into the app's tabs by tab_id
  async function loadShortlist(v, base, token) {
    if (!v || !Array.isArray(v.tabs) || !/^[0-9a-f]{32}$/i.test(String(v.webmap || ''))) return null;
    const tabs = v.tabs.map((t, i) => ({ title: (t && t.title) || `Tab ${i + 1}`, color: /^#[0-9a-f]{6}$/i.test((t && t.color) || '') ? t.color : '' }));
    const wm = await getJson(`${base}/content/items/${v.webmap}/data`, token).catch(() => null);
    if (!wm) return { webmap: v.webmap, tabs, error: "the Shortlist's web map couldn't be read (it may be deleted or private)", places: [] };
    const ops = wm.operationalLayers || [];
    const src = findPointLayer(ops, { id: v.shortlistLayerId, idHint: /shortlist/i });
    if (!src) return { webmap: v.webmap, tabs, error: 'no places layer was found in its web map', places: [] };
    let layer;
    try { layer = await readPointFeatures(src, v.shortlistLayerId, token); }
    catch (e) { return { webmap: v.webmap, tabs, error: `the places layer couldn't be read (${e.message || e})`, places: [] }; }
    const tabByName = new Map(tabs.map((t, i) => [t.title.trim().toLowerCase(), i]));
    const places = layer.features.filter(f => f.lonlat).filter(f => !/^(false|0)$/i.test(String(pickField(f.attributes, ['locationSet'])))).map(f => {
      const a = f.attributes;
      const tid = pickField(a, ['tab_id']);
      let tab = tid === '' ? NaN : Number(tid);
      if (!Number.isFinite(tab)) { const tn = String(pickField(a, ['tab_name']) || '').trim().toLowerCase(); tab = tabByName.has(tn) ? tabByName.get(tn) : -1; }
      return {
        tab, number: Number(pickField(a, ['number', 'placenumsl'])) || 0,
        name: htmlToText(String(pickField(a, TOUR_FIELDS.name) || '')),
        description: String(pickField(a, ['description', 'short_desc', 'desc1', 'caption']) || ''),
        pic: String(pickField(a, TOUR_FIELDS.pic) || ''), thumb: String(pickField(a, TOUR_FIELDS.thumb) || ''),
        isVideo: false, lon: f.lonlat[0], lat: f.lonlat[1]
      };
    }).sort((a, b) => (a.tab < 0) - (b.tab < 0) || a.tab - b.tab || a.number - b.number); // places without a tab last
    return { webmap: v.webmap, sourceLayer: src.id, layerTitle: src.title || '', sourceKind: layer.kind, tabs, places };
  }

  // Classic Crowdsource: approved, visible contributions in a feature service, photos as attachments
  async function loadCrowdsource(v, base, token) {
    const comp = v && v.settings && v.settings.components;
    const cl = comp && comp.map && comp.map.crowdsourceLayer;
    const webmap = comp && comp.map && comp.map.webmap;
    if (!cl || !/^[0-9a-f]{32}$/i.test(String(webmap || ''))) return null;
    const intro = comp.intro || {};
    const out = { webmap, intro: { title: intro.title || '', subtitle: intro.subtitle || '',
      background: intro.background && intro.background.type === 'photo' ? intro.background.source || '' : '' }, places: [] };
    const wm = await getJson(`${base}/content/items/${webmap}/data`, token).catch(() => null);
    if (!wm) return Object.assign(out, { error: "the Crowdsource web map couldn't be read (it may be deleted or private)" });
    const src = findPointLayer(wm.operationalLayers || [], { id: cl.id, idHint: /crowdsource/i });
    if (!src || !src.url) return Object.assign(out, { error: 'the contributions layer was not found in its web map' });
    const vetted = cl.vettedField || 'Vetted', hidden = cl.hiddenField || 'Hidden';
    // only what readers saw: approved (1) and not hidden
    const where = cl.visibleFeaturesQuery || `${vetted} = 1 AND (${hidden} IS NULL OR ${hidden} <> 1)`;
    let layer;
    try { layer = await readPointFeatures(src, cl.id, token, where); }
    catch (e) { return Object.assign(out, { error: `the contributions couldn't be read (${e.message || e})` }); }
    const MAX = 200;
    const feats = layer.features.filter(f => f.lonlat && Number(pickField(f.attributes, [vetted])) === 1 && Number(pickField(f.attributes, [hidden])) !== 1);
    out.total = feats.length;
    const places = feats.slice(0, MAX).map(f => {
      const a = f.attributes;
      const desc = String(pickField(a, ['Description', 'description', 'caption']) || '');
      return {
        oid: a[layer.oidField] ?? pickField(a, TOUR_FIELDS.oid),
        // contributor names are left out: they came from the public
        name: htmlToText(String(pickField(a, ['LocationName', 'location_name']) || '')) || htmlToText(desc).split(/\s+/).slice(0, 8).join(' ') || 'Contribution',
        description: desc, pic: '', thumb: '', isVideo: false, lon: f.lonlat[0], lat: f.lonlat[1]
      };
    });
    await mapLimited(places, 6, async p => { const urls = await attachmentUrls(layer.url, p.oid, token, /primaryphoto|primary/i); p.pic = urls[0] || ''; });
    return Object.assign(out, { sourceLayer: src.id, layerTitle: src.title || '', places, capped: feats.length > MAX });
  }

  // Template-specific extraction. Each returns [{title, html, media, extra:{}}]
  function extractEntries(values, template, data) {
    const v = values || {};
    const tour = data && data.mapTour;
    if (tour && tour.points && tour.points.length) // Map Tour places, read from the tour's point layer
      return { label: 'Tour places', list: tour.points.map((p, i) => ({
        title: p.name || `Place ${i + 1}`, html: p.description,
        media: { type: p.isVideo ? 'video' : (p.pic ? 'image' : 'none'), ref: p.pic, thumb: p.isVideo ? (p.thumb || '') : (p.thumb || p.pic) },
        extra: { location: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, color: p.color || undefined, intro: i === 0 && tour.firstRecordAsIntro ? 'yes, shown before the tour' : undefined }
      })) };
    const sl = data && data.shortlist;
    if (sl && sl.places && sl.places.length) // Shortlist places, read from the web map's places layer
      return { label: 'Shortlist places', list: sl.places.map((p, i) => ({
        title: p.name || `Place ${i + 1}`, html: p.description,
        media: { type: p.pic ? 'image' : 'none', ref: p.pic, thumb: p.thumb || p.pic },
        extra: { tab: (sl.tabs[p.tab] && sl.tabs[p.tab].title) || 'no tab', number: p.number || undefined, location: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` }
      })) };
    const cs = data && data.crowdsource;
    if (cs && cs.places && cs.places.length) // Crowdsource approved contributions
      return { label: 'Approved contributions', list: cs.places.map((p, i) => ({
        title: p.name || `Contribution ${i + 1}`, html: p.description,
        media: { type: p.pic ? 'image' : 'none', ref: p.pic, thumb: p.pic },
        extra: { location: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` }
      })) };
    const story = v.story || {};
    const pick = (arr, map) => Array.isArray(arr) ? arr.map(map) : [];
    if (/^TWO_(WEBMAPS|LAYERS)$/.test(v.dataModel || '')) { // Swipe and Spyglass
      const maps = [].concat(v.webmaps || [], v.webmap || []).filter((x, i, a) => typeof x === 'string' && a.indexOf(x) === i);
      const ref = v.dataModel === 'TWO_LAYERS' ? `${v.webmap || maps[0]} (layers swiped: ${[].concat(v.layers || []).join(', ')})` : maps.slice(0, 2).join(' | ');
      const media = { type: v.layout === 'spyglass' ? 'spyglass' : 'swipe', ref, thumb: '' };
      const list = [{ title: 'Swipe', html: v.description !== false ? (v.sidePanelDescription || '') : '', media, extra: { dataModel: v.dataModel } }];
      if (v.series && Array.isArray(v.bookmarks)) v.bookmarks.forEach((b, i) => list.push({
        title: htmlToText(b.name || '') || `View ${i + 1}`, html: b.description || '', media: Object.assign({}, media, { ref: 'zoomed to bookmark' }), extra: {}
      }));
      return { label: 'Swipe views', list };
    }
    if (Array.isArray(story.entries)) // Map Series
      return { label: 'Entries', list: pick(story.entries, e => ({
        title: e.title, html: e.description || '', media: describeMedia(e.media),
        extra: { status: e.status && e.status !== 'PUBLISHED' ? e.status + ' (not shown to readers)' : undefined,
          actions: (e.contentActions || []).length ? e.contentActions.map(a => a.type + (a.media && a.media.type ? ':' + a.media.type + (a.media.webmap ? ' ' + a.media.webmap.id : '') : '')).join(', ') : undefined }
      })) };
    if (Array.isArray(story.sections)) // Map Journal
      return { label: 'Sections', list: pick(story.sections, s => ({
        title: htmlToText(s.title), html: s.content || '', media: describeMedia(s.media),
        extra: { status: s.status && s.status !== 'PUBLISHED' ? s.status + ' (not shown to readers)' : undefined,
          actions: (s.contentActions || []).length ? s.contentActions.map(a => a.type + (a.media && a.media.type ? ':' + a.media.type + (a.media.webmap ? ' ' + a.media.webmap.id : '') : '')).join(', ') : undefined }
      })) };
    if (Array.isArray(v.sections)) { // Cascade
      const list = [];
      v.sections.forEach((s, i) => {
        const htmls = [], medias = [];
        collect(s, (key, val) => {
          if (typeof val === 'string' && /<[a-z][\s\S]*>/i.test(val)) htmls.push(val);
        }, (obj) => { if (obj && obj.type && (obj.webmap || obj.image || obj.video || obj.webpage)) medias.push(describeMedia(obj)); });
        const titleFromBlocks = s.title && (s.title.value || s.title) || s.type;
        list.push({ title: `${s.type || 'section'}${typeof titleFromBlocks === 'string' && titleFromBlocks !== s.type ? ' — ' + htmlToText(titleFromBlocks) : ''}`,
          html: htmls.join('\n'), media: medias[0] || describeMedia(null), extra: { mediaCount: medias.length || undefined } });
      });
      return { label: 'Sections', list };
    }
    if (Array.isArray(v.tabs)) // Shortlist
      return { label: 'Tabs', list: pick(v.tabs, t => ({ title: t.title, html: t.description || '', media: describeMedia(null), extra: { color: t.color } })) };
    if (Array.isArray(v.order)) // Map Tour (points live in a feature layer)
      // Only the place order and visibility are in the story item. Each place's name, text, photo and
      // location are features of the tour's layer, which couldn't be read, so they're listed by feature ID.
      return { label: "Tour places (order only: the tour's layer couldn't be read)", list: pick(v.order, (o, i) => ({
        title: `Place ${i + 1} (feature ID ${o.id})`, html: '', media: describeMedia(null),
        extra: { visible: o.visible, details: "name, text, photo and location were stored in the tour's layer, which can't be read" } })) };
    return { label: 'Entries', list: [] };
  }

  // Generic recursive walk over the JSON
  function collect(obj, onValue, onObject, path = '') {
    if (obj && typeof obj === 'object') {
      if (onObject) onObject(obj, path);
      for (const [k, v] of Object.entries(obj)) {
        const p = Array.isArray(obj) ? `${path}[${k}]` : (path ? path + '.' + k : k);
        if (v && typeof v === 'object') collect(v, onValue, onObject, p);
        else onValue(k, v, p);
      }
    }
  }
  const TEXT_KEYS = /^(title|subtitle|description|content|text|caption|name|label|header|footer|value|snippet|summary|headerTitle|subtitleText|credits?)$/i;
  function scanText(values) {
    const found = [];
    collect(values, (k, v, p) => {
      if (typeof v !== 'string' || !v.trim()) return;
      const looksHtml = /<[a-z][\s\S]*>/i.test(v);
      if (!looksHtml && !TEXT_KEYS.test(k)) return;
      if (/^[0-9a-f]{32}$/i.test(v) || /^https?:\/\//i.test(v)) return;
      found.push({ path: p, html: looksHtml, text: looksHtml ? htmlToText(v) : v });
    });
    return found;
  }
  function referencedIds(data) {
    const ids = new Map();
    collect(data, (k, v, p) => {
      if (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v)) {
        if (!ids.has(v)) ids.set(v, p);
      }
    });
    return ids;
  }

  function detectTemplate(item, data, hint) {
    const kw = (item.typeKeywords || []).map(s => s.toLowerCase());
    let name = data?.values?.template?.name || null;
    if (!name) for (const [k, n] of TEMPLATES) if (kw.includes(k)) { name = n; break; }
    if (!name && item.url) { const u = item.url.toLowerCase(); for (const [k, n] of TEMPLATES) if (u.includes('/' + k)) { name = n; break; } }
    if (!name) name = hint;
    const isStory = kw.includes('story map') || kw.includes('story maps');
    const isModern = item.type === 'StoryMap';
    const layout = (data?.values?.settings?.layout?.id) || (kw.find(k => k.startsWith('layout-')) || '').replace('layout-', '') || null;
    return { name: name || 'Unknown', isStory, isModern, layout,
      createdWith: data?.values?.template?.createdWith, editedWith: data?.values?.template?.editedWith };
  }

  const fmtDate = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  const rule = (t) => `\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}\n`;
  const sub = (t) => `\n--- ${t} ${'-'.repeat(Math.max(3, 66 - t.length))}\n`;

  function buildText(ctx, opts) {
    const { item, data, tpl, entries, scan, ids, pageCheck, base, src } = ctx;
    let t = '';
    t += 'CLASSIC STORY MAP EXPORT\n';
    t += `Generated:  ${new Date().toISOString()}\n`;
    t += `Source:     ${src.pageUrl || src.id}\n`;
    if (data && data.selfHosted) {
      t += `Read from:  ${data.selfHosted.config || data.selfHosted.page} (story settings)\n`;
      t += `Content:    web maps on ${base}\n`;
    } else t += `Read from:  ${base}/content/items/${item.id}/data\n`;

    t += rule('ITEM');
    t += `Title:      ${item.title || ''}\n`;
    t += `Item ID:    ${data && data.selfHosted ? 'none (self-hosted website)' : item.id}\n`;
    t += `Type:       ${item.type}\n`;
    t += `Owner:      ${item.owner}\n`;
    t += `Access:     ${item.access}\n`;
    t += `Created:    ${fmtDate(item.created)}\n`;
    t += `Modified:   ${fmtDate(item.modified)}\n`;
    t += `App URL:    ${item.url || ''}\n`;
    t += `Keywords:   ${(item.typeKeywords || []).join(', ')}\n`;
    if (item.tags?.length) t += `Tags:       ${item.tags.join(', ')}\n`;
    if (item.snippet) t += `Summary:    ${item.snippet}\n`;
    if (item.description) t += sub('Item description') + (opts.text ? htmlToText(item.description) + '\n' : '') + (opts.html ? '\n[HTML]\n' + item.description + '\n' : '');
    if (item.accessInformation) t += sub('Credits') + htmlToText(item.accessInformation) + '\n';

    t += rule('TEMPLATE');
    t += `Template:   ${tpl.name}${tpl.layout ? ' (layout: ' + tpl.layout + ')' : ''}\n`;
    t += `Classic:    ${tpl.isModern ? 'NO - this is already a modern ArcGIS StoryMap' : (tpl.isStory ? 'yes' : 'not tagged as a Story Map')}\n`;
    if (tpl.createdWith) t += `Built with: v${tpl.createdWith}${tpl.editedWith ? ', last edited with v' + tpl.editedWith : ''}\n`;
    const v = data?.values || {};
    if (v.webmap) t += `Main map:   web map ${v.webmap}\n`;
    if (v.title && v.title !== item.title) t += `Story title: ${v.title}\n`;
    if (v.subtitle) t += `Subtitle:   ${htmlToText(v.subtitle)}\n`;
    if (v.settings) t += `Settings:   ${JSON.stringify(v.settings)}\n`;

    t += rule('CLASSIC APP PAGE');
    t += pageCheck + '\n';

    t += rule(`STORY CONTENT — ${entries.label.toUpperCase()} (${entries.list.length})`);
    if (!entries.list.length) t += 'No structured entries recognised for this template. See "Every text field found" below.\n';
    entries.list.forEach((e, i) => {
      t += `\n[${i + 1}] ${e.title || '(untitled)'}\n`;
      t += `Media: ${e.media.type}${e.media.ref ? ' — ' + e.media.ref : ''}\n`;
      const extra = Object.entries(e.extra || {}).filter(([, val]) => val !== undefined && val !== null && val !== '');
      if (extra.length) t += extra.map(([k, val]) => `${k[0].toUpperCase() + k.slice(1)}: ${val}`).join('\n') + '\n';
      if (opts.text && e.html) t += sub('Text') + htmlToText(e.html) + '\n';
      if (opts.html && e.html) t += sub('Original HTML') + e.html.trim() + '\n';
    });

    if (ids.size) {
      t += rule(`REFERENCED ARCGIS ITEMS (${ids.size})`);
      for (const [id, p] of ids) {
        const r = ctx.refStatus && ctx.refStatus.get(id);
        const status = !r ? '' : r.ok ? `   ${r.type || 'item'} "${r.title || ''}", shared ${r.access || '?'}${r.owner ? ', owner ' + r.owner : ''}` : "   CAN'T BE READ: deleted, or not shared publicly";
        t += `${id}   at ${p}${status}\n`;
      }
    }

    if (opts.scan) {
      t += rule(`EVERY TEXT FIELD FOUND (${scan.length})`);
      scan.forEach(s => { t += `\n# ${s.path}${s.html ? ' (html)' : ''}\n${s.text}\n`; });
    }
    if (opts.json) {
      t += rule('RAW ITEM INFO (JSON)');
      t += JSON.stringify(item, null, 2) + '\n';
      t += rule('RAW ITEM DATA (JSON)');
      t += JSON.stringify(data, null, 2) + '\n';
    }
    return t;
  }

  // ---------- render ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
    kids.forEach(k => k && n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
    return n;
  }

  function renderSummary(ctx) {
    const { item, tpl, entries, scan } = ctx;
    const box = $('summary'); box.replaceChildren();
    box.appendChild(el('h2', { text: item.title || 'Untitled story' }));
    const pills = el('div', { class: 'row' },
      el('span', { class: 'pill', text: tpl.name + (tpl.layout ? ' · ' + tpl.layout : '') }));
    if (tpl.isModern) pills.appendChild(el('span', { class: 'pill warn', text: 'Already a modern StoryMap' }));
    else if (!tpl.isStory) pills.appendChild(el('span', { class: 'pill warn', text: 'Not tagged as a Story Map' }));
    box.appendChild(pills);
    const dl = el('dl', { class: 'facts' });
    const add = (k, v) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); };
    add('Owner', item.owner || '—');
    add('Access', item.access || '—');
    add('Modified', fmtDate(item.modified));
    add(entries.label, String(entries.list.length));
    add('Text fields', String(scan.length));
    add('File size', (new Blob([state.text]).size / 1024).toFixed(1) + ' KB');
    box.appendChild(dl);

    $('entriesHead').textContent = `${entries.label} (${entries.list.length})`;
    const ul = $('entries'); ul.replaceChildren();
    if (!entries.list.length) ul.appendChild(el('li', {}, el('div', { class: 'thumb', text: '—' }), el('div', {}, el('p', { text: 'No structured entries for this template. The text file lists every text field found in the story data.' }))));
    entries.list.forEach((e, i) => {
      const th = el('div', { class: 'thumb' });
      if (e.media.thumb) { const img = el('img', { alt: '', loading: 'lazy', src: e.media.thumb }); img.onerror = () => { th.textContent = e.media.type; }; th.appendChild(img); }
      else th.textContent = e.media.type === 'none' ? '—' : e.media.type;
      const body = el('div', {},
        el('h3', {}, el('small', { text: String(i + 1).padStart(2, '0') }), e.title || '(untitled)'),
        el('p', { text: htmlToText(e.html).replace(/\s+/g, ' ').slice(0, 220) || 'No text.' }),
        el('div', { class: 'meta', text: `${e.media.type}${e.media.ref ? ': ' + e.media.ref : ''}` }));
      ul.appendChild(el('li', {}, th, body));
    });
  }

  // ---------- self-hosted classic stories ----------
  // Early classic templates could be downloaded and hosted on any website. Their settings live in a
  // `configOptions` object, either inline in the page or in a config script (often app/<template>/Config.js),
  // and their content comes from the ArcGIS items it lists (appid, webmap, webmaps).
  // The settings are read as data and never run, so a site's own code can't act inside this page.
  const AGO_REST = 'https://www.arcgis.com/sharing/rest';

  function readString(src, p) {
    const q = src[p++]; let s = '';
    while (p < src.length && src[p] !== q) {
      let c = src[p++];
      if (c !== '\\') { s += c; continue; }
      c = src[p++];
      if (c === 'u') { s += String.fromCharCode(parseInt(src.substr(p, 4), 16) || 0); p += 4; }
      else if (c === 'x') { s += String.fromCharCode(parseInt(src.substr(p, 2), 16) || 0); p += 2; }
      else if (c === '\r' || c === '\n') { if (c === '\r' && src[p] === '\n') p++; } // line continuation
      else s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[c] ?? c;
    }
    return { value: s, end: p + 1 };
  }

  // A value that isn't an object or array: number, true/false/null, or "a" + location.protocol + "b"
  function evalSimple(raw) {
    const t = raw.trim();
    if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === 'undefined' || t === '') return null;
    const pieces = []; let q = 0;
    const space = () => { while (q < t.length && /\s/.test(t[q])) q++; };
    while (q < t.length) {
      space();
      if (t[q] === '"' || t[q] === "'" || t[q] === '`') { const r = readString(t, q); pieces.push(r.value); q = r.end; }
      else {
        const m = t.slice(q).match(/^(?:window\.|document\.)?location\.protocol/);
        if (!m) return null; // depends on code we won't run
        pieces.push('https:'); q += m[0].length;
      }
      space();
      if (q < t.length) { if (t[q] !== '+') return null; q++; }
    }
    return pieces.length ? pieces.join('') : null;
  }

  // Parse a JavaScript object or array literal that starts at src[start]
  function parseJsLiteral(src, start) {
    let p = start;
    const fail = m => { throw new Error(m); };
    const ws = () => {
      for (;;) {
        const c = src[p];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿' || c === ' ') { p++; continue; }
        if (c === '/' && src[p + 1] === '/') { while (p < src.length && src[p] !== '\n') p++; continue; }
        if (c === '/' && src[p + 1] === '*') { const e = src.indexOf('*/', p + 2); p = e < 0 ? src.length : e + 2; continue; }
        return;
      }
    };
    const expr = () => {
      const from = p; let depth = 0;
      while (p < src.length) {
        const c = src[p];
        if (c === '"' || c === "'" || c === '`') { p = readString(src, p).end; continue; }
        if (c === '/' && (src[p + 1] === '/' || src[p + 1] === '*')) { ws(); continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { if (!depth) break; depth--; }
        else if (c === ',' && !depth) break;
        p++;
      }
      return evalSimple(src.slice(from, p));
    };
    const value = () => {
      ws();
      if (p >= src.length) fail('Unexpected end');
      if (src[p] === '{') {
        p++; const o = {};
        for (;;) {
          ws();
          if (p >= src.length) fail('Unclosed object');
          if (src[p] === '}') { p++; return o; }
          if (src[p] === ',') { p++; continue; }
          let key;
          if (src[p] === '"' || src[p] === "'") { const r = readString(src, p); key = r.value; p = r.end; }
          else { const m = src.slice(p, p + 200).match(/^[$\w]+/); if (!m) fail('Unexpected character'); key = m[0]; p += key.length; }
          ws();
          if (src[p] !== ':') fail('Expected :');
          p++;
          o[key] = value();
        }
      }
      if (src[p] === '[') {
        p++; const a = [];
        for (;;) {
          ws();
          if (p >= src.length) fail('Unclosed array');
          if (src[p] === ']') { p++; return a; }
          if (src[p] === ',') { p++; continue; }
          a.push(value());
        }
      }
      if (src[p] === '"' || src[p] === "'" || src[p] === '`') {
        // a plain string, unless it is the start of "a" + "b"
        const save = p; const r = readString(src, p); p = r.end; ws();
        if (src[p] !== '+') return r.value;
        p = save; return expr();
      }
      return expr();
    };
    return { value: value(), end: p };
  }

  function findConfigOptions(text) {
    const re = /\bconfigOptions\s*=\s*\{/g;
    let m, best = null;
    while ((m = re.exec(text))) {
      try {
        const v = parseJsLiteral(text, m.index + m[0].length - 1).value;
        if (v && (!best || Object.keys(v).length > Object.keys(best).length)) best = v;
      } catch (_) { /* not a readable literal; keep looking */ }
    }
    if (best) return best;
    // Configurable apps such as Story Map Basic keep settings in a Dojo module: define({ "appid": …, "webmap": … })
    const re2 = /\bdefine\s*\(\s*(?:\[[^\]]*\]\s*,\s*)?\{/g;
    while ((m = re2.exec(text))) {
      try {
        const v = parseJsLiteral(text, m.index + m[0].length - 1).value;
        if (v && ('appid' in v || 'webmap' in v) && (!best || Object.keys(v).length > Object.keys(best).length)) best = v;
      } catch (_) { /* keep looking */ }
    }
    return best;
  }

  // Config scripts a self-hosted page loads: <script src="...config..."> or AMD require(["pkg/.../Config"])
  function configScriptUrls(html, pageUrl) {
    const urls = [];
    const add = u => { try { const x = new URL(u, pageUrl).href; if (!urls.includes(x)) urls.push(x); } catch (_) { /* skip */ } };
    for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi))
      if (/config/i.test(m[1]) && !/js\.arcgis\.com|googleapis|cdn|dojoconfig/i.test(m[1])) add(m[1]);
    const pkgs = {};
    for (const m of html.matchAll(/name\s*:\s*["']([\w.-]+)["']\s*,\s*location\s*:\s*([^}]*)/g)) {
      const lits = [...m[2].matchAll(/["']([^"']*)["']/g)].map(x => x[1]).filter(s => s && s !== '/');
      pkgs[m[1]] = (lits.pop() || m[1]).replace(/^\.?\/+/, '');
    }
    // Viewer-based configurable apps (Story Map Basic) load their settings from the "config" package's defaults.js
    if (pkgs.config !== undefined || /config\/templateConfig/.test(html)) add(((pkgs.config || 'config').replace(/\/+$/, '')) + '/defaults.js');
    for (const m of html.matchAll(/require\s*\(\s*\[([^\]]*)\]/g)) {
      for (const id of [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1])) {
        if (!/config/i.test(id) || /^(dojo|dijit|dojox|esri)\//.test(id)) continue;
        const [pkg, ...rest] = id.split('/');
        const loc = pkgs[pkg] ?? (pkg === 'storymaps' ? 'app' : pkg);
        if (/^(https?:)?\/\//i.test(loc)) continue;
        add((loc ? loc.replace(/\/+$/, '') + '/' : '') + rest.join('/') + '.js');
      }
    }
    return urls;
  }

  function idList(v) {
    const out = [];
    const push = x => {
      const raw = typeof x === 'string' ? x : x && (x.id || x.webmap || x.itemId || x.appid);
      String(raw || '').split(/[\s,;]+/).forEach(s => {
        if (/^[0-9a-f]{32}$/i.test(s) && !out.some(o => o.id === s.toLowerCase()))
          out.push({ id: s.toLowerCase(), title: (x && typeof x === 'object' && x.title) || '' });
      });
    };
    (Array.isArray(v) ? v : [v]).forEach(push);
    return out;
  }

  function absolutize(html, baseUrl) {
    if (!html || !baseUrl) return html || '';
    const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    doc.querySelectorAll('[src],[href]').forEach(n => {
      for (const a of ['src', 'href']) {
        const v = n.getAttribute(a);
        if (v && !/^(#|mailto:|javascript:|data:)/i.test(v)) { try { n.setAttribute(a, new URL(v, baseUrl).href); } catch (_) { /* keep */ } }
      }
    });
    return doc.getElementById('r').innerHTML;
  }

  // The page's own visible text, for self-hosted stories with no recognisable settings
  function visiblePageHtml(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,link,meta,svg,iframe,object,embed,form,button,nav,[hidden],[style*="display:none"],[style*="display: none"]').forEach(n => n.remove());
    const body = doc.body ? doc.body.innerHTML : '';
    return htmlToText(body).replace(/\s+/g, ' ').length > 40 ? absolutize(body, baseUrl) : '';
  }

  function selfHostedTemplate(configFrom, html) {
    const names = [['maptour', 'Map Tour'], ['tour', 'Map Tour'], ['shortlist', 'Shortlist'], ['swipe', 'Swipe and Spyglass'],
      ['spyglass', 'Swipe and Spyglass'], ['mapjournal', 'Map Journal'], ['journal', 'Map Journal'], ['mapseries', 'Map Series'],
      ['series', 'Tabbed series'], ['tabbed', 'Tabbed'], ['accordion', 'Accordion'], ['countdown', 'Countdown'],
      ['playlist', 'Playlist'], ['sidepanel', 'Side panel'], ['basic', 'Basic']];
    const segs = String(configFrom || '').toLowerCase().split(/[\/?#]/).slice(0, -1).reverse();
    for (const s of segs) for (const [k, n] of names) if (s === k) return n;
    const hay = String(html || '').slice(0, 30000).toLowerCase();
    if (/config\/defaults\.js$/i.test(String(configFrom || '')) || /story ?map basic|storymap-basic|mapbasic/.test(hay)) return 'Basic';
    for (const [k, n] of names) if (k.length > 5 && hay.includes(k)) return n;
    return 'Self-hosted';
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return { url: r.url || url, text: await r.text() };
  }

  // Find the story settings from a live page (pageUrl) or from saved files
  async function readSelfHosted(pageUrl, files) {
    const found = { pageUrl, html: '', scripts: [], cfg: null, configFrom: '' };
    if (files && files.length) {
      for (const f of files) {
        const text = typeof f.text === 'function' ? await f.text() : await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f);
        });
        if (/\.html?$/i.test(f.name) || /^\s*<(!doctype|html)/i.test(text)) { if (!found.html) { found.html = text; found.pageName = f.name; } }
        else found.scripts.push({ url: f.name, text });
      }
      if (!found.pageUrl) {
        // Chrome and Edge note the original address when saving a page
        const m = found.html.match(/saved from url=\(\d+\)(\S+?)\s*-->/i) || found.html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
        if (m && /^https?:/i.test(m[1])) found.pageUrl = m[1];
      }
    } else {
      const tries = /^http:/i.test(pageUrl) ? [pageUrl.replace(/^http:/i, 'https:'), pageUrl] : [pageUrl];
      let lastErr;
      for (const u of tries) {
        try { const r = await fetchText(u); found.pageUrl = r.url; found.html = r.text; lastErr = null; break; }
        catch (e) { lastErr = e; if (e.status === 404) break; }
      }
      if (lastErr) throw lastErr;
      log(`Read the story page (${found.html.length.toLocaleString()} characters)`, 'ok');
    }
    found.cfg = findConfigOptions(found.html);
    if (found.cfg) found.configFrom = found.pageName || found.pageUrl || 'the story page';
    for (const s of found.scripts) {
      if (found.cfg) break;
      const c = findConfigOptions(s.text);
      if (c) { found.cfg = c; found.configFrom = s.url; }
    }
    if (!found.cfg && found.pageUrl && found.html) {
      for (const u of configScriptUrls(found.html, found.pageUrl)) {
        try {
          const r = await fetchText(u);
          const c = findConfigOptions(r.text);
          if (c) { found.cfg = c; found.configFrom = r.url; break; }
        } catch (e) { log(`Could not read ${u} (${e.status ? 'HTTP ' + e.status : 'blocked by the website'})`, 'warn'); }
      }
    }
    return found;
  }

  function sharingBase(cfg) {
    let s = cfg && typeof cfg.sharingurl === 'string' ? cfg.sharingurl : '';
    // configurable apps use "sharinghost", e.g. "https://www.arcgis.com" or "https://acme.com/gis/"
    if (!s && cfg && typeof cfg.sharinghost === 'string' && cfg.sharinghost) s = cfg.sharinghost.replace(/\/+$/, '') + '/sharing';
    const m = s.match(/^(?:https?:)?\/\/([^/]+)(\/[^?#]*?)?\/sharing\b/i);
    return m ? `https://${m[1]}${m[2] || ''}/sharing/rest` : AGO_REST;
  }

  // Build the same shape the rest of the app uses for an ArcGIS item, from a self-hosted page's settings
  async function selfHostedStory(found, token) {
    const cfg = found.cfg || {};
    const base = sharingBase(cfg);
    const maps = idList(cfg.webmaps).concat(idList(cfg.webmap)).filter((m, i, a) => a.findIndex(x => x.id === m.id) === i);
    const pageTitle = ((found.html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const title = (typeof cfg.title === 'string' && htmlToText(cfg.title)) || pageTitle || 'Self-hosted story';
    const subtitle = typeof cfg.subtitle === 'string' ? absolutize(cfg.subtitle, found.pageUrl) : '';
    const infos = await Promise.all(maps.map(m => getJson(`${base}/content/items/${m.id}`, token).catch(e => ({ _err: e.message }))));
    let unread = 0;
    const entries = maps.map((m, i) => {
      const it = infos[i] || {};
      if (it._err) { unread++; log(`Web map ${m.id} could not be read (${it._err})`, 'warn'); }
      return {
        // the classic template showed the configured title, else the web map's title, and the web map's description
        title: m.title || it.title || `Map ${i + 1}`,
        description: it.description || '',
        media: { type: 'webmap', webmap: { id: m.id } }
      };
    });
    if (maps.length) log(`${maps.length - unread} of ${maps.length} web maps read from ${new URL(base).host}`, unread ? 'warn' : 'ok');
    if (!entries.length) {
      const body = visiblePageHtml(found.html, found.pageUrl);
      if (body) {
        entries.push({ title, description: body, media: null });
        log("No web maps listed in the story settings, so the page's own text is used as the story", 'warn');
      }
    }
    const tplName = selfHostedTemplate(found.configFrom, found.html);
    const item = {
      id: 'selfhost', title, type: 'Self-hosted classic Story Map', owner: '', access: 'public website',
      url: found.pageUrl || '', typeKeywords: ['Story Map', 'self-hosted'], tags: [],
      snippet: htmlToText(subtitle).replace(/\s+/g, ' ').slice(0, 250), description: subtitle
    };
    const data = {
      values: Object.assign({ title, subtitle, webmap: maps[0] && maps[0].id, template: { name: tplName }, story: { entries } },
        // a self-hosted Map Tour configured with a web map keeps its tour settings in index.html
        tplName === 'Map Tour' ? { layout: cfg.layout, firstRecordAsIntro: cfg.firstRecordAsIntro, zoomLevel: cfg.zoomLevel, sourceLayerTitle: cfg.sourceLayerTitle } : {},
        tplName === 'Basic' ? { legend: cfg.legend } : {}),
      selfHosted: { page: found.pageUrl || found.pageName || '', config: found.configFrom, configOptions: found.cfg }
    };
    return { item, data, base };
  }

  let lastCtx = null;
  function opts() { return { text: $('optText').checked, html: $('optHtml').checked, scan: $('optScan').checked, json: $('optJson').checked }; }
  function refreshText() {
    if (!lastCtx) return;
    state.text = buildText(lastCtx, opts());
    $('text').textContent = state.text;
    renderSummary(lastCtx);
  }
  ['optText', 'optHtml', 'optScan', 'optJson'].forEach(id => $(id).addEventListener('change', refreshText));

  async function checkPage(url) {
    if (!url) return 'No app URL given (item ID only), so the classic page was not requested.';
    try {
      const r = await fetch(url, { credentials: 'omit' });
      const html = await r.text();
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      let note = `HTTP ${r.status}, ${html.length.toLocaleString()} characters, page title "${title.trim()}".`;
      if (/item replacement/i.test(title) || /retire/i.test(html)) note += '\nEsri has retired this classic template: the page now shows a replacement notice instead of the story. The story content below comes from the item data, which is still available.';
      else note += '\nThe page is only the template shell; the story content is loaded from the item data shown below.';
      return note;
    } catch (err) {
      return 'The browser blocked a direct read of the classic app page (ArcGIS app pages do not allow cross-site reads). This does not matter: the page is only a template shell, and the story content comes from the item data, listed below.';
    }
  }

  const isBlocked = e => !e.status && /Failed to fetch|NetworkError|Load failed|blocked/i.test(e.message || '');

  // Read an ArcGIS item (a classic story, or a lone web map) into the shared shape
  async function readItem(src, token) {
    log(`Item ID ${src.id}`, 'ok');
    let item = null, base = null;
    const tried = [];
    for (const b of src.bases) {
      try { item = await getJson(`${b}/content/items/${src.id}`, token); base = b; break; }
      catch (err) { tried.push(`${new URL(b).host}: ${err.message}`); } // only reported if every address fails
    }
    if (!item) throw new Error(`Could not read the item (${tried.join('; ') || 'unknown error'}). If the story is private, add an access token under "Private or ArcGIS Enterprise story".`);
    log(`Item found on ${new URL(base).host}: "${item.title}" (${item.type})`, 'ok');
    let data = await getJson(`${base}/content/items/${src.id}/data`, token).catch(err => { throw new Error('Item found, but its story data could not be read: ' + err.message); });
    log(`Story data read: ${JSON.stringify(data).length.toLocaleString()} characters of JSON`, 'ok');
    if (/^Web (Map|Scene)$/.test(item.type) && !(data && data.values)) {
      // A link to a single web map (classic templates also took ?webmap=<id>): treat it as a one-entry story
      data = { values: { title: item.title, webmap: item.id, template: { name: 'Single web map' },
        story: { entries: [{ title: item.title, description: item.description || '', media: { type: 'webmap', webmap: { id: item.id } } }] } },
        webmapData: data };
      log('This ID is a web map, not a story, so it becomes a one-slide story', 'warn');
    }
    return { item, data, base };
  }

  async function run(ev, files) {
    ev && ev.preventDefault && ev.preventDefault();
    $('log').replaceChildren();
    $('go').disabled = true;
    try {
      const raw = $('url').value.trim();
      const token = $('token').value.trim();
      const looksLikeUrl = /^(https?:)?\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
      const pageInput = looksLikeUrl ? (/^https?:/i.test(raw) ? raw : 'https://' + raw.replace(/^\/\//, '')) : null;
      let item, data, base, src, pageCheck;

      if (!files && ID_RE.test(raw)) {
        src = parseSource(raw, $('portal').value.trim());
        ({ item, data, base } = await readItem(src, token));
        pageCheck = await checkPage(src.pageUrl || item.url);
      } else {
        if (!files && !pageInput) throw new Error('Paste a classic story link (or its item ID) to read it.');
        log(files ? `Reading ${files.length} saved file${files.length > 1 ? 's' : ''}` : 'No item ID in the link, so reading it as a self-hosted story page', 'ok');
        let found;
        try { found = await readSelfHosted(files ? null : pageInput, files); }
        catch (err) {
          const host = (() => { try { return new URL(pageInput).host; } catch (_) { return 'The website'; } })();
          if (err.status === 404) throw new Error(`The page wasn't found (HTTP 404). Check the link.`);
          if (isBlocked(err)) {
            $('filesBox').open = true;
            throw new Error(`${host} doesn't let other web pages read its files, so the story can't be read from here. Save the story in your browser and load the saved files under "Self-hosted story on a website that blocks reading".`);
          }
          throw err;
        }
        const appid = found.cfg && idList(found.cfg.appid)[0];
        if (found.cfg) log(`Story settings found in ${found.configFrom}`, 'ok');
        else log('No story settings (configOptions) found on the page' + (files ? ' or in the saved files' : ''), 'warn');
        if (appid) {
          // Self-hosted page that loads its content from an ArcGIS story item
          log(`The page loads its content from ArcGIS item ${appid.id}`, 'ok');
          const sb = sharingBase(found.cfg);
          src = { id: appid.id, bases: [...new Set([sb, AGO_REST])], pageUrl: found.pageUrl, templateHint: selfHostedTemplate(found.configFrom, found.html) };
          ({ item, data, base } = await readItem(src, token));
          pageCheck = `Self-hosted page: ${found.pageUrl || found.pageName}\nSettings read from: ${found.configFrom}\nThe page loads its story from ArcGIS item ${appid.id}, read below.`;
        } else {
          ({ item, data, base } = await selfHostedStory(found, token));
          if (!data.values.story.entries.length) {
            if (!files && !found.cfg) $('filesBox').open = true;
            throw new Error(found.cfg ? 'The story settings list no web maps or story item, so there is nothing to convert.'
              : "Couldn't find this story's settings or any readable text. If the website blocks reading its config script, load the saved files instead.");
          }
          src = { id: 'selfhost', bases: [base], pageUrl: found.pageUrl, templateHint: null };
          pageCheck = `Self-hosted page: ${found.pageUrl || found.pageName || '(saved file)'}\n` +
            (found.cfg ? `Settings read from: ${found.configFrom}\nThis page is not an ArcGIS item. Its tab titles come from the settings or the web map titles, and its text from each web map's description.`
              : `No settings were found, so the page's visible text is used.`);
        }
      }

      const tpl = detectTemplate(item, data, src.templateHint);
      if (data && data.values && Array.isArray(data.values.tabs) && data.values.webmap) {
        data.shortlist = await loadShortlist(data.values, base, token);
        const t = data.shortlist;
        if (t && t.places.length) log(`Shortlist: ${t.places.length} places in ${t.tabs.length} tabs read from "${t.layerTitle || t.sourceLayer}" (${t.sourceKind})`, 'ok');
        else if (t) log(`Shortlist: ${t.error || 'no places with a location were found'}`, 'warn');
      }
      if (data && data.values && data.values.settings && data.values.settings.components && data.values.settings.components.map) {
        data.crowdsource = await loadCrowdsource(data.values, base, token);
        const t = data.crowdsource;
        if (t && t.places.length) log(`Crowdsource: ${t.places.length} approved contribution${t.places.length === 1 ? '' : 's'} read${t.capped ? ` (the first ${t.places.length} of ${t.total})` : ''}; contributor names are left out`, 'ok');
        else if (t) log(`Crowdsource: ${t.error || 'no approved contributions with a location were found'}`, 'warn');
      }
      if (data && data.values && (data.values.sourceLayer || tpl.name === 'Map Tour')) {
        data.mapTour = await loadMapTour(data.values, base, token);
        const t = data.mapTour;
        if (t && t.points.length) log(`Map Tour: ${t.points.length} places read from "${t.layerTitle || t.sourceLayer}" (${t.sourceKind})${t.fromAttachments ? `, ${t.fromAttachments} photos from attachments` : ''}`, 'ok');
        else if (t) log(`Map Tour: ${t.error || 'no places with a location were found'}`, 'warn');
      }
      log(`Template: ${tpl.name}${tpl.layout ? ' (' + tpl.layout + ' layout)' : ''}`, tpl.name === 'Unknown' ? 'warn' : 'ok');
      if (tpl.isModern) log('This item is already a modern ArcGIS StoryMap; no conversion needed.', 'warn');
      const entries = extractEntries(data?.values, tpl.name, data);
      const scan = scanText(data);
      const ids = referencedIds(data);
      // Check every referenced ArcGIS item: a map that can't be read shows up blank in the new story
      const refStatus = new Map();
      await Promise.all([...ids.keys()].filter(x => x !== item.id).slice(0, 40).map(async rid => {
        try { const ri = await getJson(`${base}/content/items/${rid}`, token); refStatus.set(rid, { ok: true, title: ri.title, type: ri.type, access: ri.access, owner: ri.owner }); }
        catch (e) { refStatus.set(rid, { ok: false, error: e.message }); }
      }));
      const unread = [...refStatus.entries()].filter(([, r]) => !r.ok);
      if (unread.length) log(`${unread.length} referenced item${unread.length > 1 ? 's' : ''} can't be read (deleted, or not shared publicly): ${unread.map(([rid]) => rid).join(', ')}. Maps that use ${unread.length > 1 ? 'them' : 'it'} can't be shown in the new story. If you have access, paste an access token under "Private or ArcGIS Enterprise story" and read the story again.`, 'warn');
      lastCtx = { item, data, tpl, entries, scan, ids, refStatus, pageCheck, base, src };
      const slug = (item.title || src.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || src.id;
      state.filename = `${slug}_classic_${src.id.slice(0, 8)}.txt`;
      $('fname').replaceChildren(document.createTextNode(state.filename), el('small', { text: `${tpl.name} · ${entries.list.length} ${entries.label.toLowerCase()}` }));
      refreshText();
      $('results').hidden = false;
      window.dispatchEvent(new CustomEvent('classic-read', { detail: lastCtx }));
      log(`Text file ready: ${entries.list.length} ${entries.list.length === 1 ? entries.label.toLowerCase().replace(/s$/, '').replace(/s (\(|views)/, ' $1') : entries.label.toLowerCase()}, ${scan.length} text fields.`, 'ok');
    } catch (err) {
      log(err.message || String(err), 'bad');
      if (location.protocol.startsWith('http') && isBlocked(err) && ID_RE.test($('url').value)) log('The request was blocked before it reached ArcGIS. Open this file directly in your browser (double-click it) rather than in a sandboxed preview.', 'warn');
    } finally {
      $('go').disabled = false;
    }
  }
  $('form').addEventListener('submit', run);
  $('files').addEventListener('change', e => { const f = Array.from(e.target.files || []); if (f.length) run(null, f); e.target.value = ''; });

  function flash(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(flash.h); flash.h = setTimeout(() => t.hidden = true, 1800); }
  $('dl').addEventListener('click', () => {
    const blob = new Blob([state.text], { type: 'text/plain;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: state.filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('Saved');
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.text); flash('Copied'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('text')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); flash('Selected — press Ctrl+C'); }
  });

})();
