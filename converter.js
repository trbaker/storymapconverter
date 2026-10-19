/* StoryMap Converter, steps 2 and 3: convert the classic story to ArcGIS StoryMaps JSON and create it in ArcGIS Online. */
/* ===== Steps 2 and 3: convert to ArcGIS StoryMaps JSON and create the item =====
   Item format follows Esri's ArcGIS API for Python (arcgis.apps.storymap):
   a "StoryMap" item, story JSON saved as a draft_<ms>.json resource, smstatus* type keywords,
   and on publish the same JSON in the item data plus a published_data.json resource. */
(() => {
  const $ = id => document.getElementById(id);
  const APP_KEYWORD = 'classic-storymap-converter';
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
    if (m.type === 'webmap' && b.id) return { kind: 'webmap', id: b.id, extent: b.extent, layers: b.layers };
    if (m.type === 'image' && abs(b.url)) return { kind: 'image', src: abs(b.url), alt: b.altText || b.alt || '', caption: strip(b.caption || '') };
    if (m.type === 'webpage' || m.type === 'video') {
      let url = b.url;
      if (!url && b.frameTag) { const mm = String(b.frameTag).match(/src=["']([^"']+)/i); url = mm && mm[1]; }
      if (!url && b.frameTag) { const mm = String(b.frameTag).match(/data-src=["']([^"']+)/i); url = mm && mm[1]; }
      return abs(url) ? { kind: 'embed', url: abs(url), video: !!videoInfo(url), caption: strip(b.caption || '') } : null;
    }
    return null;
  }
  function classicEntries(ctx) {
    const v = (ctx.data && ctx.data.values) || {};
    if (v.story && Array.isArray(v.story.entries))
      return v.story.entries.filter(e => e.status !== 'HIDDEN').map(e => ({ title: strip(e.title), html: e.description || '', media: classicMedia(e.media) }));
    if (v.story && Array.isArray(v.story.sections))
      return v.story.sections.map(s => ({ title: strip(s.title), html: s.content || '', media: classicMedia(s.media) }));
    const list = (ctx.entries && ctx.entries.list) || [];
    if (list.length) return list.map(e => ({
      title: strip(e.title), html: e.html || '',
      media: e.media.type === 'image' && abs(e.media.ref) ? { kind: 'image', src: abs(e.media.ref) }
        : e.media.type === 'webmap' && /^[0-9a-f]{32}/i.test(e.media.ref) ? { kind: 'webmap', id: e.media.ref.slice(0, 32) }
        : /^(webpage|video)$/.test(e.media.type) && abs(e.media.ref) ? { kind: 'embed', url: abs(e.media.ref), video: !!videoInfo(e.media.ref) } : null
    }));
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
    const sr = e.spatialReference || { wkid: 102100 };
    if ((sr.latestWkid || sr.wkid) === 4326) {
      const [a, b] = toMercator(e.xmin, e.ymin), [c, d] = toMercator(e.xmax, e.ymax);
      return { xmin: a, ymin: b, xmax: c, ymax: d, spatialReference: { wkid: 102100, latestWkid: 3857 } };
    }
    return { xmin: e.xmin, ymin: e.ymin, xmax: e.xmax, ymax: e.ymax, spatialReference: sr };
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
    const mapNode = async (m, size) => {
      const info = await webmapInfo(m.id);
      const r = id('r');
      const data = { itemId: m.id, itemType: (info && info.item.type) || 'Web Map', type: 'minimal' };
      if (info) {
        const vp = (info.data.initialState && info.data.initialState.viewpoint) || {};
        const extent = normExtent(m.extent) || normExtent(vp.targetGeometry) || normExtent(info.item.extent);
        if (extent) {
          const center = { spatialReference: extent.spatialReference, x: (extent.xmin + extent.xmax) / 2, y: (extent.ymin + extent.ymax) / 2 };
          const scale = (!m.extent && vp.scale) || Math.max(1000, (extent.xmax - extent.xmin) / 0.24);
          Object.assign(data, {
            extent, center,
            zoom: Math.max(0, Math.min(20, Math.round(Math.log2(591657527.591555 / scale)))),
            viewpoint: { rotation: vp.rotation || 0, scale, targetGeometry: center }
          });
        }
        const vis = new Map((m.layers || []).map(l => [l.id, l.visibility]));
        data.mapLayers = (info.data.operationalLayers || []).map(l => ({
          id: l.id, title: l.title || '', visible: vis.has(l.id) ? !!vis.get(l.id) : l.visibility !== false
        }));
      } else {
        warnings.push(`Web map ${m.id} could not be read, so its starting view is not set. Open the story in the builder to check it.`);
      }
      resources[r] = { type: 'webmap', data };
      const n = add('webmap', { map: r, caption: m.caption || '', alt: '' });
      if (size) nodes[n].config = { size };
      return n;
    };
    const mediaNode = (m, size) => {
      if (!m) return null;
      if (m.kind === 'image') return imageNode(m.src, m.alt, m.caption, size);
      if (m.kind === 'webmap') return mapNode(m, size);
      if (m.kind === 'embed') return embedNode(m.url, m.caption, 'inline');
      return null;
    };
    const blockNodes = async blocks => {
      const ids = [];
      for (const b of blocks) {
        if (b.kind === 'text') ids.push(add('text', { type: b.style, text: b.html }));
        else if (b.kind === 'image') ids.push(await imageNode(b.src, b.alt, '', 'standard'));
        else if (b.kind === 'embed') ids.push(embedNode(b.url, '', b.video ? 'inline' : 'card'));
        else if (b.kind === 'separator') ids.push(add('separator'));
      }
      return ids;
    };

    const v = (ctx.data && ctx.data.values) || {};
    const entries = classicEntries(ctx);
    if (!entries.length) warnings.push('No entries were found to convert. The new story will only have a cover.');
    const mainMap = v.webmap && /^[0-9a-f]{32}$/i.test(v.webmap) ? { kind: 'webmap', id: v.webmap } : null;
    const prepared = entries.map(e => {
      let blocks = htmlToBlocks(e.html);
      if (opts.dropDupTitle && blocks[0] && blocks[0].kind === 'text' && e.title && norm(blocks[0].html) === norm(e.title)) blocks = blocks.slice(1);
      return { title: e.title, blocks, media: e.media || mainMap };
    });
    // start every image-size and map lookup at once instead of one by one
    prepared.forEach(p => {
      if (p.media && p.media.kind === 'image') imageSize(p.media.src);
      if (p.media && p.media.kind === 'webmap') webmapInfo(p.media.id);
      p.blocks.forEach(b => { if (b.kind === 'image') imageSize(b.src); });
    });

    const outline = [];
    const describe = (p) => {
      const counts = {};
      p.blocks.forEach(b => { const k = b.kind === 'text' ? (/list/.test(b.style) ? 'list' : /^h/.test(b.style) ? 'heading' : b.style === 'quote' ? 'quote' : 'paragraph') : b.video ? 'video' : b.kind; counts[k] = (counts[k] || 0) + 1; });
      const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`);
      if (p.media) parts.unshift(p.media.kind === 'webmap' ? 'map' : p.media.video ? 'video' : p.media.kind);
      return parts.join(' · ') || 'empty';
    };

    // cover
    const coverSrc = (() => {
      for (const p of prepared) {
        if (p.media && p.media.kind === 'image') return p.media.src;
        const b = p.blocks.find(x => x.kind === 'image'); if (b) return b.src;
      }
      return '';
    })();
    const title = opts.title || v.title || ctx.item.title || 'Untitled story';
    const summary = strip(v.subtitle) || ctx.item.snippet || '';
    const cover = add('storycover', {
      type: coverSrc ? 'full' : 'minimal', title, summary,
      byline: (session && (session.user.fullName || session.user.username)) || '', titlePanelPosition: 'start'
    });
    if (coverSrc) nodes[cover].children = [await imageNode(coverSrc, '', '')];
    outline.push({ k: 'Cover', t: title, c: coverSrc ? 'full · image' : 'minimal' });
    const nav = add('navigation', { links: [] }, { config: { isHidden: true } });
    const body = [];

    if (opts.layout === 'sidecar') {
      const slides = [];
      let i = 0;
      for (const p of prepared) {
        i++;
        const panelKids = [];
        if (p.title) panelKids.push(add('text', { type: 'h3', text: esc(p.title) }));
        panelKids.push(...await blockNodes(p.blocks));
        const panel = add('immersive-narrative-panel', { position: 'start', size: 'medium', panelStyle: 'themed' }, { children: panelKids });
        const m = await mediaNode(p.media);
        slides.push(add('immersive-slide', { transition: 'fade' }, { children: m ? [panel, m] : [panel] }));
        if (!m) warnings.push(`Slide ${i} ("${p.title || 'untitled'}") has no image or map; add one in the builder.`);
        outline.push({ k: String(i).padStart(2, '0'), t: p.title || '(untitled)', c: describe(p) });
      }
      if (slides.length) body.push(add('immersive', {
        type: 'sidecar', subtype: 'docked-panel', narrativePanelPosition: 'start', narrativePanelSize: 'medium'
      }, { children: slides }));
    } else {
      let i = 0;
      for (const p of prepared) {
        i++;
        if (i > 1) body.push(add('separator'));
        if (p.title) body.push(add('text', { type: 'h2', text: esc(p.title) }));
        const m = await mediaNode(p.media, 'wide');
        if (m) body.push(m);
        body.push(...await blockNodes(p.blocks));
        outline.push({ k: String(i).padStart(2, '0'), t: p.title || '(untitled)', c: describe(p) });
      }
    }

    if (opts.backlink) {
      const src = ctx.item.url || (ctx.src && ctx.src.pageUrl);
      const label = esc(ctx.item.title || 'the classic story');
      body.push(add('text', { type: 'paragraph', text: src
        ? `<em>Converted from the classic Story Map <a href="${escAttr(src)}" rel="noopener noreferrer" target="_blank">${label}</a>.</em>`
        : `<em>Converted from the classic Story Map ${label}.</em>` }));
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
    return { story: { root, nodes, resources }, outline, warnings: Array.from(new Set(warnings)), coverSrc, title };
  }

  // ---------- step 2 UI ----------
  function convOpts() {
    return {
      layout: document.querySelector('input[name="layout"]:checked').value,
      dropDupTitle: $('optDup').checked,
      backlink: $('optBacklink').checked,
      title: $('cTitle').value.trim()
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
    logTo('convLog', `${result.outline.length - 1} ${convOpts().layout === 'sidecar' ? 'slides' : 'sections'}, ${n} story blocks, ${r} images, maps and theme settings.`, 'ok');
    result.warnings.forEach(w => logTo('convLog', w, 'warn'));
    return result;
  }
  let rebuildTimer;
  const scheduleRebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 150); };
  document.querySelectorAll('input[name="layout"]').forEach(r => r.addEventListener('change', scheduleRebuild));
  ['optDup', 'optBacklink'].forEach(id => $(id).addEventListener('change', scheduleRebuild));
  $('cTitle').addEventListener('input', scheduleRebuild);

  window.addEventListener('classic-read', e => {
    classic = e.detail;
    built = null;
    mapCache.clear();
    $('cTitle').value = (classic.data && classic.data.values && classic.data.values.title) || classic.item.title || '';
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
    const blob = new Blob([JSON.stringify(b.story, null, 2)], { type: 'application/json' });
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

      const json = JSON.stringify(story);
      await post(`${itemPath}/addResources`, { fileName: draft, text: json, access: 'private' });
      log('Saved the story content', 'ok');

      if (publish) {
        await post(`${itemPath}/addResources`, { fileName: 'published_data.json', text: json });
        const now = Date.now();
        const pubKeywords = [...base, 'smstatuspublished', `smversionpublished:${version}`, `smpublisherapp:${APP_KEYWORD}`, `smpublisheddate:${now}`];
        await post(`${itemPath}/update`, { url: storyUrl, text: json, typeKeywords: pubKeywords.join(',') });
        if (access !== 'private') {
          await post(`${itemPath}/share`, { everyone: access === 'public', org: true, groups: '' });
        }
        log(`Published${access === 'public' ? ' and shared publicly' : access === 'org' ? ' and shared with your organization' : ' (visible only to you)'}`, 'ok');
        if (session.isOnline) {
          // Same follow-up call the Python API makes; its reply can't be read cross-site, so it's best effort
          const fd = new FormData(); fd.append('f', 'json'); fd.append('token', session.token);
          fetch(storyUrl + '/publish', { method: 'POST', body: fd, mode: 'no-cors', credentials: 'omit' }).catch(() => {});
        }
      } else {
        await post(`${itemPath}/update`, { url: storyUrl });
        log('Saved as a private draft', 'ok');
      }

      if (b.coverSrc) {
        try { await post(`${itemPath}/update`, { thumbnailUrl: b.coverSrc }); log('Set the thumbnail from the cover image', 'ok'); }
        catch (_) { log('Thumbnail not set; the builder will create one when you open the story', 'warn'); }
      }
      showResult(itemId, storyUrl, publish, b);
    } catch (err) {
      const msg = /Failed to fetch|NetworkError|Load failed/i.test(err.message) ? 'The request was blocked before it reached ArcGIS.' : err.message;
      log(msg, 'bad');
      if (itemId) log(`A partly created item (${itemId}) is in your content. You can delete it there.`, 'warn');
    } finally { btn.disabled = false; }
  }
  $('createForm').addEventListener('submit', createStory);

  function showResult(itemId, storyUrl, published, b) {
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
    const del = document.createElement('div'); del.className = 'del';
    const dbtn = document.createElement('button'); dbtn.type = 'button'; dbtn.className = 'danger'; dbtn.textContent = 'Delete this story';
    const note = document.createElement('span'); note.textContent = 'Useful while testing.';
    let armed = false;
    dbtn.addEventListener('click', async () => {
      if (!armed) { armed = true; dbtn.textContent = 'Click again to delete'; note.textContent = 'This removes the new story item from your account.'; return; }
      dbtn.disabled = true;
      try {
        await post(`/content/users/${encodeURIComponent(session.user.username)}/items/${itemId}/delete`, {});
        box.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Deleted. Create the story again whenever you are ready.' }));
      } catch (err) { note.textContent = 'Could not delete: ' + err.message; dbtn.disabled = false; }
    });
    del.append(dbtn, note);
    box.append(h, p, links, del);
  }
})();
