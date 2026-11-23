/* LernSperre – Web-Prototyp (früher „Anki Lock“)
 * Importiert .apkg-Dateien, speichert alles lokal (IndexedDB) und fragt Karten ab.
 * Nach erfolgreicher Abfrage ist man für X Minuten "frei". Optional wird ein
 * iOS-Kurzbefehl mit dem Ende der freien Zeit gestartet.
 */
(() => {
  'use strict';

  // ---------- Einstellungen & Zustand (localStorage) ----------
  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem('ankilock.' + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('ankilock.' + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const DEFAULTS = {
    interval: 5, cards: 1, mode: 'srs', newPerDay: 20,
    cardScale: 100, imgMax: 50, hideTitle: false, autoHideNav: false,
    penHalve: true, penExtra: false, penRepeat: true,
    appMode: 'lock', appModeChosen: false, useShortcut: false, shortcutName: 'LernSperre UNLOCK', skipEnabled: true, skipOnceEnabled: true,
  };
  const settings = Object.assign({}, DEFAULTS, LS.get('settings', {}));
  // Einmalige Umstellung auf die neuen Standardwerte (Spaced Repetition, 5 Minuten)
  if (LS.get('settingsRev', 1) < 2) {
    Object.assign(settings, { mode: 'srs', interval: 5, newPerDay: 20 });
    LS.set('settings', settings);
    LS.set('settingsRev', 2);
  }
  // Umbenennung in LernSperre: alten Standard-Kurzbefehlnamen übernehmen
  if (LS.get('settingsRev', 2) < 3) {
    if (settings.shortcutName === 'Anki Fertig') settings.shortcutName = 'LernSperre Fertig';
    LS.set('settings', settings);
    LS.set('settingsRev', 3);
  }
  // Kurzbefehle heißen jetzt „LernSperre UNLOCK“ (nach dem Lernen) und „LernSperre LOCK“ (Prüfen)
  if (LS.get('settingsRev', 3) < 4) {
    if (['Anki Fertig', 'LernSperre Fertig'].includes(settings.shortcutName)) settings.shortcutName = 'LernSperre UNLOCK';
    LS.set('settings', settings);
    LS.set('settingsRev', 4);
  }
  const saveSettings = () => LS.set('settings', settings);

  // ---------- IndexedDB ----------
  const DB_NAME = 'ankilock';
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('imports', { keyPath: 'id' });
          d.createObjectStore('decks', { keyPath: 'key' }).createIndex('importId', 'importId');
          d.createObjectStore('notetypes', { keyPath: 'key' }).createIndex('importId', 'importId');
          d.createObjectStore('notes', { keyPath: 'key' }).createIndex('importId', 'importId');
          d.createObjectStore('cards', { keyPath: 'key' }).createIndex('importId', 'importId');
          d.createObjectStore('media', { keyPath: 'key' }).createIndex('importId', 'importId');
          d.createObjectStore('sched', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  async function getAll(store) { const d = await db(); return reqP(d.transaction(store).objectStore(store).getAll()); }
  async function getOne(store, key) { const d = await db(); return reqP(d.transaction(store).objectStore(store).get(key)); }
  async function putMany(store, items) {
    const d = await db();
    const CHUNK = 500;
    for (let i = 0; i < items.length; i += CHUNK) {
      const tx = d.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const it of items.slice(i, i + CHUNK)) os.put(it);
      await txDone(tx);
    }
  }
  async function deleteByImport(store, importId) {
    const d = await db();
    const tx = d.transaction(store, 'readwrite');
    const idx = tx.objectStore(store).index('importId');
    const keys = await reqP(idx.getAllKeys(importId));
    for (const k of keys) tx.objectStore(store).delete(k);
    await txDone(tx);
  }

  // ---------- Minimaler Protobuf-Leser (für neue Anki-Formate) ----------
  function pbDecode(bytes) {
    const out = {};
    let i = 0;
    const varint = () => {
      let result = 0, shift = 0, b;
      do { b = bytes[i++]; result += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
      return result;
    };
    while (i < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8), wire = tag & 7;
      let val;
      if (wire === 0) val = varint();
      else if (wire === 2) { const len = varint(); val = bytes.subarray(i, i + len); i += len; }
      else if (wire === 5) { val = bytes.subarray(i, i + 4); i += 4; }
      else if (wire === 1) { val = bytes.subarray(i, i + 8); i += 8; }
      else break;
      (out[field] = out[field] || []).push(val);
    }
    return out;
  }
  const utf8 = new TextDecoder();
  const pbStr = (msg, f) => (msg[f] && msg[f][0] instanceof Uint8Array) ? utf8.decode(msg[f][0]) : '';
  const isZstd = (u8) => u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;
  const unzstd = (u8) => isZstd(u8) ? fzstd.decompress(u8) : u8;

  // ---------- Import ----------
  let SQL = null;
  async function sqljs() {
    if (!SQL) SQL = await initSqlJs({ locateFile: (f) => 'vendor/' + f });
    return SQL;
  }

  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  };
  const mimeFor = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  async function importApkg(file, onStatus) {
    onStatus('Datei wird entpackt …');
    const zip = await JSZip.loadAsync(file);
    let colBytes = null, newFormat = false;
    if (zip.file('collection.anki21b')) {
      colBytes = unzstd(await zip.file('collection.anki21b').async('uint8array'));
      newFormat = true;
    } else if (zip.file('collection.anki21')) {
      colBytes = await zip.file('collection.anki21').async('uint8array');
    } else if (zip.file('collection.anki2')) {
      colBytes = await zip.file('collection.anki2').async('uint8array');
    } else {
      throw new Error('Keine Anki-Sammlung in der Datei gefunden.');
    }

    onStatus('Karten werden gelesen …');
    const S = await sqljs();
    const sdb = new S.Database(colBytes);
    const q = (sql) => { const r = sdb.exec(sql); return r.length ? r[0].values : []; };
    const tables = new Set(q("select name from sqlite_master where type='table'").map((r) => r[0]));

    const importId = 'i' + Date.now().toString(36);
    const decks = {};      // did -> name (mit ::)
    const notetypes = {};  // mid -> {name, type, css, fields[], tmpls[{qfmt, afmt}]}

    if (tables.has('notetypes')) {
      for (const [id, name] of q('select id, name from decks')) decks[String(id)] = String(name).split('\x1f').join('::');
      for (const [id, name, config] of q('select id, name, config from notetypes')) {
        const cfg = pbDecode(config || new Uint8Array());
        notetypes[String(id)] = {
          name, type: cfg[1] ? cfg[1][0] : 0, css: pbStr(cfg, 3), fields: [], tmpls: [],
        };
      }
      for (const [ntid, ord, name] of q('select ntid, ord, name from fields order by ntid, ord')) {
        const nt = notetypes[String(ntid)]; if (nt) nt.fields[ord] = name;
      }
      for (const [ntid, ord, , config] of q('select ntid, ord, name, config from templates order by ntid, ord')) {
        const nt = notetypes[String(ntid)]; if (!nt) continue;
        const cfg = pbDecode(config || new Uint8Array());
        nt.tmpls[ord] = { qfmt: pbStr(cfg, 1), afmt: pbStr(cfg, 2) };
      }
    } else {
      const [decksJson, modelsJson] = q('select decks, models from col')[0];
      for (const [id, d] of Object.entries(JSON.parse(decksJson))) decks[id] = d.name;
      for (const [id, m] of Object.entries(JSON.parse(modelsJson))) {
        const tmpls = [];
        for (const t of m.tmpls) tmpls[t.ord] = { qfmt: t.qfmt, afmt: t.afmt };
        notetypes[id] = { name: m.name, type: m.type, css: m.css || '', fields: m.flds.map((f) => f.name), tmpls };
      }
    }

    // Fehlende Eltern-Decks ergänzen (z. B. "1. Semester" bei "1. Semester::Biologie")
    const names = new Set(Object.values(decks));
    let synth = 0;
    for (const name of [...names]) {
      const parts = name.split('::');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('::');
        if (!names.has(parent)) { names.add(parent); decks['p' + (synth++)] = parent; }
      }
    }

    const noteRows = q('select id, mid, flds, tags from notes');
    const cardRows = q('select id, nid, did, odid, ord, due, type from cards');
    sdb.close();

    // Alte Exporte aus neuem Anki enthalten nur eine Hinweis-Karte in collection.anki2
    if (!newFormat && noteRows.length === 1 && /update|aktualisier/i.test(String(noteRows[0][2])) && cardRows.length <= 1 && !zip.file('collection.anki21')) {
      // trotzdem importieren, aber warnen
      onStatus('Hinweis: Diese Datei scheint nur eine Platzhalter-Karte zu enthalten.');
    }

    // Medien
    onStatus('Bilder werden gelesen …');
    let mediaMap = {};
    const mediaFile = zip.file('media');
    if (mediaFile) {
      const raw = await mediaFile.async('uint8array');
      try {
        mediaMap = JSON.parse(utf8.decode(raw));
      } catch {
        const msg = pbDecode(unzstd(raw));
        (msg[1] || []).forEach((entry, idx) => { mediaMap[String(idx)] = pbStr(pbDecode(entry), 1); });
      }
    }
    const mediaItems = [];
    const entries = Object.entries(mediaMap);
    for (let n = 0; n < entries.length; n++) {
      const [zipName, name] = entries[n];
      const zf = zip.file(zipName);
      if (!zf || !name) continue;
      const bytes = unzstd(await zf.async('uint8array'));
      mediaItems.push({ key: importId + '/' + name, importId, blob: new Blob([bytes], { type: mimeFor(name) }) });
      if (n % 100 === 0) onStatus(`Bilder werden gelesen … ${n}/${entries.length}`);
    }

    onStatus('Wird gespeichert …');
    const deckItems = Object.entries(decks).map(([id, name]) => ({ key: importId + ':' + id, importId, name }));
    const ntItems = Object.entries(notetypes).map(([id, nt]) => Object.assign({ key: importId + ':' + id, importId }, nt));
    const noteItems = noteRows.map(([id, mid, flds, tags]) => ({
      key: importId + ':' + id, importId, mid: importId + ':' + mid, flds: String(flds).split('\x1f'), tags: String(tags || '').trim(),
    }));
    const cardItems = cardRows.map(([id, nid, did, odid, ord, due, type]) => ({
      key: importId + ':' + id, importId, nid: importId + ':' + nid,
      did: importId + ':' + (odid && Number(odid) !== 0 ? odid : did), ord, order: type === 0 ? Number(due) : Number(id),
    }));

    await putMany('decks', deckItems);
    await putMany('notetypes', ntItems);
    await putMany('notes', noteItems);
    await putMany('cards', cardItems);
    await putMany('media', mediaItems);
    const roots = [...new Set(deckItems.map((d) => d.name.split('::')[0]))];
    const title = file.name.replace(/\.(apkg|colpkg)$/i, '') || roots.join(', ');
    await putMany('imports', [{ id: importId, name: title, date: Date.now(), cards: cardItems.length, media: mediaItems.length }]);

    // Neu importierte Decks automatisch auswählen (die mit Karten)
    const usedDecks = new Set(cardItems.map((c) => c.did));
    const sel = new Set(LS.get('selectedDecks', []));
    for (const d of deckItems) {
      if (!d.name.includes('::') && deckItems.some((x) => usedDecks.has(x.key) && (x.name === d.name || x.name.startsWith(d.name + '::')))) sel.add(d.key);
    }
    LS.set('selectedDecks', [...sel]);
    return { cards: cardItems.length, media: mediaItems.length };
  }

  // ---------- Daten im Speicher ----------
  let allDecks = [], allCards = [], allImports = [];
  async function loadData() {
    [allDecks, allCards, allImports] = await Promise.all([getAll('decks'), getAll('cards'), getAll('imports')]);
  }
  const skippedSet = () => new Set(LS.get('skipped', []));
  function selectedCards(includeSkipped) {
    const sel = LS.get('selectedDecks', []);
    const deckByKey = new Map(allDecks.map((d) => [d.key, d]));
    const selNames = sel.map((k) => deckByKey.get(k)).filter(Boolean);
    const allowed = new Set();
    for (const d of allDecks) {
      if (selNames.some((s) => s.importId === d.importId && (d.name === s.name || d.name.startsWith(s.name + '::')))) allowed.add(d.key);
    }
    const skipped = includeSkipped ? new Set() : skippedSet();
    return allCards.filter((c) => allowed.has(c.did) && !skipped.has(c.key));
  }

  // ---------- Karten-Rendering ----------
  const stripHtml = (s) => new DOMParser().parseFromString(String(s), 'text/html').body.textContent || '';
  const fieldNonEmpty = (s) => s != null && stripHtml(s.replace(/<img/gi, 'x<img')).trim() !== '';

  function renderCloze(text, ordNum, isAnswer) {
    return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, n, content, hint) => {
      if (Number(n) !== ordNum) return content;
      if (isAnswer) return `<span class="cloze">${content}</span>`;
      return `<span class="cloze">[${hint || '…'}]</span>`;
    });
  }

  function renderTemplate(tmpl, ctx) {
    // Abschnitte {{#Feld}} … {{/Feld}} und {{^Feld}} … {{/Feld}}
    let prev;
    do {
      prev = tmpl;
      tmpl = tmpl.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (m, kind, name, inner) => {
        const fieldName = name.split(':').pop();
        const val = ctx.fields[fieldName];
        const present = fieldName === 'FrontSide' ? true : fieldNonEmpty(val);
        return (kind === '#') === present ? inner : '';
      });
    } while (tmpl !== prev);

    return tmpl.replace(/\{\{([^}]+?)\}\}/g, (m, inner) => {
      const parts = inner.trim().split(':');
      const name = parts.pop().trim();
      const filters = parts.map((p) => p.trim().toLowerCase());
      if (name === 'FrontSide') return ctx.frontSide || '';
      if (name === 'Tags') return ctx.tags || '';
      if (name === 'Deck') return ctx.deck || '';
      if (name === 'Subdeck') return (ctx.deck || '').split('::').pop();
      if (name === 'Type') return ctx.typeName || '';
      if (name === 'Card') return '';
      let val = ctx.fields[name];
      if (val == null) return '';
      if (filters.includes('type') || filters.includes('tts')) return '';
      if (filters.includes('cloze')) val = renderCloze(val, ctx.ord + 1, ctx.isAnswer);
      if (filters.includes('text')) val = stripHtml(val);
      if (filters.includes('hint')) val = val ? `<details><summary>Hinweis</summary>${val}</details>` : '';
      return val;
    });
  }

  const CARD_CSS_OVERRIDES = `
    :host { display:block; }
    .card { padding: 20px 16px; min-height: 120px; overflow-wrap: break-word; hyphens: auto; -webkit-hyphens: auto; }
    img { max-width: 100% !important; max-height: var(--img-max, 50vh); width: auto; height: auto; object-fit: contain; }
    #io-wrapper { display: inline-block; width: auto !important; max-width: 100%; vertical-align: top; }
    #io-overlay img { width: 100% !important; max-height: none !important; }
    .cloze { font-weight: bold; color: #1a5fd6; }
    hr#answer { border: 0; border-top: 1px solid #ddd; margin: 16px 0; }
    #io-original { visibility: visible !important; }
    #io-revl-btn { display: none !important; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { border: 1px solid #ccc; padding: 2px 6px; }
    ul, ol { text-align: left; display: inline-block; margin: 6px 0; }
  `;

  let blobUrls = [];
  async function renderCardInto(host, card, isAnswer) {
    const note = await getOne('notes', card.nid);
    const nt = await getOne('notetypes', note.mid);
    const fields = {};
    nt.fields.forEach((f, i) => { fields[f] = note.flds[i] || ''; });
    const tmpl = nt.type === 1 ? nt.tmpls[0] : (nt.tmpls[card.ord] || nt.tmpls[0]);
    const deck = (allDecks.find((d) => d.key === card.did) || {}).name || '';
    const base = { fields, tags: note.tags, deck, typeName: nt.name, ord: card.ord };
    // Ohne Vorlage (z. B. unbekanntes Format): erstes Feld vorne, Rest hinten
    const qfmt = tmpl ? tmpl.qfmt : `{{${nt.fields[0]}}}`;
    const afmt = tmpl ? tmpl.afmt : `{{FrontSide}}<hr id=answer>` + nt.fields.slice(1).map((f) => `{{${f}}}`).join('<br>');
    let html = renderTemplate(qfmt, Object.assign({}, base, { isAnswer: false }));
    if (isAnswer) {
      const front = renderTemplate(qfmt, Object.assign({}, base, { isAnswer: true }));
      html = renderTemplate(afmt, Object.assign({}, base, { isAnswer: true, frontSide: front }));
    }
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\[sound:[^\]]*\]/g, '');

    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls = [];
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${nt.css || ''}\n${CARD_CSS_OVERRIDES}</style><div class="card mobile">${html}</div>`;
    root.querySelectorAll('[onclick]').forEach((el) => el.removeAttribute('onclick'));
    const imgs = root.querySelectorAll('img[src]');
    await Promise.all([...imgs].map(async (img) => {
      const src = img.getAttribute('src');
      if (/^(https?:|data:)/i.test(src)) return;
      let name = src;
      try { name = decodeURIComponent(src); } catch { /* keep */ }
      const m = (await getOne('media', card.importId + '/' + name)) || (await getOne('media', card.importId + '/' + src));
      if (m) { const u = URL.createObjectURL(m.blob); blobUrls.push(u); img.src = u; }
      else img.alt = '[Bild fehlt]';
    }));
    return deck;
  }

  // ---------- Planung (Zufall / Spaced Repetition) ----------
  const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
  const todayKey = () => new Date().toISOString().slice(0, 10);

  async function pickCard(exclude, strict) {
    const cards = selectedCards().filter((c) => !exclude.has(c.key));
    if (!cards.length) return null;
    if (settings.mode === 'random') {
      const recent = LS.get('recent', []);
      const fresh = cards.filter((c) => !recent.includes(c.key));
      const pool = fresh.length ? fresh : cards;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    const sched = new Map((await getAll('sched')).map((s) => [s.key, s]));
    const now = Date.now();
    const due = cards.filter((c) => sched.has(c.key) && sched.get(c.key).due <= now)
      .sort((a, b) => sched.get(a.key).due - sched.get(b.key).due);
    if (due.length) return due[0];
    const nc = LS.get('newCount', {});
    const newToday = nc.day === todayKey() ? nc.n : 0;
    if (newToday < settings.newPerDay) {
      const fresh = cards.filter((c) => !sched.has(c.key)).sort((a, b) => a.order - b.order);
      if (fresh.length) return fresh[0];
    }
    // nichts fällig: die als nächstes fällige Karte vorziehen
    if (strict) { // Nur-lernen-Modus: nur Karten, die in den nächsten 20 Minuten fällig werden
      const soon = cards.filter((c) => sched.has(c.key) && sched.get(c.key).due <= now + 20 * MIN)
        .sort((a, b) => sched.get(a.key).due - sched.get(b.key).due);
      return soon[0] || null;
    }
    const known = cards.filter((c) => sched.has(c.key)).sort((a, b) => sched.get(a.key).due - sched.get(b.key).due);
    return known[0] || cards[Math.floor(Math.random() * cards.length)];
  }

  function nextState(s, grade) {
    const now = Date.now();
    s = s ? Object.assign({}, s) : { ivl: 0, ease: 2.5, reps: 0, lapses: 0, due: now };
    if (grade === 1) { if (s.ivl > 0) s.lapses++; s.ivl = 0; s.ease = Math.max(1.3, s.ease - 0.2); s.due = now + 1 * MIN; }
    else if (s.ivl === 0) {
      if (grade === 2) s.due = now + 6 * MIN;
      else { s.ivl = grade === 4 ? 4 : 1; s.due = now + s.ivl * DAY; if (grade === 4) s.ease += 0.15; }
    } else {
      if (grade === 2) { s.ivl = Math.max(1, s.ivl * 1.2); s.ease = Math.max(1.3, s.ease - 0.15); }
      else if (grade === 3) s.ivl = s.ivl * s.ease;
      else { s.ivl = s.ivl * s.ease * 1.3; s.ease += 0.15; }
      s.ivl = Math.round(s.ivl * 10) / 10;
      s.due = now + s.ivl * DAY;
    }
    s.reps++;
    return s;
  }
  function fmtIvl(s, grade) {
    const n = nextState(s, grade);
    const ms = n.due - Date.now();
    if (ms < 60 * MIN) return Math.max(1, Math.round(ms / MIN)) + ' min';
    if (ms < DAY) return Math.round(ms / (60 * MIN)) + ' h';
    const d = ms / DAY;
    return d < 30 ? Math.round(d) + ' T' : d < 365 ? Math.round(d / 30) + ' Mo' : (d / 365).toFixed(1) + ' J';
  }

  // ---------- Lern-Ablauf ----------
  const $ = (id) => document.getElementById(id);
  let session = null;

  function unlockUntil() { return LS.get('unlockUntil', 0); }

  function fmtTime(ms) { return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
  function fmtLeft(ms) {
    const m = Math.ceil(ms / MIN);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function shortcutDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function runShortcut() {
    const url = 'shortcuts://run-shortcut?name=' + encodeURIComponent(settings.shortcutName) +
      '&input=text&text=' + encodeURIComponent(shortcutDate(unlockUntil()));
    window.location.href = url;
  }

  let freeTimer = null;
  const learnOnly = () => settings.appMode === 'learn';
  async function showLearn() {
    clearInterval(freeTimer);
    ['learn-empty', 'learn-free', 'learn-session', 'learn-done'].forEach((id) => $(id).classList.add('hidden'));
    if (session) { $('learn-session').classList.remove('hidden'); syncSkipButtons(); return; }
    if (!selectedCards().length) { $('learn-empty').classList.remove('hidden'); return; }
    if (learnOnly()) {
      if (settings.mode === 'srs' && !(await pickCard(new Set(), true))) { showLearnDone(); return; }
      startSession(false);
      return;
    }
    const until = unlockUntil();
    if (until > Date.now()) {
      $('learn-free').classList.remove('hidden');
      $('free-until').textContent = fmtTime(until);
      $('btn-run-shortcut').classList.toggle('hidden', !settings.useShortcut);
      const tick = () => {
        const left = until - Date.now();
        if (left <= 0) { clearInterval(freeTimer); showLearn(); return; }
        $('free-left').textContent = fmtLeft(left);
      };
      tick();
      freeTimer = setInterval(tick, 15000);
      return;
    }
    startSession(false);
  }

  function startSession(voluntary, ahead) {
    session = { required: settings.cards, done: 0, wrong: 0, extra: 0, factor: 1, seen: new Set(), repeat: [], voluntary, ahead: !!ahead };
    $('learn-session').classList.remove('hidden');
    ['learn-empty', 'learn-free', 'learn-done'].forEach((id) => $(id).classList.add('hidden'));
    nextCard();
  }

  function showLearnDone() {
    ['learn-empty', 'learn-free', 'learn-session'].forEach((id) => $(id).classList.add('hidden'));
    $('learn-done').classList.remove('hidden');
  }

  // Nur-lernen-Modus: keine feste Kartenzahl, im SRS-Modus bis nichts mehr fällig ist
  async function nextLearnCard() {
    const last = session.card ? session.card.key : null;
    const strict = settings.mode === 'srs' && !session.ahead;
    let card = await pickCard(new Set(last ? [last] : []), strict);
    if (!card && last) card = await pickCard(new Set(), strict);
    if (!card) { const n = session.done; session = null; if (n) toast(`${n} ${n === 1 ? 'Karte' : 'Karten'} gelernt`); showLearnDone(); return; }
    session.card = card;
    session.revealed = false;
    updateProgress();
    $('btn-show').classList.remove('hidden');
    syncSkipButtons();
    $('grade-random').classList.add('hidden');
    $('grade-srs').classList.add('hidden');
    $('deck-label').textContent = await renderCardInto($('card-host'), card, false);
    window.scrollTo({ top: 0 });
  }

  async function nextCard() {
    if (learnOnly()) return nextLearnCard();
    let card = null;
    const last = session.card ? session.card.key : null;
    if (session.repeat.length && session.done >= session.required - session.repeat.length) {
      if (session.repeat[0].key === last) {
        // Nie dieselbe Karte direkt nochmal: erst eine andere Karte dazwischen
        card = await pickCard(session.seen);
        if (card) session.required++;
        else card = session.repeat.shift();
      } else {
        card = session.repeat.shift();
      }
    }
    if (!card) card = await pickCard(session.seen);
    if (!card && session.repeat.length && session.repeat[0].key !== last) card = session.repeat.shift();
    if (!card) { // alle Karten in dieser Runde gesehen
      session.seen.clear();
      card = await pickCard(new Set(last ? [last] : []));
      if (card) session.seen.add(card.key);
    }
    if (!card && session.repeat.length) card = session.repeat.shift();
    if (!card) { finishSession(); return; }
    session.card = card;
    session.seen.add(card.key);
    session.revealed = false;
    updateProgress();
    $('btn-show').classList.remove('hidden');
    syncSkipButtons();
    $('grade-random').classList.add('hidden');
    $('grade-srs').classList.add('hidden');
    $('deck-label').textContent = await renderCardInto($('card-host'), card, false);
    window.scrollTo({ top: 0 });
  }

  function syncSkipButtons() {
    $('btn-skip').classList.toggle('hidden', !settings.skipEnabled);
    $('btn-skip-once').classList.toggle('hidden', !settings.skipOnceEnabled);
    $('skip-bar').classList.toggle('hidden', !settings.skipEnabled && !settings.skipOnceEnabled);
  }

  function skipCard(permanent) {
    if (!session || !session.card) return;
    const key = session.card.key;
    session.repeat = session.repeat.filter((c) => c.key !== key);
    if (permanent) {
      const sk = LS.get('skipped', []);
      if (!sk.includes(key)) { sk.push(key); LS.set('skipped', sk); }
      toast('Zurückgestellt. Unter „Einstellungen“ kannst du sie zurückholen.');
    } else {
      toast('Übersprungen');
    }
    if (!selectedCards().length) { session = null; showLearn(); return; }
    nextCard();
  }

  function updateProgress() {
    if (learnOnly()) {
      $('progress-text').textContent = session.done ? `${session.done} gelernt` : 'Los geht\'s';
      $('penalty-text').classList.add('hidden');
      return;
    }
    $('progress-text').textContent = `Karte ${Math.min(session.done + 1, session.required)} von ${session.required}`;
    const p = [];
    if (session.wrong) p.push(`${session.wrong} nicht gewusst`);
    if (session.factor < 1) p.push(`Zeit ×${session.factor}`);
    $('penalty-text').textContent = p.join(' · ');
    $('penalty-text').classList.toggle('hidden', !p.length);
  }

  async function reveal() {
    if (!session || session.revealed) return;
    session.revealed = true;
    await renderCardInto($('card-host'), session.card, true);
    $('btn-show').classList.add('hidden');
    if (settings.mode === 'srs') {
      const s = await getOne('sched', session.card.key);
      for (const g of [1, 2, 3, 4]) $('lbl-' + g).textContent = fmtIvl(s, g);
      $('grade-srs').classList.remove('hidden');
    } else {
      $('grade-random').classList.remove('hidden');
    }
  }

  async function grade(g) {
    if (!session || !session.revealed) return;
    const card = session.card;
    session.revealed = false;
    if (settings.mode === 'srs') {
      const prev = await getOne('sched', card.key);
      if (!prev) {
        const nc = LS.get('newCount', {});
        LS.set('newCount', { day: todayKey(), n: (nc.day === todayKey() ? nc.n : 0) + 1 });
      }
      await putMany('sched', [Object.assign({ key: card.key }, nextState(prev, g))]);
    } else {
      const recent = LS.get('recent', []);
      recent.unshift(card.key);
      const keep = Math.min(50, Math.floor(selectedCards().length / 2));
      LS.set('recent', recent.slice(0, keep));
    }
    session.done++;
    if (learnOnly()) { nextCard(); return; }
    if (g === 1) {
      session.wrong++;
      if (settings.penHalve) session.factor = session.factor / 2;
      if (settings.penExtra && session.extra < 5) { session.extra++; session.required++; }
      if (settings.penRepeat) { session.required++; session.repeat.push(card); }
    }
    if (session.done >= session.required) finishSession();
    else nextCard();
  }

  function finishSession() {
    const minutes = Math.max(1, Math.round(settings.interval * session.factor));
    const wasVoluntary = session.voluntary && unlockUntil() > Date.now();
    if (!wasVoluntary) LS.set('unlockUntil', Date.now() + minutes * MIN);
    const wrong = session.wrong;
    session = null;
    toast(wasVoluntary ? 'Gut gelernt!' : (wrong ? `Frei für ${minutes} min (${wrong} nicht gewusst)` : `Frei für ${minutes} min`));
    showLearn();
    if (settings.useShortcut && !wasVoluntary) setTimeout(runShortcut, 400);
  }

  // ---------- Deck-Ansicht ----------
  function renderDecks() {
    const tree = $('deck-tree');
    if (!allDecks.length) { tree.innerHTML = '<p class="muted">Noch nichts importiert.</p>'; $('selected-count').textContent = ''; renderImports(); return; }
    const counts = new Map();
    for (const c of allCards) counts.set(c.did, (counts.get(c.did) || 0) + 1);
    const total = (d) => allDecks.filter((x) => x.importId === d.importId && (x.name === d.name || x.name.startsWith(d.name + '::')))
      .reduce((s, x) => s + (counts.get(x.key) || 0), 0);
    const sel = new Set(LS.get('selectedDecks', []));
    const decks = allDecks.filter((d) => total(d) > 0).sort((a, b) => a.importId.localeCompare(b.importId) || a.name.localeCompare(b.name, 'de', { numeric: true }));

    const build = (parentName, importId, depth) => {
      const kids = decks.filter((d) => d.importId === importId && (depth === 0 ? !d.name.includes('::') : d.name.startsWith(parentName + '::') && d.name.split('::').length === depth + 1));
      if (!kids.length) return '';
      return '<ul>' + kids.map((d) => {
        const label = d.name.split('::').pop();
        return `<li><label><input type="checkbox" data-key="${d.key}" ${sel.has(d.key) ? 'checked' : ''}><span class="name">${escapeHtml(label)}</span><span class="count">${total(d)}</span></label>${build(d.name, importId, depth + 1)}</li>`;
      }).join('') + '</ul>';
    };
    tree.innerHTML = [...new Set(decks.map((d) => d.importId))].map((imp) => build('', imp, 0)).join('');
    // Unterdecks eines ausgewählten Decks sind automatisch mit drin
    tree.querySelectorAll('li').forEach((li) => {
      const cb = li.querySelector(':scope > label > input');
      if (cb.checked) li.querySelectorAll(':scope ul input').forEach((x) => { x.checked = true; x.disabled = true; });
    });
    const n = selectedCards().length;
    $('selected-count').textContent = n ? `${n} Karten ausgewählt` : 'Keine Karten ausgewählt';
    const skippedHere = selectedCards(true).length - n;
    if (skippedHere) $('selected-count').textContent += ` (${skippedHere} übersprungen)`;
    renderImports();
  }

  let skippedThumbs = [];
  async function renderSkipped() {
    const box = $('skipped-list');
    skippedThumbs.forEach((u) => URL.revokeObjectURL(u)); skippedThumbs = [];
    const cardByKey = new Map(allCards.map((c) => [c.key, c]));
    const keys = LS.get('skipped', []).filter((k) => cardByKey.has(k));
    if (!keys.length) { box.innerHTML = '<p class="muted">Keine übersprungenen Karten.</p>'; return; }
    const deckName = new Map(allDecks.map((d) => [d.key, d.name]));
    const groups = new Map();
    for (const k of keys) {
      const c = cardByKey.get(k);
      const note = await getOne('notes', c.nid);
      const preview = note ? note.flds.map((f) => stripHtml(f).replace(/\s+/g, ' ').trim()).find((t) => t && !/^[0-9a-f]{32}-ao-\d+$/.test(t)) : '';
      const name = deckName.get(c.did) || 'Unbekanntes Deck';
      if (!groups.has(name)) groups.set(name, []);
      let thumb = '';
      if (!preview && note) {
        const m = note.flds.join(' ').match(/<img[^>]+src=["']?([^"' >]+)/i);
        if (m) {
          let n = m[1]; try { n = decodeURIComponent(n); } catch { /* keep */ }
          const media = await getOne('media', c.importId + '/' + n);
          if (media) { thumb = URL.createObjectURL(media.blob); skippedThumbs.push(thumb); }
        }
      }
      groups.get(name).push({ key: k, thumb, text: preview ? (preview.length > 90 ? preview.slice(0, 90) + ' …' : preview) : '(Bildkarte)' });
    }
    const short = (n) => n.split('::').slice(-2).join(' › ');
    box.innerHTML = `<div class="skipped-head"><span>${keys.length} Karte${keys.length === 1 ? '' : 'n'} übersprungen</span><button class="btn secondary" data-restore="*">Alle zurückholen</button></div>` +
      [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de', { numeric: true })).map(([name, items]) =>
        `<div class="skipped-deck"><h3>${escapeHtml(short(name))}</h3>` + items.map((it) =>
          `<div class="skipped-row">${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : ''}<span>${escapeHtml(it.text)}</span><button class="btn secondary" data-restore="${it.key}">Zurückholen</button></div>`).join('') + '</div>').join('');
  }

  function renderImports() {
    const p = $('imports-panel');
    if (!allImports.length) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    p.innerHTML = '<h2>Importierte Dateien</h2>' + allImports.map((i) =>
      `<div class="import-row"><div><b>${escapeHtml(i.name)}</b><br><span class="muted">${i.cards} Karten · ${i.media} Medien</span></div><button class="btn danger" data-del="${i.id}">Löschen</button></div>`).join('');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- UI ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function showView(name) {
    if (name === 'setup' && learnOnly()) name = 'learn';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    LS.set('view', name);
    if (settings.autoHideNav) setNav(false);
    if (name === 'learn') showLearn();
    if (name === 'decks') renderDecks();
    if (name === 'settings') renderSkipped();
    if (name === 'setup') {
      document.querySelectorAll('.js-useshortcut').forEach((cb) => { cb.checked = settings.useShortcut; });
      document.querySelectorAll('.js-interval').forEach((e) => { e.textContent = settings.interval; });
    }
  }

  function bindSettings() {
    const num = (id, key, min, max) => {
      const el = $(id); el.value = settings[key];
      el.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, parseInt(el.value, 10) || DEFAULTS[key]));
        el.value = v; settings[key] = v; saveSettings();
      });
    };
    num('set-interval', 'interval', 1, 600);
    num('set-cards', 'cards', 1, 20);
    num('set-newperday', 'newPerDay', 0, 500);
    const range = (id, key, out, fmt) => {
      const el = $(id); el.value = settings[key]; $(out).textContent = fmt(settings[key]);
      el.addEventListener('input', () => { settings[key] = Number(el.value); $(out).textContent = fmt(settings[key]); saveSettings(); applyDisplay(); });
    };
    range('set-cardscale', 'cardScale', 'out-cardscale', (v) => v + ' %');
    range('set-imgmax', 'imgMax', 'out-imgmax', (v) => v + ' % der Bildschirmhöhe');
    const disp = (id, key) => { const el = $(id); el.checked = settings[key]; el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); applyDisplay(); }); };
    disp('set-hidetitle', 'hideTitle'); disp('set-autohidenav', 'autoHideNav');
    const am = $('set-appmode'); am.value = settings.appMode;
    am.addEventListener('change', () => setAppMode(am.value));
    const mode = $('set-mode'); mode.value = settings.mode;
    const syncSrs = () => document.querySelectorAll('.srs-only').forEach((e) => e.classList.toggle('hidden', settings.mode !== 'srs'));
    mode.addEventListener('change', () => { settings.mode = mode.value; saveSettings(); syncSrs(); });
    const skip = $('set-skip'); skip.checked = settings.skipEnabled;
    skip.addEventListener('change', () => { settings.skipEnabled = skip.checked; saveSettings(); });
    const skipOnce = $('set-skip-once'); skipOnce.checked = settings.skipOnceEnabled;
    skipOnce.addEventListener('change', () => { settings.skipOnceEnabled = skipOnce.checked; saveSettings(); });
    syncSrs();
    const chk = (id, key) => { const el = $(id); el.checked = settings[key]; el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); }); };
    chk('pen-halve', 'penHalve'); chk('pen-extra', 'penExtra'); chk('pen-repeat', 'penRepeat'); chk('set-useshortcut', 'useShortcut');
    const sn = $('set-shortcutname'); sn.value = settings.shortcutName;
    sn.addEventListener('change', () => { settings.shortcutName = sn.value.trim() || DEFAULTS.shortcutName; sn.value = settings.shortcutName; saveSettings(); });

    $('btn-reset-unlock').addEventListener('click', () => { LS.set('unlockUntil', 0); toast('Sperre ist aktiv'); });
    $('btn-reset-srs').addEventListener('click', async () => {
      const d = await db(); const tx = d.transaction('sched', 'readwrite'); tx.objectStore('sched').clear(); await txDone(tx);
      LS.set('newCount', {}); LS.set('recent', []); toast('Lernfortschritt zurückgesetzt');
    });
  }

  function setAppMode(m) {
    settings.appMode = m === 'learn' ? 'learn' : 'lock';
    settings.appModeChosen = true;
    saveSettings();
    $('set-appmode').value = settings.appMode;
    applyAppMode();
    session = null;
    if ($('view-learn').classList.contains('active')) showLearn();
  }
  function applyAppMode() {
    document.body.classList.toggle('mode-learn', learnOnly());
    document.querySelectorAll('[data-appmode]').forEach((b) => b.classList.toggle('selected', b.dataset.appmode === settings.appMode));
    if (learnOnly() && $('view-setup').classList.contains('active')) showView('learn');
  }

  function applyDisplay() {
    const scale = settings.cardScale / 100;
    document.documentElement.style.setProperty('--card-scale', scale);
    document.documentElement.style.setProperty('--img-max', (settings.imgMax / scale).toFixed(1) + 'vh');
    document.body.classList.toggle('hide-title', settings.hideTitle);
    document.body.classList.toggle('autohide', settings.autoHideNav);
    setNav(!settings.autoHideNav);
  }
  let navShown = true;
  function setNav(show) {
    navShown = show;
    document.body.classList.toggle('nav-hidden', settings.autoHideNav && !show);
  }
  function initNavGestures() {
    let startY = null;
    document.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!settings.autoHideNav || startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 50 && window.scrollY <= 0 && !navShown) { setNav(true); startY = null; }
      else if (dy < -40 && navShown) { setNav(false); startY = null; }
    }, { passive: true });
    $('nav-handle').addEventListener('click', () => setNav(true));
  }

  const SHORTCUT_LINKS = {
    // Neue iCloud-Links für die umbenannten Kurzbefehle hier eintragen (null = Selbstbau-Anleitung zeigen)
    fertig: 'https://www.icloud.com/shortcuts/0a2285c888ce40c49a169575b157a958', // „LernSperre UNLOCK“
    sperre: 'https://www.icloud.com/shortcuts/3b976990f0be43fe8fd3288500d8bf36', // „LernSperre LOCK“
  };

  async function doImport(file, st) {
    st.classList.remove('hidden', 'error');
    try {
      const r = await importApkg(file, (m) => { st.textContent = m; });
      st.textContent = `✓ ${r.cards} Karten und ${r.media} Bilder importiert.`;
      await loadData(); renderDecks();
      return true;
    } catch (err) {
      console.error(err);
      st.classList.add('error');
      st.textContent = 'Import fehlgeschlagen: ' + (err && err.message ? err.message : err);
      return false;
    }
  }

  // ---------- Einführung ----------
  let obStep = 0; // Index in obSteps()
  const obSteps = () => (learnOnly() ? [0, 1, 4] : [0, 1, 2, 3, 4]);
  function showOnboarding(step) {
    obStep = step || 0;
    // Erster Besuch ohne iPhone/iPad: „Nur lernen“ vorschlagen
    if (!settings.appModeChosen && !isAppleMobile()) { settings.appMode = 'learn'; saveSettings(); $('set-appmode').value = 'learn'; applyAppMode(); }
    $('onboarding').classList.remove('hidden');
    document.body.classList.add('ob-open');
    renderOnboarding();
  }
  function closeOnboarding(goLearn) {
    $('onboarding').classList.add('hidden');
    document.body.classList.remove('ob-open');
    LS.set('onboarded', true);
    if (goLearn) { LS.set('unlockUntil', 0); showView(allCards.length ? 'learn' : 'decks'); }
  }
  function renderOnboarding() {
    const steps = obSteps(); const OB_STEPS = steps.length;
    if (obStep >= OB_STEPS) obStep = OB_STEPS - 1;
    document.querySelectorAll('.ob-step').forEach((sec) => sec.classList.toggle('active', Number(sec.dataset.ob) === steps[obStep]));
    $('ob-dots').innerHTML = Array.from({ length: OB_STEPS }, (_, i) => `<span class="${i === obStep ? 'on' : i < obStep ? 'done' : ''}"></span>`).join('');
    $('ob-back').style.visibility = obStep === 0 ? 'hidden' : 'visible';
    $('ob-skip').style.visibility = obStep === OB_STEPS - 1 ? 'hidden' : 'visible';
    const next = $('ob-next');
    next.textContent = obStep === 0 ? 'Los geht\'s' : obStep === OB_STEPS - 1 ? 'Los geht\'s' : 'Weiter';
    if (obStep === 1) {
      const st = $('ob-import-status');
      if (allCards.length && st.classList.contains('hidden')) { st.classList.remove('hidden', 'error'); st.textContent = `✓ Du hast schon ${allCards.length} Karten importiert. Du kannst weitere hinzufügen oder weitergehen.`; }
      next.textContent = allCards.length ? 'Weiter' : 'Später';
    }
    document.querySelectorAll('.js-useshortcut').forEach((cb) => { cb.checked = settings.useShortcut; });
    $('onboarding').querySelector('.ob-card').scrollTop = 0;
  }
  const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function initOnboarding() {
    document.querySelectorAll('.ob-not-ios').forEach((e) => e.classList.toggle('hidden', isAppleMobile()));
    $('ob-next').addEventListener('click', () => {
      if (obStep >= obSteps().length - 1) { closeOnboarding(true); return; }
      obStep++; renderOnboarding();
    });
    $('ob-back').addEventListener('click', () => { if (obStep > 0) { obStep--; renderOnboarding(); } });
    $('ob-skip').addEventListener('click', () => closeOnboarding(false));
    document.querySelectorAll('[data-appmode]').forEach((b) => b.addEventListener('click', () => { setAppMode(b.dataset.appmode); renderOnboarding(); }));
    $('ob-file').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (await doImport(file, $('ob-import-status'))) renderOnboarding();
      e.target.value = '';
    });
    // Wer „LernSperre UNLOCK“ installiert, will es nach dem Lernen auch automatisch starten
    document.querySelectorAll('#onboarding [data-install="fertig"]').forEach((a) => a.addEventListener('click', () => {
      settings.useShortcut = true; saveSettings(); $('set-useshortcut').checked = true;
      document.querySelectorAll('.js-useshortcut').forEach((cb) => { cb.checked = true; });
    }));
    $('btn-show-intro').addEventListener('click', () => showOnboarding(0));
  }

  function initSetup() {
    const haveLinks = SHORTCUT_LINKS.fertig && SHORTCUT_LINKS.sperre;
    document.querySelectorAll('[data-install]').forEach((a) => {
      if (SHORTCUT_LINKS[a.dataset.install]) a.href = SHORTCUT_LINKS[a.dataset.install];
      else a.classList.add('hidden');
    });
    document.querySelectorAll('.install-box').forEach((b) => b.classList.toggle('hidden', !haveLinks));
    document.querySelectorAll('details.diy').forEach((d) => { if (!haveLinks) d.open = true; });
    document.querySelectorAll('.ob-no-links').forEach((n) => n.classList.toggle('hidden', !!haveLinks));
    document.querySelectorAll('[data-goto-close]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); closeOnboarding(false); showView(a.dataset.gotoClose);
    }));
    const url = location.origin + location.pathname;
    document.querySelectorAll('.js-setup-url-short').forEach((e) => { e.textContent = url.replace(/^https?:\/\//, ''); });
    document.querySelectorAll('.js-interval').forEach((e) => { e.textContent = settings.interval; });
    document.querySelectorAll('.js-copy-url').forEach((b) => { b.dataset.copy = url; });
    document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Kopiert: ' + b.dataset.copy); }
      catch { toast(b.dataset.copy); }
    }));
    document.querySelectorAll('.js-lock-now').forEach((b) => b.addEventListener('click', () => { LS.set('unlockUntil', 0); toast('Sperre ist aktiv'); }));
    document.querySelectorAll('.js-test-fertig').forEach((b) => b.addEventListener('click', () => {
      const until = Math.max(unlockUntil(), Date.now());
      window.location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(settings.shortcutName) +
        '&input=text&text=' + encodeURIComponent(shortcutDate(until));
    }));
    document.querySelectorAll('.js-useshortcut').forEach((cb) => {
      cb.checked = settings.useShortcut;
      cb.addEventListener('change', () => { settings.useShortcut = cb.checked; saveSettings(); $('set-useshortcut').checked = cb.checked; });
    });
    const steps = [...document.querySelectorAll('.step')];
    const syncSteps = () => {
      const done = LS.get('setupDone', []);
      let opened = false;
      steps.forEach((st) => {
        const isDone = done.includes(st.dataset.step);
        st.classList.toggle('done', isDone);
        if (!isDone && !opened) { st.open = true; opened = true; }
      });
    };
    document.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', () => {
      const done = new Set(LS.get('setupDone', [])); done.add(b.dataset.done); LS.set('setupDone', [...done]);
      const st = b.closest('.step'); st.open = false;
      syncSteps();
      const next = st.nextElementSibling;
      if (next && next.classList.contains('step')) next.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    steps.forEach((st) => st.querySelector('summary').addEventListener('dblclick', () => {
      LS.set('setupDone', LS.get('setupDone', []).filter((x) => x !== st.dataset.step)); syncSteps();
    }));
    syncSteps();
  }

  async function init() {
    applyDisplay();
    applyAppMode();
    initNavGestures();
    initSetup();
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { e.preventDefault(); showView(g.dataset.goto); }
    });
    $('btn-show').addEventListener('click', reveal);
    $('btn-skip').addEventListener('click', () => skipCard(true));
    $('btn-skip-once').addEventListener('click', () => skipCard(false));
    $('skipped-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-restore]'); if (!b) return;
      const key = b.dataset.restore;
      LS.set('skipped', key === '*' ? [] : LS.get('skipped', []).filter((k) => k !== key));
      toast(key === '*' ? 'Alle Karten sind wieder dabei' : 'Karte ist wieder dabei');
      renderSkipped();
    });
    document.querySelectorAll('[data-grade]').forEach((b) => b.addEventListener('click', () => grade(Number(b.dataset.grade))));
    $('card-host').addEventListener('click', reveal);
    $('btn-learn-anyway').addEventListener('click', () => startSession(true));
    $('btn-learn-ahead').addEventListener('click', () => startSession(true, true));
    $('btn-run-shortcut').addEventListener('click', runShortcut);

    $('deck-tree').addEventListener('change', (e) => {
      const key = e.target.dataset.key; if (!key) return;
      const sel = new Set(LS.get('selectedDecks', []));
      if (e.target.checked) sel.add(key); else sel.delete(key);
      LS.set('selectedDecks', [...sel]);
      renderDecks();
    });
    $('imports-panel').addEventListener('click', async (e) => {
      const id = e.target.dataset && e.target.dataset.del; if (!id) return;
      for (const s of ['decks', 'notetypes', 'notes', 'cards', 'media']) await deleteByImport(s, id);
      const d = await db(); const tx = d.transaction('imports', 'readwrite'); tx.objectStore('imports').delete(id); await txDone(tx);
      LS.set('selectedDecks', LS.get('selectedDecks', []).filter((k) => !k.startsWith(id + ':')));
      await loadData(); renderDecks(); toast('Gelöscht');
    });

    $('file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      await doImport(file, $('import-status'));
      e.target.value = '';
    });

    bindSettings();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await loadData();
    const startView = allCards.length ? 'learn' : 'decks';
    showView(startView);
    initOnboarding();
    if (!LS.get('onboarded', false)) showOnboarding(0);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && $('view-learn').classList.contains('active') && !session) showLearn();
    });
  }

  init().catch((e) => { console.error(e); toast('Fehler beim Start: ' + e.message); });
})();
