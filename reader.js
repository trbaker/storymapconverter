/* StoryMap Converter, step 1: read a classic Esri Story Map from ArcGIS and export its content as a text file.
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
        else bases.push(u.origin + prefix + '/sharing/rest');
      }
    } catch (_) { /* bare ID */ }
    if (!bases.includes('https://www.arcgis.com/sharing/rest')) bases.push('https://www.arcgis.com/sharing/rest');
    return { id, bases, pageUrl, templateHint };
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

  // Template-specific extraction. Each returns [{title, html, media, extra:{}}]
  function extractEntries(values, template) {
    const v = values || {};
    const story = v.story || {};
    const pick = (arr, map) => Array.isArray(arr) ? arr.map(map) : [];
    if (Array.isArray(story.entries)) // Map Series
      return { label: 'Entries', list: pick(story.entries, e => ({
        title: e.title, html: e.description || '', media: describeMedia(e.media),
        extra: { status: e.status }
      })) };
    if (Array.isArray(story.sections)) // Map Journal
      return { label: 'Sections', list: pick(story.sections, s => ({
        title: htmlToText(s.title), html: s.content || '', media: describeMedia(s.media),
        extra: { actions: (s.contentActions || []).length || undefined }
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
      return { label: 'Tour points (order only)', list: pick(v.order, o => ({ title: 'Point ' + o.id, html: '', media: describeMedia(null), extra: { visible: o.visible } })) };
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
    t += `Read from:  ${base}/content/items/${item.id}/data\n`;

    t += rule('ITEM');
    t += `Title:      ${item.title || ''}\n`;
    t += `Item ID:    ${item.id}\n`;
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
      for (const [id, p] of ids) t += `${id}   at ${p}\n`;
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

  async function run(ev) {
    ev && ev.preventDefault();
    $('log').replaceChildren();
    $('go').disabled = true;
    try {
      const src = parseSource($('url').value, $('portal').value.trim());
      const token = $('token').value.trim();
      log(`Item ID ${src.id}`, 'ok');
      let item = null, base = null, lastErr = null;
      for (const b of src.bases) {
        try { item = await getJson(`${b}/content/items/${src.id}`, token); base = b; break; }
        catch (err) { lastErr = err; log(`${new URL(b).host}: ${err.message}`, 'warn'); }
      }
      if (!item) throw new Error(`Could not read the item (${lastErr?.message || 'unknown error'}). If the story is private, add an access token under "Private or ArcGIS Enterprise story".`);
      log(`Item found on ${new URL(base).host}: "${item.title}" (${item.type})`, 'ok');
      const data = await getJson(`${base}/content/items/${src.id}/data`, token).catch(err => { throw new Error('Item found, but its story data could not be read: ' + err.message); });
      log(`Story data read: ${JSON.stringify(data).length.toLocaleString()} characters of JSON`, 'ok');
      const tpl = detectTemplate(item, data, src.templateHint);
      log(`Template: ${tpl.name}${tpl.layout ? ' (' + tpl.layout + ' layout)' : ''}`, tpl.name === 'Unknown' ? 'warn' : 'ok');
      if (tpl.isModern) log('This item is already a modern ArcGIS StoryMap; no conversion needed.', 'warn');
      const pageCheck = await checkPage(src.pageUrl || item.url);
      const entries = extractEntries(data?.values, tpl.name);
      const scan = scanText(data);
      const ids = referencedIds(data);
      if (tpl.name === 'Map Tour') log('Map Tour points are stored in a feature layer, not in the story data. Only their order is listed for now.', 'warn');
      lastCtx = { item, data, tpl, entries, scan, ids, pageCheck, base, src };
      const slug = (item.title || src.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || src.id;
      state.filename = `${slug}_classic_${src.id.slice(0, 8)}.txt`;
      $('fname').replaceChildren(document.createTextNode(state.filename), el('small', { text: `${tpl.name} · ${entries.list.length} ${entries.label.toLowerCase()}` }));
      refreshText();
      $('results').hidden = false;
      window.dispatchEvent(new CustomEvent('classic-read', { detail: lastCtx }));
      log(`Text file ready: ${entries.list.length} ${entries.label.toLowerCase()}, ${scan.length} text fields.`, 'ok');
    } catch (err) {
      log(err.message || String(err), 'bad');
      if (location.protocol.startsWith('http') && /Failed to fetch|NetworkError|Load failed/i.test(err.message)) log('The request was blocked before it reached ArcGIS. Open this file directly in your browser (double-click it) rather than in a sandboxed preview.', 'warn');
    } finally {
      $('go').disabled = false;
    }
  }
  $('form').addEventListener('submit', run);

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

  // Open in a working state: read the example story straight away
  run();
})();
