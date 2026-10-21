/* Classic StoryMap Extractor, steps 2 and 3: convert the classic story to ArcGIS StoryMaps JSON and create it in ArcGIS Online. */
/* ===== Steps 2 and 3: convert to ArcGIS StoryMaps JSON and create the item =====
   Item format follows Esri's ArcGIS API for Python (arcgis.apps.storymap):
   a "StoryMap" item, story JSON saved as a draft_<ms>.json resource, smstatus* type keywords,
   and on publish the same JSON in the item data plus a published_data.json resource. */
(() => {
  const $ = id => document.getElementById(id);
  const APP_KEYWORD = 'classic-storymap-extractor';
  // shown in place of a web map that has been deleted or is no longer shared
  const PLACEHOLDER_IMG = 'https://trbaker.github.io/storymapconverter/placeholder/image.png';
  const FALLBACK_SM_VERSION = '24.12';
  let classic = null;     // step 1 result
  let built = null;       // { story, outline, warnings, coverSrc }
  let session = null;     // { rest, portalUrl, token, user, isOnline, orgHome, orgName }
  let buildSeq = 0;

  // ---------- small helpers ----------
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');
  const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const norm = s => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const abs = u => {
    if (!u) return '';
    u = String(u).trim();
    if (u.startsWith('//')) u = 'https:' + u;
    return /^https?:\/\//i.test(u) ? u.replace(/^http:\/\/(farm\d+\.static\.flickr\.com|live\.staticflickr\.com)/i, 'https://$1') : '';
  };
  // Recognise YouTube / Vimeo addresses in any form the classic builder stored them
  // (iframe /embed/ src, old Flash /v/ URLs, watch?v=, youtu.be, shorts, nocookie, player.vimeo.com).
  // StoryMaps plays videos from the provider's embed address; links people click must use the watch page,
  // because opening a YouTube /embed/ address directly fails with "Video player configuration error".
  function videoInfo(url) {
    if (!url) return null;
    let u;
    try { u = new URL(String(url).trim().replace(/^\/\//, 'https://')); } catch (_) { return null; }
    const href = u.href;
    let m = href.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|e\/|shorts\/|live\/|watch\?(?:[^#]*&)?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    if (m) {
      const id = m[1];
      const t = u.searchParams.get('start') || u.searchParams.get('t') || (u.hash.match(/t=([^&]+)/) || [])[1] || '';
      let start = 0;
      if (/^\d+$/.test(t)) start = +t;
      else if (t) { const p = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); if (p) start = (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0); }
      return {
        provider: 'YouTube', id,
        embed: `https://www.youtube.com/embed/${id}${start ? '?start=' + start : ''}`,
        watch: `https://www.youtube.com/watch?v=${id}${start ? '&t=' + start + 's' : ''}`
      };
    }
    m = href.match(/(?:player\.vimeo\.com\/video\/|vimeo\.com\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|video\/)?)(\d{6,})/i);
    if (m) return { provider: 'Vimeo', id: m[1], embed: `https://player.vimeo.com/video/${m[1]}`, watch: `https://vimeo.com/${m[1]}` };
    return null;
  }
  // Address to use for a clickable link: watch page for videos, unchanged otherwise
  const linkUrl = u => { const v = videoInfo(u); return v ? v.watch : u; };

  // ---------- web maps behind embedded viewers and apps ----------
  const hexId = s => ((String(s || '').match(/[0-9a-f]{32}/i) || [])[0] || '').toLowerCase();
  function idsIn(x) {
    const out = [];
    (Array.isArray(x) ? x : [x]).forEach(v => {
      const raw = typeof v === 'string' ? v : v && (v.id || v.itemId || v.webmap);
      String(raw || '').split(/[\s,;]+/).forEach(t => { if (/^[0-9a-f]{32}$/i.test(t) && !out.includes(t.toLowerCase())) out.push(t.toLowerCase()); });
    });
    return out;
  }
  // Map Viewer, embed viewers, Instant and configurable apps, classic story apps and item pages
  function mapRefFromUrl(url) {
    let u; try { u = new URL(url); } catch (_) { return null; }
    const q = name => { for (const [k, v] of u.searchParams) if (k.toLowerCase() === name) return v; return null; };
    let extent = null;
    const ex = q('extent');
    if (ex) {
      const n = ex.split(/[,;\s]+/).map(Number);
      if (n.length >= 4 && n.slice(0, 4).every(Number.isFinite)) {
        const geo = n.slice(0, 4).every(x => Math.abs(x) <= 180);
        extent = { xmin: n[0], ymin: n[1], xmax: n[2], ymax: n[3], spatialReference: { wkid: n[4] || (geo ? 4326 : 102100) } };
      }
    }
    const direct = hexId(q('webmap')) || hexId(q('webscene'));
    if (direct) return { id: direct, direct: true, extent };
    const app = hexId(q('appid'));
    if (app) return { id: app, direct: false, extent };
    if (/\/home\/(item|webmap\/viewer|webscene\/viewer)\.html$/i.test(u.pathname) || /\/apps\/(mapviewer|sceneviewer)\b/i.test(u.pathname)) {
      const id = hexId(q('id'));
      if (id) return { id, direct: false, extent };
    }
    return null;
  }
  // The web map an app or classic story shows first
  function appMapId(data) {
    const v = (data && data.values) || {};
    const st = v.story || {};
    const firstMedia = list => {
      for (const e of list || []) { const m = e && e.media; if (m && m.type === 'webmap' && m.webmap && m.webmap.id) return String(m.webmap.id).toLowerCase(); }
      return '';
    };
    return idsIn(v.webmap)[0] || idsIn(v.webmaps)[0] || firstMedia(st.entries) || firstMedia(st.sections) || idsIn(data && data.map && data.map.itemId)[0] || '';
  }

  function logTo(listId, msg, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    const s = document.createElement('span'); s.textContent = msg; li.appendChild(s);
    $(listId).appendChild(li);
    return li;
  }
  function setStep(n) {
    ['st1', 'st2', 'st3'].forEach((id, i) => {
      $(id).classList.toggle('done', i + 1 < n);
      $(id).classList.toggle('now', i + 1 === n);
    });
  }
  function makeIds() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const used = new Set();
    return prefix => {
      let id;
      do {
        const a = crypto.getRandomValues(new Uint8Array(6));
        id = prefix + '-' + Array.from(a, x => chars[x % 62]).join('');
      } while (used.has(id));
      used.add(id);
      return id;
    };
  }

  // ---------- classic HTML -> StoryMaps text blocks ----------
  const BR = '\u0001';
  const CONTAINERS = /^(DIV|SECTION|ARTICLE|CENTER|HEADER|FOOTER|FIGURE|ADDRESS|MAIN|ASIDE|FONT|FORM)$/;
  const BLOCK_SEL = 'p,div,section,article,center,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table,hr,pre,figure';
  const MEDIA_SEL = 'img,iframe,video,embed';

  function inline(node) {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { s += esc(n.nodeValue.replace(/[\s ]+/g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'BR') { s += BR; continue; }
      if (/^(SCRIPT|STYLE|IMG|IFRAME|VIDEO|EMBED|OBJECT|NOSCRIPT)$/.test(t)) continue;
      let inner = inline(n);
      if (/^(P|DIV|LI|H[1-6]|TR)$/.test(t)) inner = BR + inner + BR; // block inside inline context
      if (!inner.split(BR).join('').trim()) { s += inner; continue; }
      const st = (n.getAttribute('style') || '').toLowerCase();
      const bold = t === 'STRONG' || t === 'B' || /font-weight\s*:\s*(bold|[6-9]00)/.test(st);
      const ital = t === 'EM' || t === 'I' || /font-style\s*:\s*italic/.test(st);
      if (ital) inner = '<em>' + inner + '</em>';
      if (bold) inner = '<strong>' + inner + '</strong>';
      if (t === 'A' && n.getAttribute('data-storymaps')) {
        // a Map Journal / Map Series content action: kept as a marker, turned into a map action or plain text later
        s += `<a data-sm-action="${escAttr(n.getAttribute('data-storymaps'))}">${inner}</a>`;
        continue;
      }
      if (t === 'A') {
        const raw = n.getAttribute('href') || '';
        const href = linkUrl(abs(raw)) || (/^mailto:/i.test(raw) ? raw : '');
        if (href) inner = `<a href="${escAttr(href)}" rel="noopener noreferrer" target="_blank">${inner}</a>`;
      }
      s += inner;
    }
    return s;
  }
  // Tidy one run of inline HTML: trim, drop empty formatting tags, keep tags balanced
  function tidy(h) {
    let s = h.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) s = s.replace(/<(strong|em)>\s*<\/\1>/g, '').replace(/<a [^>]*>\s*<\/a>/g, '');
    s = s.replace(/<(strong|em)>\s+/g, ' <$1>').replace(/\s+<\/(strong|em)>/g, '</$1> ').replace(/\s+/g, ' ').trim();
    return s;
  }
  // Split on line breaks without leaving <strong>/<em>/<a> unbalanced across pieces
  function splitBreaks(h) {
    const out = []; const open = [];
    let cur = '';
    const re = /(<\/?(?:strong|em|a)(?:\s[^>]*)?>)|\u0001/g;
    let last = 0, m;
    while ((m = re.exec(h))) {
      cur += h.slice(last, m.index); last = re.lastIndex;
      if (m[0] === BR) {
        out.push(cur + open.slice().reverse().map(t => `</${t.name}>`).join(''));
        cur = open.map(t => t.tag).join('');
      } else {
        cur += m[0];
        const close = m[0][1] === '/';
        const name = m[0].replace(/[<\/>]/g, ' ').trim().split(/\s/)[0];
        if (close) { const i = open.map(t => t.name).lastIndexOf(name); if (i >= 0) open.splice(i, 1); }
        else open.push({ name, tag: m[0] });
      }
    }
    out.push(cur + h.slice(last));
    return out;
  }

  function htmlToBlocks(html) {
    const doc = new DOMParser().parseFromString('<div id="root">' + (html || '') + '</div>', 'text/html');
    const out = [];
    let buf = [];
    const pushText = (style, h, joinBreaks) => {
      const parts = joinBreaks ? [h.split(BR).join(' ')] : splitBreaks(h);
      for (const p of parts) {
        const clean = tidy(p);
        if (strip(clean)) out.push({ kind: 'text', style, html: clean });
      }
    };
    const media = el => {
      const list = el.matches && el.matches(MEDIA_SEL) ? [el] : Array.from(el.querySelectorAll ? el.querySelectorAll(MEDIA_SEL) : []);
      return list.map(m => {
        if (m.tagName === 'IMG') return { kind: 'image', src: abs(m.getAttribute('src')), alt: m.getAttribute('alt') || '' };
        const src = m.getAttribute('src') || m.getAttribute('data-src') || (m.querySelector('source') && m.querySelector('source').getAttribute('src'));
        // old Flash <embed> players only survive as videos; anything else they held no longer plays
        if (m.tagName === 'EMBED' && !videoInfo(src)) return {};
        return { kind: 'embed', url: abs(src), video: !!videoInfo(src) };
      }).filter(x => x.src || x.url);
    };
    const flush = () => {
      if (!buf.length) return;
      const span = doc.createElement('span');
      buf.forEach(n => span.appendChild(n.cloneNode(true)));
      buf = [];
      pushText('paragraph', inline(span));
    };
    const walk = container => {
      for (const n of Array.from(container.childNodes)) {
        if (n.nodeType === 3) { buf.push(n); continue; }
        if (n.nodeType !== 1) continue;
        const t = n.tagName;
        if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(t)) continue;
        if (t === 'IMG' || t === 'IFRAME' || t === 'VIDEO' || t === 'EMBED' || t === 'OBJECT') { flush(); out.push(...media(n)); continue; }
        const isBlock = CONTAINERS.test(t) || /^(P|H[1-6]|UL|OL|BLOCKQUOTE|TABLE|HR|PRE|FIGCAPTION|DL)$/.test(t);
        if (!isBlock) {
          if (n.querySelector(BLOCK_SEL)) { flush(); walk(n); flush(); continue; }
          buf.push(n);
          if (n.querySelector(MEDIA_SEL)) { flush(); out.push(...media(n)); }
          continue;
        }
        flush();
        if (CONTAINERS.test(t)) { walk(n); flush(); continue; }
        if (/^H[1-6]$/.test(t)) { pushText(+t[1] <= 3 ? 'h3' : 'h4', inline(n), true); out.push(...media(n)); continue; }
        if (t === 'BLOCKQUOTE') { pushText('quote', inline(n), true); out.push(...media(n)); continue; }
        if (t === 'UL' || t === 'OL') {
          const items = Array.from(n.querySelectorAll('li')).map(li => {
            const c = li.cloneNode(true);
            c.querySelectorAll('ul,ol').forEach(x => x.remove());
            return tidy(inline(c).split(BR).join(' '));
          }).filter(strip);
          if (items.length) out.push({ kind: 'text', style: t === 'UL' ? 'bullet-list' : 'numbered-list', html: items.map(i => '<li>' + i + '</li>').join('') });
          out.push(...media(n));
          continue;
        }
        if (t === 'TABLE') {
          for (const tr of n.querySelectorAll('tr')) {
            const cells = Array.from(tr.children).map(td => tidy(inline(td).split(BR).join(' '))).filter(strip);
            if (cells.length) pushText('paragraph', cells.join(' · '), true);
          }
          out.push(...media(n));
          continue;
        }
        if (t === 'HR') { out.push({ kind: 'separator' }); continue; }
        pushText('paragraph', inline(n)); // P, PRE, FIGCAPTION, DL
        out.push(...media(n));
      }
    };
    walk(doc.getElementById('root'));
    flush();
    // collapse repeated separators and separators at the ends
    return out.filter((b, i, a) => !(b.kind === 'separator' && (i === 0 || i === a.length - 1 || a[i - 1].kind === 'separator')));
  }

  // ---------- classic entries -> normalised list ----------
  function classicMedia(m) {
    if (!m || !m.type) return null;
    const b = m[m.type] || {};
    if (m.type === 'webmap' && b.id) return { kind: 'webmap', id: b.id, extent: b.extent, layers: b.layers, caption: strip(b.caption || '') };
    // Cascade web scenes: the same map block, which reads the scene's item type and camera
    if (m.type === 'webscene' && b.id) return { kind: 'webmap', id: b.id, caption: strip(b.caption || '') };
    if (m.type === 'image' && abs(b.url)) return { kind: 'image', src: abs(b.url), alt: b.altText || b.alt || '', caption: strip(b.caption || '') };
    if (m.type === 'video' && !b.url && b.id && /^(youtube|vimeo)$/i.test(b.source || '')) {
      // Cascade stores YouTube and Vimeo videos by provider and id
      const url = /youtube/i.test(b.source) ? `https://www.youtube.com/watch?v=${b.id}` : `https://vimeo.com/${b.id}`;
      return { kind: 'embed', url, video: true, caption: strip(b.caption || '') };
    }
    if (m.type === 'webpage' || m.type === 'video') {
      let url = b.url;
      if (!url && b.frameTag) { const mm = String(b.frameTag).match(/src=["']([^"']+)/i); url = mm && mm[1]; }
      if (!url && b.frameTag) { const mm = String(b.frameTag).match(/data-src=["']([^"']+)/i); url = mm && mm[1]; }
      return abs(url) ? { kind: 'embed', url: abs(url), video: !!videoInfo(url), caption: strip(b.caption || '') } : null;
    }
    return null;
  }
  // Classic Swipe and Spyglass: two web maps side by side (TWO_WEBMAPS),
  // or one web map with some of its layers shown on one side only (TWO_LAYERS)
  function classicSwipe(v) {
    if (!v || !/^TWO_(WEBMAPS|LAYERS)$/.test(v.dataModel || '')) return null;
    let maps = idsIn(v.webmaps);
    if (maps.length < 2) maps = idsIn(v.webmap).concat(maps).filter((x, i, a) => a.indexOf(x) === i);
    if (!maps.length) return null;
    const twoLayers = v.dataModel === 'TWO_LAYERS';
    const one = idsIn(v.webmap)[0] || maps[0];
    const swiped = (Array.isArray(v.layers) ? v.layers : [v.layers]).filter(x => typeof x === 'string' && x);
    const lab = v.labels;
    const labels = (Array.isArray(lab) ? lab : lab && typeof lab === 'object' ? [lab.left ?? lab[0], lab.right ?? lab[1]] : [])
      .map(x => typeof x === 'string' ? strip(x) : '');
    return {
      spyglass: v.layout === 'spyglass',
      // the swiped layers show on the left of the handle and are hidden on the right
      left: { id: twoLayers ? one : maps[0], layers: twoLayers ? swiped.map(id => ({ id, visibility: true })) : [] },
      right: { id: twoLayers ? one : (maps[1] || maps[0]), layers: twoLayers ? swiped.map(id => ({ id, visibility: false })) : [] },
      swiped: twoLayers ? swiped : [], labels,
      intro: v.description !== false ? (v.sidePanelDescription || '') : '',
      bookmarks: v.series && Array.isArray(v.bookmarks) ? v.bookmarks : []
    };
  }

  function classicEntries(ctx) {
    const v = (ctx.data && ctx.data.values) || {};
    // readers only ever saw published entries: Map Series hides with "HIDDEN", Map Journal keeps drafts as "DRAFT"
    const shown = e => e && (!e.status || e.status === 'PUBLISHED');
    if (v.story && Array.isArray(v.story.entries))
      return v.story.entries.filter(shown).map(e => ({ title: strip(e.title), html: e.description || '', media: classicMedia(e.media), actions: e.contentActions || [] }));
    if (v.story && Array.isArray(v.story.sections))
      return v.story.sections.filter(shown).map(s => ({ title: strip(s.title), html: s.content || '', media: classicMedia(s.media), actions: s.contentActions || [] }));
    const list = (ctx.entries && ctx.entries.list) || [];
    if (list.length) return list.map(e => ({
      title: strip(e.title), html: e.html || '',
      media: e.media.type === 'image' && abs(e.media.ref) ? { kind: 'image', src: abs(e.media.ref) }
        : e.media.type === 'webmap' && /^[0-9a-f]{32}/i.test(e.media.ref) ? { kind: 'webmap', id: e.media.ref.slice(0, 32) }
        : /^(webpage|video)$/.test(e.media.type) && abs(e.media.ref) ? { kind: 'embed', url: abs(e.media.ref), video: !!videoInfo(e.media.ref) } : null
    }));
    // A story that is just a web map (Story Map Basic and similar): the cover and the main map carry it
    if (idsIn(v.webmap).length) return [];
    const text = (ctx.scan || []).map(s => `<p>${esc(s.text)}</p>`).join('');
    return text ? [{ title: ctx.item.title || '', html: text, media: null }] : [];
  }

  // ---------- media lookups (cached across rebuilds) ----------
  const sizeCache = new Map();
  function imageSize(src) {
    if (sizeCache.has(src)) return sizeCache.get(src);
    const p = new Promise(resolve => {
      const img = new Image();
      const done = (w, h) => { clearTimeout(timer); resolve({ w: w || 1200, h: h || 800, ok: !!w }); };
      const timer = setTimeout(() => done(0, 0), 8000);
      img.onload = () => done(img.naturalWidth, img.naturalHeight);
      img.onerror = () => done(0, 0);
      img.src = src;
    });
    sizeCache.set(src, p);
    return p;
  }
  const mapCache = new Map();
  async function getJson(url) {
    const r = await fetch(url, { credentials: 'omit' });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'ArcGIS error');
    return j;
  }
  function webmapInfo(id) {
    if (mapCache.has(id)) return mapCache.get(id);
    const p = (async () => {
      const tries = [{ rest: classic.base, token: '' }];
      if (session) tries.push({ rest: session.rest, token: session.token });
      for (const t of tries) {
        try {
          const q = 'f=json' + (t.token ? '&token=' + encodeURIComponent(t.token) : '');
          const item = await getJson(`${t.rest}/content/items/${id}?${q}`);
          const data = await getJson(`${t.rest}/content/items/${id}/data?${q}`).catch(() => ({}));
          return { item, data };
        } catch (_) { /* next */ }
      }
      return null;
    })();
    mapCache.set(id, p);
    return p;
  }
  async function resolveEmbedMap(url) {
    const ref = mapRefFromUrl(url);
    if (!ref) return null;
    if (ref.direct) return { id: ref.id, extent: ref.extent };
    const info = await webmapInfo(ref.id);
    if (!info) return { unresolved: ref.id };
    if (/^Web (Map|Scene)$/.test(info.item.type)) return { id: ref.id, extent: ref.extent };
    const mid = appMapId(info.data);
    return mid ? { id: mid, extent: ref.extent } : { unresolved: ref.id, app: info.item.title };
  }
  // ---------- old web maps ----------
  // Web maps saved before the 2.x specification (roughly 2012 to 2014), or with http:// layers, can fail in
  // ArcGIS StoryMaps. An updated copy keeps every original layer reference and fills in what the current
  // specification expects: layer types, https addresses, a spatial reference and a starting view.
  const WEBMAP_VERSION = '2.28';
  const ACCESS_RANK = { private: 0, shared: 1, org: 2, public: 3 };
  const ACCESS_LABEL = { private: 'only with its owner', shared: 'with groups only', org: 'with its organization', public: 'with everyone' };

  function allLayers(data) {
    const out = [];
    const walk = list => (list || []).forEach(l => { out.push(l); if (Array.isArray(l.layers) && l.layerType === 'GroupLayer') walk(l.layers); });
    walk(data && data.baseMap && data.baseMap.baseMapLayers);
    walk(data && data.operationalLayers);
    return out;
  }
  function oldMapReasons(data) {
    if (!data || !(data.operationalLayers || data.baseMap)) return [];
    const why = [];
    const ver = parseFloat(String(data.version || '0'));
    if (!(ver >= 2)) why.push(`web map version ${data.version || 'unknown'}`);
    const layers = allLayers(data);
    if (layers.some(l => !l.layerType)) why.push('layers without a type');
    if (layers.some(l => /^http:\/\//i.test(l.url || l.styleUrl || l.templateUrl || ''))) why.push('http:// layers');
    if (layers.some(isBing)) why.push('Bing basemap');
    return why;
  }

  // Bing basemaps needed the original author's Bing key; they're swapped for the matching Esri basemap services
  const isBing = l => /^bingmaps/i.test(String(l.type || l.layerType || ''));
  const ESRI_TILES = 'https://services.arcgisonline.com/ArcGIS/rest/services/';
  function esriForBing(l) {
    const kind = String(l.type || l.layerType).replace(/^bingmaps/i, '').toLowerCase();
    const tiled = (name, title, extra) => Object.assign({ id: `${name.replace(/\W+/g, '_')}_${Math.random().toString(36).slice(2, 6)}`, layerType: 'ArcGISTiledMapServiceLayer',
      url: ESRI_TILES + name + '/MapServer', title, visibility: l.visibility !== false, opacity: l.opacity === undefined ? 1 : l.opacity }, extra || {});
    if (kind === 'road') return [tiled('World_Street_Map', 'World Street Map')];
    const out = [tiled('World_Imagery', 'World Imagery')];
    if (kind === 'hybrid') out.push(tiled('Reference/World_Boundaries_and_Places', 'World Boundaries and Places', { isReference: true }));
    return out;
  }

  const svcCache = new Map();
  function probeService(url) {
    if (svcCache.has(url)) return svcCache.get(url);
    const p = (async () => {
      const https = url.replace(/^http:/i, 'https:');
      for (const u of https === url ? [url] : [https, url]) {
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(u.replace(/\/+$/, '') + (u.includes('?') ? '&' : '?') + 'f=json', { signal: ctl.signal, credentials: 'omit' });
          clearTimeout(t);
          const j = await r.json();
          if (j && !j.error) return { url: u, json: j };
          if (j && j.error && [403, 498, 499].includes(j.error.code)) return { url: u, json: null, secured: true };
        } catch (_) { /* try the next address */ }
      }
      // gone, or only on http (which an https story can't load either): keep the https address
      return { url: https, json: null, dead: true };
    })();
    svcCache.set(url, p);
    return p;
  }

  function inferLayerType(l, svc, isBase) {
    const t = String(l.type || '').toLowerCase(), u = String(l.url || '').toLowerCase().replace(/\?.*$/, '');
    if (l.featureCollection) return 'ArcGISFeatureLayer';
    const byType = { csv: 'CSV', kml: 'KML', wms: 'WMS', wmts: 'WMTS', georss: 'GeoRSS', openstreetmap: 'OpenStreetMap', webtiledlayer: 'WebTiledLayer', vectortilelayer: 'VectorTileLayer' };
    if (byType[t]) return byType[t];
    if (/^bingmaps/.test(t)) return l.type;
    if (/\/featureserver\/\d+\/?$/.test(u) || /\/mapserver\/\d+\/?$/.test(u)) return 'ArcGISFeatureLayer';
    if (/\/featureserver\/?$/.test(u)) return 'ArcGISFeatureLayer';
    if (/\/vectortileserver/.test(u)) return 'VectorTileLayer';
    if (/\/imageserver\/?$/.test(u)) return svc && svc.singleFusedMapCache === true ? 'ArcGISTiledImageServiceLayer' : 'ArcGISImageServiceLayer';
    if (/\/mapserver\/?$/.test(u)) {
      if (svc) return svc.tileInfo && svc.singleFusedMapCache !== false ? 'ArcGISTiledMapServiceLayer' : 'ArcGISMapServiceLayer';
      return isBase && !l.visibleLayers && !l.layers ? 'ArcGISTiledMapServiceLayer' : 'ArcGISMapServiceLayer';
    }
    return null;
  }

  async function modernizeWebmap(info) {
    const d = JSON.parse(JSON.stringify(info.data));
    const issues = [];
    let baseSr = null;
    const fix = async (l, isBase) => {
      let svc = null;
      if (l.url && /\/rest\/services\//i.test(l.url)) {
        const pr = await probeService(l.url);
        if (pr.dead) issues.push(`layer "${l.title || l.id}" didn't respond, so it may not draw`);
        l.url = pr.url; svc = pr.json;
        if (isBase && svc && svc.spatialReference && !baseSr) baseSr = svc.spatialReference;
      } else if (l.url) l.url = String(l.url).replace(/^http:/i, 'https:');
      for (const k of ['styleUrl', 'templateUrl']) if (l[k]) l[k] = String(l[k]).replace(/^http:/i, 'https:');
      if (!l.layerType) {
        const lt = inferLayerType(l, svc, isBase);
        if (lt) l.layerType = lt; else issues.push(`couldn't tell what kind of layer "${l.title || l.id}" is`);
      }
      if (l.layerType === 'VectorTileLayer' && !l.styleUrl && l.url) l.styleUrl = l.url.replace(/\/?$/, '/resources/styles/root.json');
      if (l.layerType === 'GroupLayer' && Array.isArray(l.layers)) await Promise.all(l.layers.map(x => fix(x, isBase)));
    };
    if (d.baseMap && Array.isArray(d.baseMap.baseMapLayers) && d.baseMap.baseMapLayers.some(isBing)) {
      d.baseMap.baseMapLayers = [].concat(...d.baseMap.baseMapLayers.map(l => isBing(l) ? esriForBing(l) : [l]));
      d.baseMap.title = /road/i.test(d.baseMap.title || '') ? 'Streets' : /hybrid/i.test(d.baseMap.title || '') ? 'Imagery Hybrid' : d.baseMap.title && !/bing/i.test(d.baseMap.title) ? d.baseMap.title : 'Imagery';
      issues.push('its Bing basemap was swapped for the matching Esri basemap');
    }
    const base = (d.baseMap && d.baseMap.baseMapLayers) || [];
    await Promise.all(base.map(l => fix(l, true)).concat((d.operationalLayers || []).map(l => fix(l, false))));
    if (!d.spatialReference) {
      const sr = baseSr || { wkid: 102100 };
      d.spatialReference = [102100, 3857, 102113].includes(sr.latestWkid || sr.wkid) ? { wkid: 102100, latestWkid: 3857 } : sr;
    }
    if (!d.initialState) {
      const e = info.item.extent;
      const wk = d.spatialReference.latestWkid || d.spatialReference.wkid;
      if (Array.isArray(e) && e.length === 2) {
        let g = null;
        if ([3857, 102100].includes(wk)) { const [a, b] = toMercator(e[0][0], e[0][1]), [c, f] = toMercator(e[1][0], e[1][1]); g = { xmin: a, ymin: b, xmax: c, ymax: f }; }
        else if (wk === 4326) g = { xmin: e[0][0], ymin: e[0][1], xmax: e[1][0], ymax: e[1][1] };
        if (g) d.initialState = { viewpoint: { targetGeometry: Object.assign(g, { spatialReference: d.spatialReference }) } };
      }
    }
    if (Array.isArray(d.bookmarks)) d.bookmarks = d.bookmarks.map(b => b && b.extent && !b.viewpoint ? Object.assign({}, b, { viewpoint: { targetGeometry: b.extent } }) : b);
    d.version = WEBMAP_VERSION;
    d.authoringApp = 'ClassicStoryMapExtractor';
    d.authoringAppVersion = '1.1';
    return { data: d, issues };
  }

  // ---------- express maps ----------
  // A classic web map whose only layers are sketched notes (Map Notes and other feature collections stored
  // inside the map) is rebuilt as an express map: each note becomes an editable drawing with its popup, over a
  // copy of the web map without those layers. Format checked against 174 published express maps (2019 to 2026):
  // item resource expressmap_<ms>.json with basemap, drawings, groups, popups, viewPlacement, extent, scale, center;
  // drawing types POINT_REGULAR, POLYLINE, POLYGON and TEXT_LEADERLINE (one node, data.content).
  const EXPRESS_MAX = 200;
  const NOTE_FIELDS = new Set(['objectid', 'fid', 'oid', 'typeid', 'visible', 'title', 'name', 'description', 'desc', 'comment', 'image_url', 'image_link_url', 'text', 'date', 'shape', 'shape_length', 'shape_area']);
  const hexColor = c => Array.isArray(c) && c.length >= 3 && (c[3] === undefined || c[3] > 0)
    ? '#' + c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(+v || 0))).toString(16).padStart(2, '0')).join('') : null;
  function expressPlan(info, mapLayers, newId) {
    const ops = (info && info.data && info.data.operationalLayers) || [];
    if (!ops.length) return null;
    const shown = new Map((mapLayers || []).map(l => [String(l.id), l.visible]));
    const drawings = {}, popups = {}, groups = [], dropLayers = [];
    let count = 0;
    for (const op of ops) {
      if (!op.featureCollection || op.url || !Array.isArray(op.featureCollection.layers)) return null; // a data layer: keep a web map
      dropLayers.push(op.id);
      if (shown.get(String(op.id)) === false || op.visibility === false && !shown.has(String(op.id))) continue;
      for (const fl of op.featureCollection.layers) {
        const fs = fl.featureSet || {}, ld = fl.layerDefinition || {};
        const feats = (fs.features || []).filter(f => f && f.geometry);
        if (!feats.length) continue;
        const gt = ld.geometryType || fs.geometryType;
        if (!/esriGeometry(Point|Polyline|Polygon)$/.test(gt || '')) return null;
        // Only sketched notes (the Map Notes schema): imported CSV, shapefile or GPX data keeps its fields and popups in a web map
        const fields = (ld.fields || []).map(f => String(f.name || '').toLowerCase());
        if (fields.some(f => !NOTE_FIELDS.has(f))) return null;
        const r = (ld.drawingInfo && ld.drawingInfo.renderer) || {};
        const symOf = f => f.symbol || (r.uniqueValueInfos && r.field1 && ((r.uniqueValueInfos.find(u => String(u.value) === String((f.attributes || {})[r.field1])) || {}).symbol)) || r.defaultSymbol || r.symbol || null;
        const ids = [];
        for (const f of feats) {
          const sym = symOf(f);
          const isText = sym && sym.type === 'esriTS';
          const sr = f.geometry.spatialReference || fs.spatialReference || (ld.extent && ld.extent.spatialReference) || { wkid: 102100 };
          const wk = sr.latestWkid || sr.wkid;
          if (![4326, 3857, 102100, 102113].includes(wk)) return null;
          const pt = (x, y) => {
            let lon = x, lat = y, px = x, py = y;
            if (wk === 4326) [px, py] = toMercator(x, y);
            else { lon = x / 6378137 * 180 / Math.PI; lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI; }
            return { long: +lon.toFixed(7), lat: +lat.toFixed(7), ele: 0, proX: px, proY: py, proZ: 0, w: 0 };
          };
          let type, pts, data = null;
          if (/Point$/.test(gt)) {
            if (!Number.isFinite(f.geometry.x) || !Number.isFinite(f.geometry.y)) continue;
            pts = [pt(f.geometry.x, f.geometry.y)];
            if (isText) {
              // a Map Notes text label becomes an express-map text label
              const content = strip(sym.text || (f.attributes || {}).TEXT || (f.attributes || {}).text || '');
              if (!content) continue;
              type = 'TEXT_LEADERLINE'; data = { content }; pts = [{ long: pts[0].long, lat: pts[0].lat }];
            } else type = 'POINT_REGULAR';
          } else if (/Polyline$/.test(gt)) {
            const paths = f.geometry.paths || [];
            if (paths.length !== 1) return null; // several parts: keep the web map
            if (paths[0].length < 2) continue;
            type = 'POLYLINE'; pts = paths[0].map(c => pt(c[0], c[1]));
          } else {
            const rings = f.geometry.rings || [];
            if (rings.length !== 1) return null; // holes or several parts: keep the web map
            const ring = rings[0].slice();
            if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
            if (ring.length < 3) continue;
            type = 'POLYGON'; pts = ring.map(c => pt(c[0], c[1]));
          }
          if (++count > EXPRESS_MAX) return null; // too many for hand-drawn notes; a web map draws them better
          const did = newId();
          const color = sym && (hexColor(sym.type === 'esriSFS' ? (sym.color && sym.color[3] ? sym.color : sym.outline && sym.outline.color) : sym.color));
          if (type === 'TEXT_LEADERLINE') {
            drawings[did] = { id: did, type, styles: { textColor: 'titleColor', backgroundColor: 'backgroundColor' }, data, nodes: pts };
            ids.push(did);
            continue;
          }
          drawings[did] = Object.assign({ id: did, type, nodes: pts }, color ? { styles: { color } } : {});
          const a = f.attributes || {};
          const val = keys => { for (const k of Object.keys(a)) if (keys.includes(k.toLowerCase()) && a[k] !== null && String(a[k]).trim()) return String(a[k]).trim(); return ''; };
          const title = val(['title', 'name']), desc = val(['description', 'desc', 'comment']), img = val(['image_url']), link = val(['image_link_url']);
          let html = desc ? (/<[a-z][\s\S]*>/i.test(desc) ? (/^\s*<(p|div|ul|ol|h\d|blockquote)\b/i.test(desc) ? desc : `<p>${desc}</p>`) : `<p>${esc(desc)}</p>`) : '';
          if (/^https?:\/\//i.test(link || img)) html += `<p><a href="${escAttr(link || img)}">${img ? 'View photo' : 'More information'}</a></p>`;
          if (title || html) popups[did] = { id: did, title: title || '', description: html };
          ids.push(did);
        }
        if (ids.length) groups.push({ drawingIds: ids, title: op.featureCollection.layers.length > 1 ? (ld.name || op.title || '') : (op.title || ld.name || '') });
      }
    }
    if (!count) return null;
    return { drawings, groups, popups, dropLayers, count };
  }

  function toMercator(x, y) {
    const R = 6378137, lat = Math.max(Math.min(y, 85.0511), -85.0511);
    return [x * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
  }
  function normExtent(e) {
    if (!e) return null;
    if (Array.isArray(e)) {
      if (!Array.isArray(e[0]) || !Array.isArray(e[1])) return null;
      e = { xmin: e[0][0], ymin: e[0][1], xmax: e[1][0], ymax: e[1][1], spatialReference: { wkid: 4326 } };
    }
    if (typeof e.xmin !== 'number') return null;
    let sr = e.spatialReference || { wkid: 102100 };
    if ([102100, 3857, 102113].includes(sr.wkid) || sr.latestWkid === 3857) sr = { latestWkid: 3857, wkid: 102100 };
    if ((sr.latestWkid || sr.wkid) === 4326) {
      const [a, b] = toMercator(e.xmin, e.ymin), [c, d] = toMercator(e.xmax, e.ymax);
      return { xmin: a, ymin: b, xmax: c, ymax: d, spatialReference: { wkid: 102100, latestWkid: 3857 } };
    }
    return { xmin: e.xmin, ymin: e.ymin, xmax: e.xmax, ymax: e.ymax, spatialReference: sr };
  }

  // The title readers saw: the story's own title, a Cascade cover title, or a Crowdsource intro title
  function classicTitle(ctx) {
    const v = (ctx && ctx.data && ctx.data.values) || {};
    if (typeof v.title === 'string' && strip(v.title)) return strip(v.title);
    const cover = Array.isArray(v.sections) && v.sections.find(x => x && x.type === 'cover');
    const ct = cover && cover.foreground && cover.foreground.title;
    if (ct) return strip(typeof ct === 'string' ? ct : ct.value || '');
    const intro = v.settings && v.settings.components && v.settings.components.intro;
    return intro && intro.title ? strip(intro.title) : '';
  }

  // The classic story's author, for the new story's byline: the story item's owner, shown by their public
  // full name when their profile shares it (otherwise their username). A self-hosted story has no item, so
  // the owner of its web maps is used when they all belong to one person.
  async function classicAuthor(ctx) {
    const rest = ctx.base || 'https://www.arcgis.com/sharing/rest';
    let owner = (ctx.item && ctx.item.owner) || '';
    if (!owner) {
      const v = (ctx.data && ctx.data.values) || {};
      const ids = idsIn(v.webmap).concat(idsIn(v.webmaps), ...classicEntries(ctx).map(e => e.media && e.media.kind === 'webmap' ? [String(e.media.id).toLowerCase()] : []))
        .filter((x, i, a) => a.indexOf(x) === i).slice(0, 12);
      const owners = new Set((await Promise.all(ids.map(webmapInfo))).filter(Boolean).map(i => i.item.owner).filter(Boolean));
      if (owners.size === 1) owner = [...owners][0];
    }
    if (!owner) return '';
    try {
      const u = await getJson(`${rest}/community/users/${encodeURIComponent(owner)}?f=json`);
      return (u.fullName || '').trim() || owner;
    } catch (_) { return owner; } // private profile
  }

  // ---------- build the story JSON ----------
  async function buildStory(ctx, opts) {
    const id = makeIds();
    const nodes = {}, resources = {};
    const warnings = [];
    const add = (type, data, more = {}) => {
      const k = id('n');
      nodes[k] = Object.assign({ type }, data === undefined ? {} : { data }, more);
      return k;
    };
    const imgRes = new Map();
    const imageResource = async src => {
      if (imgRes.has(src)) return imgRes.get(src);
      const { w, h, ok } = await imageSize(src);
      if (!ok) warnings.push(`Image could not be loaded and may be missing in the new story: ${src}`);
      const r = id('r');
      resources[r] = { type: 'image', data: { src, provider: 'uri', width: w, height: h } };
      imgRes.set(src, r);
      return r;
    };
    const imageNode = async (src, alt, caption, size) => {
      const n = add('image', { image: await imageResource(src), caption: caption || '', alt: alt || '' });
      if (size) nodes[n].config = { size };
      return n;
    };
    const embedNode = (url, caption, display) => {
      const v = videoInfo(url);
      if (v) {
        // Same shape Esri's Python API writes for a video URL: an inline "video" embed of the provider's player address
        return add('embed', {
          url: v.embed, embedType: 'video', caption: caption || '', alt: `${v.provider} video`,
          display: 'inline', aspectRatio: 1.778, addedAsEmbedCode: true
        });
      }
      url = linkUrl(url);
      let host = ''; try { host = new URL(url).host; } catch (_) { /* keep blank */ }
      return add('embed', { url, embedType: 'link', title: host, description: caption || '', providerUrl: host, alt: '', display: display || 'card', embedSrc: url });
    };
    // The starting view of a map: the classic entry's own extent first (so it applies even when the map can't be read),
    // then the web map's saved view, then the item's extent; plus per-entry layer visibility
    const computeView = (info, m) => {
      const out = {};
      const vp = (info && info.data.initialState && info.data.initialState.viewpoint) || {};
      const isScene = info && info.item.type === 'Web Scene';
      const extent = isScene ? null : normExtent(m.extent) || normExtent(vp.targetGeometry) || (info ? normExtent(info.item.extent) : null);
      if (isScene && vp.camera) Object.assign(out, { viewpoint: vp, camera: vp.camera, center: vp.camera.position });
      if (extent) {
        const center = { spatialReference: extent.spatialReference, x: (extent.xmin + extent.xmax) / 2, y: (extent.ymin + extent.ymax) / 2 };
        const scale = m.scale || (!m.extent && vp.scale) || Math.max(1000, (extent.xmax - extent.xmin) / 0.24);
        Object.assign(out, {
          extent, center,
          zoom: Math.max(0, Math.min(20, Math.round(Math.log2(591657527.591555 / scale)))),
          viewpoint: { rotation: vp.rotation || 0, scale, targetGeometry: center }
        });
      }
      if (info) {
        // Classic stories name feature-collection layers "<layer id>_<n>", so match those to their web map layer too
        const vis = new Map((m.layers || []).filter(l => l && l.id !== undefined).map(l => [String(l.id), l.visibility]));
        const visOf = lid => {
          if (vis.has(lid)) return vis.get(lid);
          for (const [k, val] of vis) if (k.startsWith(lid + '_') && /^\d+$/.test(k.slice(lid.length + 1))) return val;
          return undefined;
        };
        out.mapLayers = (info.data.operationalLayers || []).map(l => {
          const v2 = visOf(String(l.id));
          return { id: l.id, title: l.title || '', visible: v2 !== undefined ? !!v2 : l.visibility !== false };
        });
      }
      return out;
    };
    const expressFiles = {}, expressBases = [];
    const standins = new Map(); // unreadable web map id -> number of placeholder images put in its place
    let expressSeq = 0, expressCount = 0, expressNotes = 0;
    const mapNode = async (m, size) => {
      const info = await webmapInfo(m.id);
      if (opts.express && info && info.item.type === 'Web Map') {
        const view = computeView(info, m);
        const plan = view.extent ? expressPlan(info, view.mapLayers, uuid) : null;
        if (plan) {
          const file = `expressmap_${Date.now() + expressSeq++}.json`;
          const r = id('r');
          resources[r] = { type: 'expressmap', data: { itemId: file } };
          // The basemap is a web map; at create time it becomes a copy of the classic map without the note layers
          expressFiles[file] = {
            basemap: { type: 'resource', value: m.id }, drawings: plan.drawings, groups: plan.groups, popups: plan.popups,
            viewPlacement: 'extent', layerDefinitions: [], visConfigs: [],
            extent: view.extent, scale: view.viewpoint.scale, center: view.center
          };

          expressCount++; expressNotes += plan.count;
          // the builder repeats the basemap on the block (seen in every express map saved since 2025)
          const n = add('expressmap', { map: r, caption: m.caption || '', basemap: m.id });
          expressBases.push({ file, node: n, webmap: m.id, dropLayers: plan.dropLayers });
          if (size) nodes[n].config = { size };
          return n;
        }
      }
      if (!info && opts.standin) {
        // The web map is deleted or private, so a linked map block would stay blank: show the placeholder graphic instead
        standins.set(m.id, (standins.get(m.id) || 0) + 1);
        return imageNode(PLACEHOLDER_IMG, 'Map unavailable', m.caption || '', size);
      }
      const r = id('r');
      // Matches what the StoryMaps builder writes: a "default" map resource, and the starting view
      // repeated on the map block itself, which sidecar slides need to open the map.
      // The map references the web map item; its feature and image services are pointed to, never copied.
      const data = Object.assign({ itemId: m.id, itemType: (info && info.item.type) || 'Web Map', type: 'default' }, computeView(info, m));
      if (!info) warnings.push(`Web map ${m.id} can't be read (deleted, or not shared publicly), so it will look blank until its owner shares it. The story still links it${data.extent ? ' and opens it at the classic view' : ''}.`);
      resources[r] = { type: 'webmap', data };
      const view = {};
      for (const k of ['extent', 'center', 'zoom', 'viewpoint', 'camera', 'mapLayers']) if (data[k] !== undefined) view[k] = JSON.parse(JSON.stringify(data[k]));
      const n = add('webmap', Object.assign({ map: r, caption: m.caption || '', alt: '', timeSlider: false }, view.extent || view.camera ? { viewPlacement: 'extent' } : {}, view));
      if (m.showLegend) nodes[n].data.isShowingLegend = true;
      if (size) nodes[n].config = { size };
      return n;
    };
    const uuid = () => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    // Classic Map Tour -> StoryMaps guided tour: numbered places on a tour map, each with a title, text and media
    const tourNode = async (t, pts, o = {}) => {
      const zoom = parseFloat(t.zoomLevel);
      const scale = Number.isFinite(zoom) && zoom > 0 ? Math.round(591657527.591555 / Math.pow(2, zoom)) : 18056;
      const geometries = {}, places = [];
      let videos = 0, noMedia = 0;
      for (const p of pts) {
        const fid = uuid();
        geometries[fid] = { id: fid, type: 'POINT_NUMBERED_TOUR', nodes: [{ long: +p.lon.toFixed(6), lat: +p.lat.toFixed(6) }], scale };
        const title = add('text', { type: 'h3', text: esc(p.name || 'Untitled place') }, { config: { size: 'wide' } });
        const blocks = htmlToBlocks(p.description);
        const contents = blocks.filter(b => b.kind === 'text').map(b => add('text', { type: b.style, text: b.html }, { config: { size: 'wide' } }));
        const kids = [];
        const pic = abs(p.pic), thumb = abs(p.thumb);
        if (p.isVideo && pic) { kids.push(embedNode(pic, '', 'inline')); videos++; }
        else if (pic || thumb) kids.push(await imageNode(pic || thumb, p.name || '', ''));
        for (const b of blocks) {
          if (b.kind === 'image') kids.push(await imageNode(b.src, b.alt, ''));
          else if (b.kind === 'embed' && b.video) kids.push(embedNode(b.url, '', 'inline'));
        }
        const place = { id: id('n'), featureId: fid, contents, title };
        if (kids.length) place.media = add('carousel', undefined, { children: kids }); else noMedia++;
        places.push(place);
      }
      if (noMedia) warnings.push(`${noMedia} ${o.what || 'tour place'}${noMedia > 1 ? 's have' : ' has'} no photo or video; add one in the builder.`);
      // The tour map's basemap is the classic web map; when the story is created it becomes a copy without the tour's point layer
      let basemap = { type: 'name', value: 'community' }, baseRes = null;
      const info = await webmapInfo(t.webmap);
      if (info && info.item.type === 'Web Map') {
        baseRes = id('r');
        resources[baseRes] = { type: 'webmap', data: { type: 'minimal', itemType: 'Web Map', itemId: t.webmap } };
        basemap = { type: 'resource', value: baseRes };
      } else warnings.push("The tour's web map couldn't be read, so the tour uses a standard basemap.");
      const map = add('tour-map', { geometries, mode: '2d', basemap });
      const subtype = o.subtype || (t.layout === 'integrated' ? 'map-focused' : 'media-focused');
      const node = add('tour', { type: 'guided-tour', subtype, narrativePanelPosition: 'start', narrativePanelSize: 'small', accentColor: o.accent || 'themeColor1', map, places });
      return { node, subtype, videos, basemap: baseRes ? { resourceId: baseRes, dropLayer: t.sourceLayer } : null };
    };
    const swipeNode = async (m, size) => {
      // a swipe needs both maps; if either can't be read, the placeholder image takes the swipe's place
      if (opts.standin) {
        const [li, ri] = await Promise.all([webmapInfo(m.left.id), webmapInfo(m.right.id)]);
        if (!li || !ri) return mapNode({ id: !li ? m.left.id : m.right.id, caption: m.caption || '' }, size);
      }
      const left = await mapNode({ id: m.left.id, extent: m.extent, layers: m.left.layers });
      const right = await mapNode({ id: m.right.id, extent: m.extent, layers: m.right.layers });
      // both sides open at exactly the same view, taken from the left map
      for (const k of ['extent', 'center', 'zoom', 'viewpoint']) if (nodes[left].data[k] !== undefined) nodes[right].data[k] = JSON.parse(JSON.stringify(nodes[left].data[k]));
      let caption = '';
      if (m.labels && (m.labels[0] || m.labels[1])) caption = `Left: ${m.labels[0] || '—'} · Right: ${m.labels[1] || '—'}`;
      else if (m.swiped && m.swiped.length) {
        const info = await webmapInfo(m.left.id);
        const ops = (info && info.data.operationalLayers) || [];
        const names = m.swiped.map(lid => ops.find(l => l.id === lid)).filter(Boolean).map(l => l.title || l.id);
        if (info && names.length < m.swiped.length) warnings.push(`A swiped layer from the classic story wasn't found in web map ${m.left.id}. Check which layers each side shows in the builder.`);
        if (names.length) caption = `Left: with ${names.join(', ')} · Right: without`;
      } else {
        const a = await webmapInfo(m.left.id), b = await webmapInfo(m.right.id);
        if (a && b) caption = `Left: ${a.item.title} · Right: ${b.item.title}`;
      }
      const n = add('swipe', { contents: { 0: left, 1: right }, caption: esc(caption), alt: '', viewPlacement: 'extent' });
      if (size) nodes[n].config = { size };
      return n;
    };
    const mediaNode = (m, size) => {
      if (!m) return null;
      if (m.kind === 'swipe') return swipeNode(m, size);
      if (m.kind === 'image') return imageNode(m.src, m.alt, m.caption, size);
      if (m.kind === 'webmap') return mapNode(m, size);
      if (m.kind === 'embed') return embedNode(m.url, m.caption, 'inline');
      return null;
    };
    const ACTION_RE = /<a data-sm-action="([^"]*)">([\s\S]*?)<\/a>/g;
    // actx (optional) turns a classic action link into an inline map action; otherwise the link becomes plain text
    const blockNodes = async (blocks, actx) => {
      const ids = [];
      for (const b of blocks) {
        if (b.kind === 'text') {
          const k = add('text', { type: b.style, text: '' });
          nodes[k].data.text = b.html.replace(ACTION_RE, (m0, aid, inner) => (actx && actx(aid, inner, k)) || inner);
          ids.push(k);
        }
        else if (b.kind === 'image') ids.push(await imageNode(b.src, b.alt, b.caption || '', 'standard'));
        else if (b.kind === 'embed') ids.push(embedNode(b.url, '', b.video ? 'inline' : 'card'));
        else if (b.kind === 'webmap') ids.push(await mapNode(b, 'wide'));
        else if (b.kind === 'separator') ids.push(add('separator'));
      }
      return ids;
    };

    const v = (ctx.data && ctx.data.values) || {};
    const actions = [];    // story-level map actions (sidecar slides)
    const notes = [];
    const tourBases = [];  // tour map resources whose web map gets a copy without its places layer at create time

    // ---- what kind of classic story this is ----
    const mt = ctx.data && ctx.data.mapTour;
    const tour = mt && mt.points && mt.points.length ? mt : null;
    if (mt && !tour) warnings.push(`Map Tour: ${mt.error || 'no places with a location were found'}, so the tour can't be rebuilt.`);
    const slData = ctx.data && ctx.data.shortlist;
    const shortlist = slData && slData.places && slData.places.length ? slData : null;
    if (slData && !shortlist) warnings.push(`Shortlist: ${slData.error || 'no places with a location were found'}, so only the tab names are converted.`);
    const csData = ctx.data && ctx.data.crowdsource;
    const crowd = csData && csData.places && csData.places.length ? csData : null;
    if (csData && !crowd) warnings.push(`Crowdsource: ${csData.error || 'no approved contributions with a location were found'}.`);
    const placesTemplate = tour || shortlist || crowd;
    const cascade = !placesTemplate && Array.isArray(v.sections) && v.sections.some(x => x && x.type) ? v.sections : null;
    const swipe = placesTemplate || cascade ? null : classicSwipe(v);
    const entries = swipe || placesTemplate || cascade ? [] : classicEntries(ctx);
    if (!entries.length && !swipe && !placesTemplate && !cascade && !idsIn(v.webmap).length) warnings.push('No entries were found to convert. The new story will only have a cover.');
    const mainMap = v.webmap && /^[0-9a-f]{32}$/i.test(v.webmap) ? { kind: 'webmap', id: v.webmap } : null;
    const prepared = entries.map(e => {
      let blocks = htmlToBlocks(e.html);
      if (opts.dropDupTitle && blocks[0] && blocks[0].kind === 'text' && e.title && norm(blocks[0].html) === norm(e.title)) blocks = blocks.slice(1);
      return { title: e.title, blocks, media: e.media || mainMap, actions: e.actions || [] };
    });
    if (swipe) {
      // The swipe with its side-panel text, then one section per series bookmark, zoomed to it
      const swipeMedia = extent => ({ kind: 'swipe', left: swipe.left, right: swipe.right, swiped: swipe.swiped, labels: swipe.labels, extent });
      prepared.push({ title: '', outlineTitle: 'Swipe', blocks: htmlToBlocks(swipe.intro), media: swipeMedia(null), actions: [] });
      swipe.bookmarks.forEach((b, i) => prepared.push({
        title: strip(b.name) || `View ${i + 1}`, blocks: htmlToBlocks(b.description || ''), media: swipeMedia(b.extent || null), actions: []
      }));
      if (swipe.spyglass) warnings.push('This classic story used a spyglass. ArcGIS StoryMaps has no spyglass, so it becomes a swipe of the same maps.');
    }

    // ---- Cascade: cover, narrative sequences, titles, immersive sections (one slide per view), credits ----
    let skippedAudio = 0;
    const cBlocks = list => {
      const out = [];
      for (const bl of list || []) {
        if (!bl || !bl.type) continue;
        if (bl.type === 'text') out.push(...htmlToBlocks(bl.text && bl.text.value));
        else if (bl.type === 'image-gallery') ((bl['image-gallery'] || {}).images || []).forEach(im => {
          if (abs(im.url)) out.push({ kind: 'image', src: abs(im.url), alt: im.altText || '', caption: strip(im.caption || '') });
        });
        else { const m = classicMedia(bl); if (m) out.push(m); else if (bl.type === 'audio') skippedAudio++; }
      }
      return out;
    };
    const cascadeParts = [];
    let cascadeCover = null;
    if (cascade) {
      for (const sec of cascade) {
        const fg = (sec && sec.foreground) || {};
        if (sec.type === 'cover') {
          cascadeCover = { title: strip(fg.title || ''), subtitle: strip(fg.subtitle || ''), media: classicMedia(sec.background) };
          if (cascadeCover.media && cascadeCover.media.kind !== 'image') cascadeParts.push({ kind: 'blocks', blocks: [cascadeCover.media] });
        } else if (sec.type === 'title') {
          const t = strip(typeof fg.title === 'string' ? fg.title : (fg.title && fg.title.value) || '');
          if (t) cascadeParts.push({ kind: 'heading', text: t });
        } else if (sec.type === 'sequence') {
          const blocks = cBlocks(fg.blocks);
          if (blocks.length) cascadeParts.push({ kind: 'blocks', blocks });
        } else if (sec.type === 'immersive') {
          const slides = (sec.views || []).map(vw => {
            const f = (vw && vw.foreground) || {};
            const panel = (f.panels || [])[0] || {};
            return { title: strip((f.title && f.title.value) || ''), blocks: cBlocks(panel.blocks), media: classicMedia(vw && vw.background), actions: [] };
          }).filter(sl => sl.media || sl.blocks.length || sl.title);
          if (slides.length) cascadeParts.push({ kind: 'sidecar', slides });
        } else if (sec.type === 'credits') {
          const blocks = [].concat(...(fg.panels || []).map(pn => cBlocks(pn.blocks)));
          if (blocks.length) cascadeParts.push({ kind: 'credits', blocks });
        }
      }
      if (skippedAudio) warnings.push(`${skippedAudio} audio block${skippedAudio > 1 ? 's' : ''} from the Cascade story ${skippedAudio > 1 ? 'were' : 'was'} left out; ArcGIS StoryMaps audio has to be uploaded in the builder.`);
    }

    // ---- embedded map viewers and map apps become live map blocks of the web map they show ----
    let liveMaps = 0;
    const toMap = async m => {
      if (!m || m.kind !== 'embed' || videoInfo(m.url)) return m;
      const r = await resolveEmbedMap(m.url);
      if (!r) return m;
      if (r.unresolved) {
        warnings.push(`Embedded app ${r.app ? '"' + r.app + '"' : r.unresolved} doesn't show a web map that could be read, so it stays a link.`);
        return m;
      }
      liveMaps++;
      return { kind: 'webmap', id: r.id, extent: r.extent, caption: m.caption || '', fromEmbed: true };
    };
    const mapAll = list => Promise.all(list.map(toMap));
    await Promise.all(prepared.map(async p => { p.media = await toMap(p.media); p.blocks = await mapAll(p.blocks); }));
    for (const part of cascadeParts) {
      if (part.blocks) part.blocks = await mapAll(part.blocks);
      if (part.slides) for (const sl of part.slides) { sl.media = await toMap(sl.media); sl.blocks = await mapAll(sl.blocks); }
    }
    // start every image-size and map lookup at once instead of one by one
    const warm = m => { if (!m) return; if (m.kind === 'image') imageSize(m.src); if (m.kind === 'webmap') webmapInfo(m.id); if (m.kind === 'swipe') { webmapInfo(m.left.id); webmapInfo(m.right.id); } };
    prepared.forEach(p => { warm(p.media); p.blocks.forEach(warm); (p.actions || []).forEach(a => a && a.media && warm(classicMedia(a.media))); });
    cascadeParts.forEach(part => { (part.blocks || []).forEach(warm); (part.slides || []).forEach(sl => { warm(sl.media); sl.blocks.forEach(warm); }); });
    const swipeReadable = swipe && (await webmapInfo(swipe.left.id)) && (await webmapInfo(swipe.right.id));
    if (swipe && swipeReadable) notes.push(`Classic swipe became a StoryMaps swipe of the live ${swipe.swiped.length ? 'map, with its swiped layers on the left only' : 'maps'}${swipe.bookmarks.length ? `, plus ${swipe.bookmarks.length} bookmarked view${swipe.bookmarks.length > 1 ? 's' : ''}` : ''}.`);
    if (liveMaps) notes.push(`${liveMaps} embedded map viewer${liveMaps > 1 ? 's or apps' : ' or app'} became live map${liveMaps > 1 ? 's' : ''}.`);

    // ---- the story's own main map, when no entry already shows it (Story Map Basic: the whole story) ----
    if (opts.mainMap && !placesTemplate && !cascade) {
      const used = new Set();
      prepared.forEach(p => {
        if (p.media && p.media.kind === 'webmap') used.add(String(p.media.id).toLowerCase());
        if (p.media && p.media.kind === 'swipe') { used.add(p.media.left.id); used.add(p.media.right.id); }
        p.blocks.forEach(b => { if (b.kind === 'webmap') used.add(String(b.id).toLowerCase()); });
      });
      const extra = idsIn(v.webmap).concat(idsIn(v.webmaps)).filter((x, i, a) => !used.has(x) && a.indexOf(x) === i);
      const legend = v.legend === true || v.legend === 'true';
      const mains = (await Promise.all(extra.map(async mid => {
        const info = await webmapInfo(mid);
        if (!info && opts.standin) return { title: 'Map', blocks: [], media: { kind: 'webmap', id: mid }, isMain: true, placeholder: true, actions: [] };
        if (!info || !/^Web (Map|Scene)$/.test(info.item.type || '')) {
          warnings.push(`The story's main map (${mid}) couldn't be read. It may have been deleted or made private, so it's left out.`);
          return null;
        }
        return { title: info.item.title || 'Map', blocks: info.item.description ? htmlToBlocks(info.item.description) : [],
          media: { kind: 'webmap', id: mid, showLegend: legend }, isMain: true, actions: [] };
      }))).filter(Boolean);
      if (mains.length) {
        prepared.unshift(...mains);
        const live = mains.filter(x => !x.placeholder).length; // unreadable ones show the placeholder image
        if (live) notes.push(`The story's main map${live > 1 ? 's open' : ' opens'} the story as a live map${legend ? ', with its legend' : ''}.`);
      }
    }

    const outline = [];
    const describe = (p) => {
      const counts = {};
      (p.blocks || []).forEach(b => { const k = b.kind === 'text' ? (/list/.test(b.style) ? 'list' : /^h/.test(b.style) ? 'heading' : b.style === 'quote' ? 'quote' : 'paragraph') : b.video ? 'video' : b.kind === 'webmap' ? 'live map' : b.kind; counts[k] = (counts[k] || 0) + 1; });
      const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`);
      if (p.media) parts.unshift(p.isMain ? 'main map' : p.media.kind === 'swipe' ? (p.media.swiped && p.media.swiped.length ? 'layer swipe' : 'swipe of 2 maps') + (p.media.extent ? ', zoomed' : '') : p.media.kind === 'webmap' ? (p.media.fromEmbed ? 'live map (was embedded app)' : 'map') : p.media.video ? 'video' : p.media.kind);
      const acts = (p.actions || []).filter(a => a && a.type !== 'navigate').length;
      if (acts) parts.push(`${acts} map link${acts > 1 ? 's' : ''}`);
      return parts.join(' · ') || 'empty';
    };

    // ---- classic text links (Map Journal / Map Series content actions) ----
    // Sidecar: "zoom" links and links to the same map become inline map actions on the slide's map;
    // links that showed other media become action buttons that swap the slide's media.
    // Scrolling layout: no actions exist there, so the linked maps and media are added after the section.
    let inlineActions = 0, buttonActions = 0, plainLinks = 0, scrollActionMedia = 0;
    const pickView = vw => { const o = {}; for (const k of ['extent', 'viewpoint', 'mapLayers']) if (vw[k] !== undefined) o[k] = JSON.parse(JSON.stringify(vw[k])); return o; };
    const zoomTo = z => {
      if (!z || !z.center || !Number.isFinite(+z.level)) return null;
      let x = +z.center.x, y = +z.center.y;
      const sr = z.center.spatialReference || { wkid: 102100 };
      if ((sr.latestWkid || sr.wkid) === 4326) [x, y] = toMercator(x, y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const scale = 591657527.591555 / Math.pow(2, +z.level), hw = scale * 0.12, hh = hw * 0.6;
      return { extent: { xmin: x - hw, ymin: y - hh, xmax: x + hw, ymax: y + hh, spatialReference: { wkid: 102100, latestWkid: 3857 } }, scale };
    };
    const linkTexts = blocks => {
      const m = new Map();
      for (const b of blocks) if (b.kind === 'text') for (const mm of b.html.matchAll(ACTION_RE)) if (!m.has(mm[1])) m.set(mm[1], strip(mm[2]));
      return m;
    };
    const planActions = async (acts, slideMap) => {
      const plans = new Map();
      for (const a of acts || []) {
        if (!a || a.id === undefined) continue;
        const aid = String(a.id);
        if (a.type === 'zoom' && slideMap) {
          const z = zoomTo(a.zoom);
          if (z) { const vw = pickView(computeView(await webmapInfo(slideMap.id), { extent: z.extent, scale: z.scale, layers: slideMap.layers })); if (vw.viewpoint) { plans.set(aid, { kind: 'inline', mapData: vw }); continue; } }
        }
        if (a.type === 'media' && a.media) {
          const am = await toMap(classicMedia(a.media));
          if (am && am.kind === 'webmap' && slideMap && String(am.id).toLowerCase() === String(slideMap.id).toLowerCase()) {
            const vw = pickView(computeView(await webmapInfo(am.id), am));
            if (vw.viewpoint || vw.mapLayers) { plans.set(aid, { kind: 'inline', mapData: vw }); continue; }
          }
          if (am) { plans.set(aid, { kind: 'button', media: am }); continue; }
        }
        plans.set(aid, { kind: 'none' });
      }
      return plans;
    };
    const buildSidecar = async (items, subtype) => {
      const slides = [];
      let i = 0;
      for (const p of items) {
        i++;
        const textMaps = p.blocks.filter(b => b.kind === 'webmap');
        const media = p.media || textMaps.shift();
        const m = await mediaNode(media); // made first, so text actions can target it
        const slideMap = media && media.kind === 'webmap' ? media : null;
        const plans = await planActions(p.actions, slideMap);
        const buttons = [], seen = new Set();
        const actx = (aid, inner, origin) => {
          const pl = plans.get(String(aid));
          if (pl && pl.kind === 'inline' && m && nodes[m].type === 'webmap') {
            const acId = 'a-' + id('n').slice(2);
            actions.push({ origin, trigger: 'InlineAction_Apply', target: m, event: 'WebMap_UpdateData', data: { actionId: acId, mapData: pl.mapData } });
            inlineActions++;
            return `<span data-action-type="text-style-action" id="${acId}">${inner}</span>`;
          }
          if (pl && pl.kind === 'button' && !seen.has(aid)) { seen.add(aid); buttons.push({ text: strip(inner).slice(0, 80) || 'Show', media: pl.media }); }
          else if (!pl || pl.kind === 'none') plainLinks++;
          return null;
        };
        const panelKids = [];
        if (p.title) panelKids.push(add('text', { type: 'h3', text: esc(p.title) }));
        panelKids.push(...await blockNodes(p.blocks.filter(b => b.kind !== 'webmap'), actx));
        const pending = [];
        for (const bt of buttons) {
          const mediaId = await mediaNode(bt.media);
          if (!mediaId) continue;
          const btn = add('action-button', { text: bt.text }, { config: { size: 'wide' }, dependents: { actionMedia: mediaId } });
          panelKids.push(btn);
          pending.push({ btn, mediaId });
        }
        const panel = add('immersive-narrative-panel', { position: 'start', size: 'medium', panelStyle: 'themed' }, { children: panelKids });
        const slide = add('immersive-slide', { transition: 'fade' }, { children: m ? [panel, m] : [panel] });
        for (const pb of pending) { actions.push({ origin: pb.btn, trigger: 'ActionButton_Apply', target: slide, event: 'ImmersiveSlide_ReplaceMedia', data: { media: pb.mediaId } }); buttonActions++; }
        slides.push(slide);
        for (const tm of textMaps) {
          const tmInfo = await webmapInfo(tm.id);
          const extraPanel = add('immersive-narrative-panel', { position: 'start', size: 'medium', panelStyle: 'themed' },
            { children: [add('text', { type: 'h3', text: esc((tmInfo && tmInfo.item.title) || p.title || 'Map') })] });
          slides.push(add('immersive-slide', { transition: 'fade' }, { children: [extraPanel, await mapNode(tm)] }));
        }
        if (!m) warnings.push(`Slide ${i} ("${p.title || 'untitled'}") has no image or map; add one in the builder.`);
      }
      if (!slides.length) return null;
      return { node: add('immersive', { type: 'sidecar', subtype, narrativePanelPosition: 'start', narrativePanelSize: 'medium' }, { children: slides }), count: slides.length };
    };
    // scrolling layout: the maps and media behind classic text links, shown after the section
    const actionMediaForScroll = async p => {
      const out = [], texts = linkTexts(p.blocks), done = new Set();
      const entryMap = p.media && p.media.kind === 'webmap' ? p.media : null;
      for (const a of p.actions || []) {
        if (!a || a.id === undefined || done.has(String(a.id))) continue;
        done.add(String(a.id));
        const label = texts.get(String(a.id)) || '';
        if (a.type === 'zoom' && entryMap) {
          const z = zoomTo(a.zoom);
          if (z) out.push({ kind: 'webmap', id: entryMap.id, extent: z.extent, scale: z.scale, layers: entryMap.layers, caption: label });
        } else if (a.type === 'media' && a.media) {
          const am = await toMap(classicMedia(a.media));
          if (am && !(am.kind === 'webmap' && entryMap && am.id === entryMap.id && !am.extent && !am.layers)) out.push(Object.assign({}, am, { caption: label || am.caption || '' }));
        }
      }
      return out;
    };

    // ---- cover ----
    const placeList = tour ? tour.points : shortlist ? shortlist.places : crowd ? crowd.places : null;
    const coverSrc = (() => {
      if (crowd && abs(crowd.intro.background)) return abs(crowd.intro.background);
      if (cascadeCover && cascadeCover.media && cascadeCover.media.kind === 'image') return cascadeCover.media.src;
      if (placeList) { const p = placeList.find(x => !x.isVideo && abs(x.pic || x.thumb)); return p ? abs(p.pic || p.thumb) : ''; }
      for (const p of prepared) {
        if (p.media && p.media.kind === 'image') return p.media.src;
        const b = p.blocks.find(x => x.kind === 'image'); if (b) return b.src;
      }
      for (const part of cascadeParts) {
        const b = (part.blocks || []).find(x => x.kind === 'image') || ((part.slides || []).map(sl => sl.media).find(x => x && x.kind === 'image'));
        if (b) return b.src;
      }
      return '';
    })();
    const title = opts.title || classicTitle(ctx) || ctx.item.title || 'Untitled story';
    const summary = strip(v.subtitle) || (cascadeCover && cascadeCover.subtitle) || (crowd && strip(crowd.intro.subtitle)) || ctx.item.snippet || '';
    const cover = add('storycover', {
      type: coverSrc ? 'full' : 'minimal', title, summary,
      byline: opts.byline || '', titlePanelPosition: 'start'
    });
    if (coverSrc) nodes[cover].children = [await imageNode(coverSrc, '', '')];
    outline.push({ k: 'Cover', t: title, c: coverSrc ? 'full · image' : 'minimal' });
    const nav = add('navigation', { links: [] }, { config: { isHidden: true } });
    const body = [];
    // The cover summary is plain text, so a subtitle with links also opens the story as a paragraph
    if (v.subtitle && /<a\s/i.test(v.subtitle)) {
      body.push(...await blockNodes(htmlToBlocks(v.subtitle)));
      outline.push({ k: 'Intro', t: strip(v.subtitle).slice(0, 80) + (strip(v.subtitle).length > 80 ? '…' : ''), c: 'paragraph with links' });
    }
    const basemapNote = what => `The ${what} map shows the classic web map. When you create the story, a copy of it without the places layer is made in your account, so the places aren't shown twice. Its feature and image services are referenced, not copied.`;

    // ---- Map Tour ----
    if (tour) {
      let pts = tour.points;
      if (tour.firstRecordAsIntro && pts.length > 1) {
        // the classic tour opened with its first record as an introduction, not a stop
        const intro = pts[0]; pts = pts.slice(1);
        if (intro.name) body.push(add('text', { type: 'h2', text: esc(intro.name) }));
        if (!intro.isVideo && abs(intro.pic || intro.thumb)) body.push(await imageNode(abs(intro.pic || intro.thumb), intro.name || '', '', 'wide'));
        else if (intro.isVideo && abs(intro.pic)) body.push(embedNode(abs(intro.pic), '', 'inline'));
        body.push(...await blockNodes(htmlToBlocks(intro.description)));
        outline.push({ k: 'Intro', t: intro.name || 'Introduction', c: 'first tour record, shown before the tour' });
      }
      const r = await tourNode(tour, pts);
      body.push(r.node);
      if (r.basemap) tourBases.push(r.basemap);
      outline.push({ k: 'Tour', t: `${pts.length} place${pts.length > 1 ? 's' : ''}`, c: `guided tour, ${r.subtype}${r.videos ? ` · ${r.videos} video${r.videos > 1 ? 's' : ''}` : ''}` });
      notes.push(`Classic Map Tour became a guided tour with ${pts.length} numbered place${pts.length > 1 ? 's' : ''}${tour.fromAttachments ? `; ${tour.fromAttachments} photo${tour.fromAttachments > 1 ? 's come' : ' comes'} from feature attachments` : ''}.`);
      if (r.basemap) notes.push(basemapNote("tour's"));
    }

    // ---- Shortlist: one guided tour per tab, in the tab's colour ----
    if (shortlist) {
      const groups = [];
      shortlist.tabs.forEach((t, i) => { const pts = shortlist.places.filter(p => p.tab === i); if (pts.length) groups.push({ title: t.title, color: t.color, pts }); });
      const other = shortlist.places.filter(p => !(p.tab >= 0 && p.tab < shortlist.tabs.length));
      if (other.length) groups.push({ title: 'Other places', color: '', pts: other });
      let based = false;
      for (const g of groups) {
        body.push(add('text', { type: 'h2', text: esc(g.title) }));
        const r = await tourNode({ webmap: shortlist.webmap, sourceLayer: shortlist.sourceLayer }, g.pts, { subtype: 'map-focused', accent: g.color || undefined, what: 'Shortlist place' });
        body.push(r.node);
        if (r.basemap) { tourBases.push(r.basemap); based = true; }
        outline.push({ k: 'Tab', t: `${g.title}`, c: `guided tour, ${g.pts.length} place${g.pts.length > 1 ? 's' : ''}` });
      }
      notes.push(`Classic Shortlist became ${groups.length} guided tour${groups.length > 1 ? 's' : ''}, one per tab in the tab's colour, with ${shortlist.places.length} places.`);
      if (based) notes.push(basemapNote("tours'"));
    }

    // ---- Crowdsource: the approved contributions as a guided tour ----
    if (crowd) {
      const r = await tourNode({ webmap: crowd.webmap, sourceLayer: crowd.sourceLayer }, crowd.places, { subtype: 'media-focused', what: 'contribution' });
      body.push(r.node);
      if (r.basemap) tourBases.push(r.basemap);
      const nc = crowd.places.length, ncs = nc === 1 ? 'contribution' : 'contributions';
      outline.push({ k: 'Tour', t: `${nc} approved ${ncs}`, c: 'guided tour, media-focused' });
      notes.push(`Classic Crowdsource became a guided tour of its ${nc} approved, visible ${ncs}. Contributor names are left out, and rejected or hidden contributions are never included.`);
      if (crowd.capped) warnings.push(`Only the first ${crowd.places.length} of ${crowd.total} approved contributions are included.`);
      warnings.push('ArcGIS StoryMaps can\'t collect new contributions. Use a form app such as ArcGIS Survey123 if the story should keep growing.');
      if (r.basemap) notes.push(basemapNote("tour's"));
    }

    // ---- Cascade ----
    if (cascade) {
      let k = 0;
      for (const part of cascadeParts) {
        if (part.kind === 'heading') { body.push(add('text', { type: 'h2', text: esc(part.text) })); outline.push({ k: 'Title', t: part.text, c: 'heading' }); }
        else if (part.kind === 'blocks') {
          body.push(...await blockNodes(part.blocks));
          const firstText = part.blocks.find(x => x.kind === 'text');
          outline.push({ k: String(++k).padStart(2, '0'), t: firstText ? strip(firstText.html).replace(/\s+([.,;:!?])/g, '$1').slice(0, 60) : 'Narrative', c: describe({ blocks: part.blocks }) });
        } else if (part.kind === 'sidecar') {
          const sc = await buildSidecar(part.slides, 'floating-panel');
          if (sc) {
            body.push(sc.node);
            const maps = part.slides.filter(sl => sl.media && sl.media.kind === 'webmap').length;
            outline.push({ k: String(++k).padStart(2, '0'), t: part.slides.find(sl => sl.title)?.title || 'Immersive section', c: `sidecar, ${sc.count} slide${sc.count > 1 ? 's' : ''}${maps ? ` · ${maps} map${maps > 1 ? 's' : ''}` : ''}` });
          }
        } else if (part.kind === 'credits') {
          body.push(add('text', { type: 'h3', text: 'Credits' }), ...await blockNodes(part.blocks));
          outline.push({ k: 'Credits', t: 'Credits', c: describe({ blocks: part.blocks }) });
        }
      }
      const views = cascadeParts.filter(x => x.kind === 'sidecar').reduce((n, x) => n + x.slides.length, 0);
      const nNarr = cascadeParts.filter(x => x.kind === 'blocks').length;
      notes.push(`Classic Cascade converted section by section: ${nNarr} narrative section${nNarr === 1 ? '' : 's'}, and ${views} immersive view${views === 1 ? '' : 's'} as floating-panel sidecar slides.`);
    }

    // ---- entries: Map Series, Map Journal, Swipe, Basic, self-hosted ----
    if (opts.layout === 'sidecar' && prepared.length) {
      const sc = await buildSidecar(prepared, 'docked-panel');
      if (sc) body.push(sc.node);
      prepared.forEach((p, i) => outline.push({ k: String(i + 1).padStart(2, '0'), t: p.title || p.outlineTitle || '(untitled)', c: describe(p) }));
    } else {
      let i = 0;
      for (const p of prepared) {
        i++;
        if (i > 1) body.push(add('separator'));
        if (p.title) body.push(add('text', { type: 'h2', text: esc(p.title) }));
        const m = await mediaNode(p.media, 'wide');
        if (m) body.push(m);
        body.push(...await blockNodes(p.blocks));
        for (const x of await actionMediaForScroll(p)) { const n = await mediaNode(x, 'wide'); if (n) { body.push(n); scrollActionMedia++; } }
        outline.push({ k: String(i).padStart(2, '0'), t: p.title || p.outlineTitle || '(untitled)', c: describe(p) });
      }
    }
    for (const [mid, n] of standins) warnings.push(`Web map ${mid} can't be read: it has been deleted or is no longer shared publicly, and the classic story saved only its ID and views, not its data. So its ${n} map block${n > 1 ? 's show' : ' shows'} the placeholder image instead. If the map's owner shares it again, convert again with "Replace maps that can't be read" unticked to link it live.`);
    if (expressCount) notes.push(`${expressCount} classic map${expressCount > 1 ? 's' : ''} made only of sketched notes became ${expressCount > 1 ? 'express maps' : 'an express map'} with ${expressNotes} editable drawing${expressNotes > 1 ? 's' : ''} and their popups. ${expressCount > 1 ? 'Their basemaps are copies' : 'Its basemap is a copy'} of the classic web map without the note layers, made when you create the story.`);
    if (inlineActions || buttonActions) notes.push(`${inlineActions + buttonActions} classic text link${inlineActions + buttonActions > 1 ? 's' : ''} became map actions: ${inlineActions} on the slide's map, ${buttonActions} as ${buttonActions === 1 ? 'a button that shows' : 'buttons that show'} other media.`);
    if (scrollActionMedia) notes.push(`${scrollActionMedia} map${scrollActionMedia > 1 ? 's and media' : ' or media item'} that classic text links showed ${scrollActionMedia > 1 ? 'were' : 'was'} added after ${scrollActionMedia > 1 ? 'their sections' : 'its section'}. Choose the sidecar layout to keep them as map actions.`);
    if (plainLinks) notes.push(`${plainLinks} classic text link${plainLinks > 1 ? 's' : ''} that jumped to another section ${plainLinks > 1 ? 'are' : 'is'} kept as plain text.`);

    if (opts.backlink) {
      const src = ctx.item.url || (ctx.src && ctx.src.pageUrl);
      const label = esc(ctx.item.title || 'the classic story');
      body.push(add('text', { type: 'paragraph', text: src
        ? `<em>Converted from the classic Story Map <a href="${escAttr(src)}" rel="noopener noreferrer" target="_blank">${label}</a>.</em>`
        : `<em>Converted from the classic Story Map ${label}.</em>` }));
    }

    // Old web maps: report them now; updated copies are made when the story is created
    const usedMapIds = [...new Set(Object.values(resources).filter(r => r.type === 'webmap').map(r => r.data.itemId))];
    const old = [];
    for (const mid of usedMapIds) { const info = await webmapInfo(mid); const why = info && info.item.type === 'Web Map' ? oldMapReasons(info.data) : []; if (why.length) old.push({ title: info.item.title || mid, why }); }
    if (old.length) {
      const list = old.map(o => `"${o.title}" (${o.why.join(', ')})`).join('; ');
      if (opts.modernize) notes.push(`${old.length} web map${old.length > 1 ? 's use' : ' uses'} the old web map format: ${list}. Updated copies will be made in your account when you create the story.`);
      else warnings.push(`${old.length} web map${old.length > 1 ? 's use' : ' uses'} the old web map format and may not load in ArcGIS StoryMaps: ${list}.`);
    }

    const credits = add('credits');
    const theme = id('r');
    resources[theme] = { type: 'story-theme', data: { themeId: 'summit', themeBaseVariableOverrides: {} } };
    const root = id('n');
    nodes[root] = {
      type: 'story',
      data: { storyTheme: theme },
      config: { coverDate: 'first-published', storyLocale: (session && session.user.culture) || 'en-US' },
      children: [cover, nav, ...body, credits]
    };
    const story = { root, nodes, resources };
    if (actions.length) story.actions = actions;
    return { story, outline, warnings: Array.from(new Set(warnings)), notes, coverSrc, title, tourBases, expressFiles, expressBases };
  }

  // ---------- step 2 UI ----------
  function convOpts() {
    return {
      layout: document.querySelector('input[name="layout"]:checked').value,
      dropDupTitle: $('optDup').checked,
      mainMap: $('optMainMap').checked,
      modernize: $('optModernize').checked,
      express: $('optExpress').checked,
      standin: $('optStandin').checked,
      backlink: $('optBacklink').checked,
      title: $('cTitle').value.trim(),
      byline: $('cByline').value.trim()
    };
  }
  async function rebuild() {
    if (!classic) return null;
    const seq = ++buildSeq;
    $('convLog').replaceChildren();
    const li = logTo('convLog', 'Converting…');
    const result = await buildStory(classic, convOpts());
    if (seq !== buildSeq) return built; // a newer build started
    built = result;
    li.remove();
    const ol = $('outline'); ol.replaceChildren();
    result.outline.forEach(o => {
      const row = document.createElement('li');
      [['k', o.k], ['t', o.t], ['c', o.c]].forEach(([c, t]) => { const s = document.createElement('span'); s.className = c; s.textContent = t; row.appendChild(s); });
      ol.appendChild(row);
    });
    const n = Object.keys(result.story.nodes).length, r = Object.keys(result.story.resources).length;
    const nodeList = Object.values(result.story.nodes);
    const parts = convOpts().layout === 'sidecar'
      ? ((n1) => `${n1} slide${n1 === 1 ? '' : 's'}`)(nodeList.filter(x => x.type === 'immersive-slide').length)
      : ((n1) => `${n1} section${n1 === 1 ? '' : 's'}`)(result.outline.filter(o => /^\d/.test(o.k)).length);
    const maps = nodeList.filter(x => x.type === 'webmap').length;
    const xmaps = nodeList.filter(x => x.type === 'expressmap').length;
    const swipes = nodeList.filter(x => x.type === 'swipe').length;
    const tours = nodeList.filter(x => x.type === 'tour');
    const tourPlaces = tours.reduce((n, t) => n + ((t.data && t.data.places) || []).length, 0);
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    logTo('convLog', `${tourPlaces ? `${tours.length > 1 ? pl(tours.length, 'guided tour') + ' with' : 'Guided tour with'} ${pl(tourPlaces, 'place')}, ` : `${parts}, `}${maps || !xmaps ? `${maps} live map${maps === 1 ? '' : 's'}` : ''}${maps && xmaps ? ', ' : ''}${xmaps ? `${xmaps} express map${xmaps === 1 ? '' : 's'}` : ''}${swipes ? ` (${swipes} swipe${swipes > 1 ? 's' : ''})` : ''}, ${n} story blocks in all.`, 'ok');
    (result.notes || []).forEach(t => logTo('convLog', t, 'ok'));
    result.warnings.forEach(w => logTo('convLog', w, 'warn'));
    return result;
  }
  let rebuildTimer;
  const scheduleRebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 150); };
  document.querySelectorAll('input[name="layout"]').forEach(r => r.addEventListener('change', scheduleRebuild));
  ['optDup', 'optBacklink', 'optMainMap', 'optModernize', 'optExpress', 'optStandin'].forEach(id => $(id).addEventListener('change', scheduleRebuild));
  $('cTitle').addEventListener('input', scheduleRebuild);
  let bylineEdited = false;
  $('cByline').addEventListener('input', () => { bylineEdited = true; scheduleRebuild(); });

  window.addEventListener('classic-read', e => {
    classic = e.detail;
    built = null;
    mapCache.clear();
    $('cTitle').value = classicTitle(classic) || classic.item.title || '';
    bylineEdited = false;
    $('cByline').value = '';
    const forStory = classic;
    classicAuthor(classic).then(name => {
      if (classic !== forStory || bylineEdited || !name) return;
      $('cByline').value = name;
      scheduleRebuild();
    });
    $('result').hidden = true;
    $('pubLog').replaceChildren();
    $('convertPanel').hidden = false;
    $('publishPanel').hidden = false;
    setStep(session ? 3 : 2);
    rebuild();
  });

  $('dlJson').addEventListener('click', async () => {
    const b = built || await rebuild();
    if (!b) return;
    const out = Object.keys(b.expressFiles || {}).length ? Object.assign({}, b.story, { expressMapResources: b.expressFiles }) : b.story;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `storymap_${classic.item.id.slice(0, 8)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- ArcGIS REST ----------
  async function post(path, params = {}, useToken = true) {
    const fd = new FormData();
    fd.append('f', 'json');
    if (useToken && session) fd.append('token', session.token);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (v && v.blob) fd.append(k, v.blob, v.name);
      else fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const r = await fetch(path.startsWith('http') ? path : session.rest + path, { method: 'POST', body: fd, credentials: 'omit' });
    let j;
    try { j = await r.json(); } catch (_) { throw new Error(`ArcGIS returned HTTP ${r.status} without a readable reply.`); }
    if (j.error) {
      const d = (j.error.details || []).filter(Boolean).join('; ');
      throw new Error((j.error.message || 'ArcGIS error') + (d && d !== j.error.message ? ` (${d})` : ''));
    }
    if (j.success === false) throw new Error('ArcGIS reported the request failed.');
    return j;
  }

  async function signIn(e) {
    e.preventDefault();
    $('pubLog').replaceChildren();
    const btn = $('sGo'); btn.disabled = true;
    try {
      const portalUrl = 'https://www.arcgis.com'; // ArcGIS Online
      const rest = portalUrl + '/sharing/rest';
      const isHttpPage = /^https?:$/.test(location.protocol);
      const tok = await post(rest + '/generateToken', {
        username: $('sUser').value.trim(),
        password: $('sPass').value,
        client: isHttpPage ? 'referer' : 'requestip',
        referer: isHttpPage ? location.origin : undefined,
        expiration: 240
      }, false);
      $('sPass').value = '';
      const self = await getJson(`${rest}/portals/self?f=json&token=${encodeURIComponent(tok.token)}`);
      if (!self.user) throw new Error('Signed in, but ArcGIS did not return your user details.');
      const isOnline = self.isPortal === false;
      const orgHome = isOnline && self.urlKey && self.customBaseUrl ? `https://${self.urlKey}.${self.customBaseUrl}` : portalUrl;
      session = { rest, portalUrl, token: tok.token, expires: tok.expires, user: self.user, isOnline, orgHome, orgName: self.name || '' };
      const priv = (self.user.privileges || []);
      const canCreate = !priv.length || priv.includes('portal:user:createItem');
      $('whoText').textContent = `Signed in as ${self.user.fullName || self.user.username} (${self.user.username})${session.orgName ? ' · ' + session.orgName : ''}`;
      $('who').hidden = false;
      $('signinForm').hidden = true;
      $('createForm').hidden = false;
      if (!canCreate) logTo('pubLog', 'This account does not have permission to create content, so creating the story will fail. Ask your ArcGIS administrator for a Creator role.', 'warn');
      setStep(3);
      if (classic) rebuild(); // fills in byline and locale
    } catch (err) {
      $('sPass').value = '';
      const msg = /Failed to fetch|NetworkError|Load failed/i.test(err.message) ? 'Could not reach ArcGIS Online. Check your connection.' : err.message;
      logTo('pubLog', 'Sign-in failed: ' + msg, 'bad');
    } finally { btn.disabled = false; }
  }
  $('signinForm').addEventListener('submit', signIn);
  $('signOut').addEventListener('click', () => {
    session = null;
    $('who').hidden = true; $('signinForm').hidden = false; $('createForm').hidden = true;
    $('pubLog').replaceChildren();
    setStep(classic ? 2 : 1);
  });

  async function smVersion() {
    if (!session.isOnline) return FALLBACK_SM_VERSION;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch('https://storymaps.arcgis.com/version?f=json', { signal: ctl.signal, credentials: 'omit' });
      clearTimeout(t);
      const j = await r.json();
      return j.version || FALLBACK_SM_VERSION;
    } catch (_) { return FALLBACK_SM_VERSION; }
  }

  async function copyImages(story, itemPath) {
    let copied = 0, linked = 0, i = 0;
    for (const [rid, res] of Object.entries(story.resources)) {
      if (res.type !== 'image' || res.data.provider !== 'uri') continue;
      i++;
      try {
        const r = await fetch(res.data.src, { credentials: 'omit' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        if (!/^image\//.test(blob.type)) throw new Error('not an image');
        const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/\+.*/, '');
        const name = `classic-image-${String(i).padStart(2, '0')}.${ext}`;
        await post(`${itemPath}/addResources`, { file: { blob, name }, fileName: name });
        story.resources[rid] = { type: 'image', data: { resourceId: name, provider: 'item-resource', width: res.data.width, height: res.data.height } };
        copied++;
      } catch (_) { linked++; }
    }
    return { copied, linked };
  }

  async function createStory(e) {
    e.preventDefault();
    if (!session || !classic) return;
    const btn = $('cGo'); btn.disabled = true;
    $('pubLog').replaceChildren(); $('result').hidden = true;
    const log = (m, k) => logTo('pubLog', m, k);
    let itemId = null;
    const made = []; // updated web maps created for this story
    try {
      if (session.expires && Date.now() > session.expires - 60000) throw new Error('Your sign-in has expired. Sign out and sign in again.');
      const publish = document.querySelector('input[name="mode"]:checked').value === 'publish';
      const access = $('cAccess').value;
      const b = await rebuild();
      const story = JSON.parse(JSON.stringify(b.story));
      const user = session.user.username;
      const userPath = `/content/users/${encodeURIComponent(user)}`;
      const version = await smVersion();
      const draft = `draft_${Date.now()}.json`;
      const base = ['arcgis-storymaps', 'StoryMap', 'Web Application', `smversiondraft:${version}`, `smdraftresourceid:${draft}`];
      const draftKeywords = [...base, 'smstatusdraft', `smeditorapp:${APP_KEYWORD}`];
      const it = classic.item;
      const shareParams = { everyone: access === 'public', org: access !== 'private', groups: '' };

      // Copies of web maps, made in this account: updated versions of old web maps, and the tour's
      // basemap without its point layer. The story is pointed at the copies; originals are never changed.
      const swap = new Map();
      // kind: 'update' (old map, same layers), 'tour' (without the places layer) or 'express' (without the note layers)
      const copyMap = async (info, kind, drop, update, why) => {
        const mid = info.item.id;
        const key = `${mid}|${kind}:${[].concat(drop).join(',')}|${update}`;
        if (swap.has(key)) return swap.get(key);
        let data, issues = [];
        if (update) ({ data, issues } = await modernizeWebmap(info));
        else data = JSON.parse(JSON.stringify(info.data));
        const dropSet = new Set([].concat(drop).filter(x => x !== '' && x !== undefined).map(String));
        if (dropSet.size) data.operationalLayers = (data.operationalLayers || []).filter(l => !dropSet.has(String(l.id)));
        const om = Object.assign({}, info.item, { title: info.item.title || `Web map ${mid}` });
        const title = kind === 'tour' ? `${om.title} (tour map)` : kind === 'express' ? `${om.title} (express map basemap)` : om.title;
        const ext = Array.isArray(om.extent) && om.extent.length === 2 ? om.extent.flat().join(',') : undefined;
        const origin = `<a href="https://www.arcgis.com/home/item.html?id=${om.id}">${esc(om.title)}</a>`;
        const upd = update ? ' It is also updated to the current web map format.' : '';
        const res = await post(`${userPath}/addItem`, {
          type: 'Web Map',
          title,
          typeKeywords: ['ArcGIS Online', 'Explorer Web Map', 'Map', 'Online Map', 'Web Map'].join(','),
          tags: Array.from(new Set([...(om.tags || []), 'converted from classic'])).join(','),
          snippet: om.snippet || '',
          description: (om.description || '') + (kind === 'tour'
            ? `<p>Copy of the web map ${origin} without its tour points, made as the map of a guided tour converted from a classic Story Map.${upd} It uses the same data layers.</p>`
            : kind === 'express'
              ? `<p>Copy of the web map ${origin} without its sketched notes, made as the basemap of an express map converted from a classic Story Map; the notes became the express map's drawings.${upd}</p>`
              : `<p>Updated copy of the web map ${origin}, made for a story converted from a classic Story Map. It uses the same data layers.</p>`),
          accessInformation: om.accessInformation || '',
          licenseInfo: om.licenseInfo || '',
          extent: ext,
          thumbnailurl: om.thumbnail ? `${classic.base}/content/items/${om.id}/info/${om.thumbnail}` : undefined,
          text: JSON.stringify(data)
        });
        made.push({ id: res.id, title });
        swap.set(key, res.id);
        const fromOld = update ? `, updated from the old format (${why.join(', ')})` : '';
        if (kind === 'tour') log(`Made the tour's map: a copy of "${om.title}" without the tour's point layer${fromOld}`, 'ok');
        else if (kind === 'express') log(`Made the express map's basemap: a copy of "${om.title}" without its note layers${fromOld}`, 'ok');
        else log(`Made an updated copy of the old web map "${om.title}" (${why.join(', ')})`, 'ok');
        issues.forEach(m => log(`"${om.title}": ${m}`, 'warn'));
        return res.id;
      };
      for (const [rid, r] of Object.entries(story.resources)) {
        if (r.type !== 'webmap') continue;
        const mid = r.data.itemId;
        const tb = (b.tourBases || []).find(t => t.resourceId === rid);
        const info = await webmapInfo(mid);
        if (!info || info.item.type !== 'Web Map') continue;
        const why = oldMapReasons(info.data);
        const update = why.length > 0 && $('optModernize').checked;
        if (!tb && !update) continue;
        r.data.itemId = await copyMap(info, tb ? 'tour' : 'update', tb ? (tb.dropLayer || '') : '', update, why);
      }
      // Express maps: their basemap web map, without the notes that became drawings
      const expressFiles = JSON.parse(JSON.stringify(b.expressFiles || {}));
      for (const eb of b.expressBases || []) {
        const info = await webmapInfo(eb.webmap);
        if (!info || !expressFiles[eb.file]) continue;
        const why = oldMapReasons(info.data);
        const baseId = await copyMap(info, 'express', eb.dropLayers, why.length > 0 && $('optModernize').checked, why);
        expressFiles[eb.file].basemap.value = baseId;
        if (story.nodes[eb.node] && story.nodes[eb.node].data) story.nodes[eb.node].data.basemap = baseId;
      }
      const madeIds = new Set(made.map(m => m.id));
      const stillOriginal = [...new Set(Object.values(story.resources).filter(r => r.type === 'webmap').map(r => r.data.itemId))].filter(x => !madeIds.has(x));

      const added = await post(`${userPath}/addItem`, {
        type: 'StoryMap',
        title: b.title,
        typeKeywords: draftKeywords.join(','),
        tags: Array.from(new Set([...(it.tags || []), 'StoryMap', 'converted from classic'])).join(','),
        snippet: it.snippet || '',
        description: it.description || '',
        accessInformation: it.accessInformation || '',
        licenseInfo: it.licenseInfo || '',
        text: ' '
      });
      itemId = added.id;
      const itemPath = `${userPath}/items/${itemId}`;
      const storyUrl = session.isOnline ? `https://storymaps.arcgis.com/stories/${itemId}` : `${session.portalUrl}/apps/storymaps/stories/${itemId}`;
      log(`Created item ${itemId}`, 'ok');

      if ($('optCopyImg').checked) {
        const { copied, linked } = await copyImages(story, itemPath);
        if (copied) log(`Copied ${copied} image${copied > 1 ? 's' : ''} into the story`, 'ok');
        if (linked) log(`${linked} image${linked > 1 ? 's' : ''} could not be copied (the image host blocks it) and stay linked to their original web address`, 'warn');
      }

      for (const [file, em] of Object.entries(expressFiles)) await post(`${itemPath}/addResources`, { fileName: file, text: JSON.stringify(em), access: 'private' });
      if (Object.keys(expressFiles).length) log(`Saved ${Object.keys(expressFiles).length} express map${Object.keys(expressFiles).length > 1 ? 's' : ''}`, 'ok');
      const json = JSON.stringify(story);
      await post(`${itemPath}/addResources`, { fileName: draft, text: json, access: 'private' });
      log('Saved the story content', 'ok');

      if (publish) {
        await post(`${itemPath}/addResources`, { fileName: 'published_data.json', text: json });
        for (const [file, em] of Object.entries(expressFiles)) await post(`${itemPath}/addResources`, { fileName: 'pub_' + file, text: JSON.stringify(em) });
        const now = Date.now();
        const pubKeywords = [...base, 'smstatuspublished', `smversionpublished:${version}`, `smpublisherapp:${APP_KEYWORD}`, `smpublisheddate:${now}`];
        await post(`${itemPath}/update`, { url: storyUrl, text: json, typeKeywords: pubKeywords.join(',') });
        log('Published', 'ok');
        if (session.isOnline) {
          // Same follow-up call the Python API makes; its reply can't be read cross-site, so it's best effort
          const fd = new FormData(); fd.append('f', 'json'); fd.append('token', session.token);
          fetch(storyUrl + '/publish', { method: 'POST', body: fd, mode: 'no-cors', credentials: 'omit' }).catch(() => {});
        }
      } else {
        await post(`${itemPath}/update`, { url: storyUrl });
        log('Saved as a draft', 'ok');
      }

      // One sharing level for the story and every map it uses that this account owns.
      // New items start private; maps this account already owned are only ever shared more widely, never less.
      const where = { private: 'only you', org: 'your organization', public: 'everyone' }[access];
      if (access !== 'private') {
        await post(`${itemPath}/share`, shareParams);
        for (const m of made) await post(`${userPath}/items/${m.id}/share`, shareParams);
      }
      const what = `Story${made.length ? ` and ${made.length} new web map${made.length > 1 ? 's' : ''}` : ''}`;
      log(access === 'private' ? `${what} kept private (only you can see ${made.length ? 'them' : 'it'})` : `${what} shared with ${where}`, 'ok');
      for (const mid of stillOriginal) {
        const info = await webmapInfo(mid);
        if (!info) continue;
        const cur = info.item.access || 'private';
        if ((ACCESS_RANK[cur] ?? 0) >= ACCESS_RANK[access]) continue;
        if (info.item.owner === user) {
          try { await post(`${userPath}/items/${mid}/share`, shareParams); log(`Shared your web map "${info.item.title}" with ${where} to match`, 'ok'); }
          catch (e2) { log(`Couldn't share your web map "${info.item.title}": ${e2.message}`, 'warn'); }
        } else {
          log(`"${info.item.title}" belongs to ${info.item.owner} and is shared ${ACCESS_LABEL[cur] || cur}, so some viewers of the story won't see it`, 'warn');
        }
      }

      if (b.coverSrc) {
        try { await post(`${itemPath}/update`, { thumbnailUrl: b.coverSrc }); log('Set the thumbnail from the cover image', 'ok'); }
        catch (_) { log('Thumbnail not set; the builder will create one when you open the story', 'warn'); }
      }
      showResult(itemId, storyUrl, publish, b, made);
    } catch (err) {
      const msg = /Failed to fetch|NetworkError|Load failed/i.test(err.message) ? 'The request was blocked before it reached ArcGIS.' : err.message;
      log(msg, 'bad');
      const leftover = [itemId, ...made.map(m => m.id)].filter(Boolean);
      if (leftover.length) log(`Partly created item${leftover.length > 1 ? 's are' : ' is'} in your content (${leftover.join(', ')}). You can delete ${leftover.length > 1 ? 'them' : 'it'} there.`, 'warn');
    } finally { btn.disabled = false; }
  }
  $('createForm').addEventListener('submit', createStory);

  function showResult(itemId, storyUrl, published, b, made = []) {
    const box = $('result'); box.replaceChildren(); box.hidden = false;
    const h = document.createElement('h3');
    h.textContent = published ? `"${b.title}" is published` : `"${b.title}" is saved as a draft`;
    const p = document.createElement('p');
    p.style.margin = '0'; p.style.color = 'var(--muted)'; p.style.fontSize = '14px';
    p.textContent = published
      ? 'Changes to a published story can take a few minutes to appear. Opening it in the builder refreshes it straight away.'
      : 'Open it in the builder to review each slide, run the issue checker and publish.';
    const links = document.createElement('div'); links.className = 'links';
    const link = (text, href, primary) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; if (primary) a.className = 'primary'; links.appendChild(a); };
    link('Open in the builder', storyUrl + '/edit', true);
    if (published) link('View story', storyUrl);
    link('Item details', `${session.orgHome}/home/item.html?id=${itemId}`);
    made.forEach(m => link(`New map: ${m.title}`, `${session.orgHome}/home/item.html?id=${m.id}`));
    const del = document.createElement('div'); del.className = 'del';
    const dbtn = document.createElement('button'); dbtn.type = 'button'; dbtn.className = 'danger';
    dbtn.textContent = made.length ? `Delete this story and its ${made.length} new web map${made.length > 1 ? 's' : ''}` : 'Delete this story';
    const note = document.createElement('span'); note.textContent = 'Useful while testing.';
    let armed = false;
    dbtn.addEventListener('click', async () => {
      if (!armed) { armed = true; dbtn.textContent = 'Click again to delete'; note.textContent = made.length ? 'This removes the new story and the web maps made for it. The original maps are not touched.' : 'This removes the new story item from your account.'; return; }
      dbtn.disabled = true;
      try {
        for (const id of [itemId, ...made.map(m => m.id)]) await post(`/content/users/${encodeURIComponent(session.user.username)}/items/${id}/delete`, {});
        box.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Deleted. Create the story again whenever you are ready.' }));
      } catch (err) { note.textContent = 'Could not delete: ' + err.message; dbtn.disabled = false; }
    });
    del.append(dbtn, note);
    box.append(h, p, links, del);
  }
})();
