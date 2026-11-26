import * as pdf from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {readSheet} from 'read-excel-file/browser';
import {
  accessoriesFor, catalogueFromRows, compareRevision, exclusionTerms, extractRows, extractScheduleRows, list, matchItem, normalize,
  packs, parseTitleBlock, quoteCsv, quoteLines, readCatalogue, reconcile,
} from './takeoff.js';
import {findSymbol, labelSchedule, legendTemplates, pairLabels, pathPrimitives, poleLabels} from './symbols.js';
import {MARK_STYLES, drawKey, drawMarkup, keySize} from './markup.js';
import './style.css';

pdf.GlobalWorkerOptions.workerSrc = worker;
const byId = id => document.getElementById(id);

const pages = [];
let rows = [];
let currentPage;
let currentRow;
let loading = false;
let scanning = false;
let filter = 'all';
let zoom = 1;
let nextRowId = 1;
let health = {ai: false};
let library = {itemList: {fileName: '', uploadedAt: '', items: []}, aliases: {}, exclusions: [], corrections: []};
let catalogue = [];
let serverLibrary = true;

/* ------------------------------------------------------------- helpers */

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

const status = message => { byId('status').textContent = message; };

let passcode = '';
try { passcode = localStorage.getItem('plasgain-passcode') || ''; } catch { /* storage unavailable */ }

async function api(method, url, data, retry = true) {
  const headers = {...(data ? {'content-type': 'application/json'} : {}), ...(passcode ? {'x-app-passcode': passcode} : {})};
  const response = await fetch(url, {method, headers, body: data ? JSON.stringify(data) : undefined});
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 && retry) {
    const entered = window.prompt('Enter the Plasgain takeoff passcode');
    if (entered) {
      passcode = entered.trim();
      try { localStorage.setItem('plasgain-passcode', passcode); } catch { /* keep for this session only */ }
      return api(method, url, data, true);
    }
  }
  if (response.status === 413) throw new Error('Page images were too large to send');
  if (!response.ok) throw new Error(json.error || 'Request failed (' + response.status + ')');
  return json;
}

function syncButtons() {
  const busy = loading || scanning;
  byId('scan').disabled = busy || !pages.some(page => page.selected);
  byId('select-all').disabled = busy || !pages.length;
  byId('select-none').disabled = busy || !pages.length;
  byId('add').disabled = busy || !currentPage;
  byId('export').disabled = busy || !quoteLines(rows, catalogue, pages).length;
  byId('export-detail').disabled = busy || !rows.length;
  byId('download-markup').disabled = busy || !currentPage;
}

/* ------------------------------------------------------ shared library */

function localLibrary() {
  try { return JSON.parse(localStorage.getItem('plasgain-library') || 'null'); } catch { return null; }
}

async function loadLibrary() {
  try {
    library = await api('GET', '/api/library');
  } catch {
    serverLibrary = false;
    library = {...library, ...(localLibrary() || {})};
  }
  catalogue = library.itemList.items || [];
  renderLibrary();
}

async function saveLibrary(path, data, change) {
  change(library);
  if (serverLibrary) {
    try { library = await api(path.startsWith('POST') ? 'POST' : 'PUT', path.replace(/^POST /, ''), data); }
    catch (error) { status('Could not save to the shared library. ' + error.message); }
  } else {
    try { localStorage.setItem('plasgain-library', JSON.stringify(library)); } catch { status('Library could not be saved in this browser.'); }
  }
  catalogue = library.itemList.items || [];
  renderLibrary();
}

function renderLibrary() {
  const {itemList, aliases, exclusions, corrections} = library;
  byId('catalogue-status').textContent = itemList.items.length ?
    itemList.items.length + ' active SKUs from ' + (itemList.fileName || 'Item List') +
      (itemList.uploadedAt ? ', uploaded ' + new Date(itemList.uploadedAt).toLocaleDateString('en-AU') : '') :
    'Required for SKU matching';
  byId('library-summary').textContent = Object.keys(aliases).length + ' aliases · ' + exclusions.length + ' exclusion rules · ' +
    corrections.length + ' logged corrections' + (serverLibrary ? ' · shared with the team' : ' · saved in this browser only');
  const box = byId('aliases');
  box.replaceChildren();
  const entries = Object.entries(aliases).sort();
  if (!entries.length) box.append(element('p', 'No saved aliases yet.', 'hint'));
  for (const [label, sku] of entries) {
    const line = element('div', null, 'alias');
    const remove = element('button', 'Remove', 'secondary small');
    remove.onclick = () => {
      const next = {...library.aliases};
      delete next[label];
      saveLibrary('/api/library/aliases', {aliases: next}, data => { data.aliases = next; }).then(rematchAll);
    };
    line.append(element('span', label), element('b', '→ ' + sku), remove);
    box.append(line);
  }
  if (document.activeElement !== byId('exclusions')) byId('exclusions').value = exclusions.join('\n');
  byId('corrections-count').textContent = corrections.length + ' corrections logged.';
}

byId('save-exclusions').onclick = () => {
  const exclusions = list(byId('exclusions').value);
  saveLibrary('/api/library/exclusions', {exclusions}, data => { data.exclusions = exclusions; }).then(() => {
    rematchAll();
    status('Exclusion rules saved.');
  });
};

byId('export-corrections').onclick = () => {
  const data = [['When', 'Drawing wording', 'Description', 'Auto-matched SKU', 'Chosen SKU', 'PDF', 'Page']];
  for (const entry of library.corrections) data.push([entry.at, entry.text, entry.description, entry.fromSku, entry.toSku, entry.file, entry.page]);
  download('plasgain-sku-corrections.csv', quoteCsv(data));
};

byId('catalogue').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const items = /\.xlsx$/i.test(file.name) ? catalogueFromRows(await readSheet(file)) : readCatalogue(await file.text());
    if (!items.length) throw new Error('No Active items found in ' + file.name + '.');
    await saveLibrary('/api/library/item-list', {fileName: file.name, items}, data => {
      data.itemList = {fileName: file.name, uploadedAt: new Date().toISOString(), items};
    });
    rematchAll();
    status(items.length + ' active SKUs loaded from ' + file.name + '. Existing rows were re-matched and need verifying again.');
  } catch (error) {
    status(error.message);
  }
};

byId('ostendo-sync').onclick = async event => {
  event.preventDefault();
  const button = byId('ostendo-sync');
  button.disabled = true;
  status('Reading the Item List from Ostendo. This can take up to a minute…');
  try {
    const result = await api('POST', '/api/library/item-list/ostendo');
    const {sync, ...rest} = result;
    library = rest;
    catalogue = library.itemList.items || [];
    renderLibrary();
    rematchAll();
    status(sync.count + ' active SKUs synced from Ostendo (' + sync.read + ' items read, ' + sync.inactive + ' inactive skipped; ' +
      sync.statusRule + '). Drawing aliases, packs and accessories from the previous list were kept by SKU. Existing rows were re-matched.');
  } catch (error) {
    status('Ostendo sync failed. ' + error.message);
  } finally {
    button.disabled = false;
  }
};

/* ------------------------------------------------------------- AI status */

async function loadHealth() {
  try {
    health = await api('GET', '/api/health');
  } catch {
    health = {ai: false, offline: true};
  }
  byId('ai-status').textContent = health.ai ? 'AI reader on (' + health.model + ')' :
    health.offline ? 'Server not running: text-only reading' : 'AI reader off: set GEMINI_API_KEY';
  byId('ai-status').classList.toggle('on', !!health.ai);
  byId('ostendo-sync').hidden = !health.ostendo;
  if (health.storage === 'temporary') {
    status('Shared storage is not connected (Firebase settings missing), so Item List uploads, aliases and corrections will not be kept.');
  }
}

/* ------------------------------------------------------------ PDF pages */

async function renderPage(page, canvas, width) {
  const initial = page.pdf.getViewport({scale: 1});
  const viewport = page.pdf.getViewport({scale: width / initial.width});
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.pdf.render({canvas, viewport}).promise;
  return viewport;
}

async function showPage(page, row) {
  currentPage = page;
  currentRow = row;
  byId('page-title').textContent = page.file + ' · p' + page.number + (page.meta.drawingNumber ? ' · ' + page.meta.drawingNumber : '');
  const canvas = element('canvas');
  const figure = element('figure');
  figure.style.width = (zoom * 100) + '%';
  figure.append(canvas);
  byId('viewer').replaceChildren(figure);
  syncButtons();
  try {
    const viewport = await renderPage(page, canvas, 1800 * Math.min(zoom, 2.5));
    const markup = pageMarkup(page);
    drawMarkup(canvas.getContext('2d'), viewport, markup);
    if ((markup.groups.length || markup.labels.length) && figure.isConnected) {
      const key = element('canvas', null, 'markup-key');
      const size = keySize(key.getContext('2d'), markup, 1.4);
      key.width = size.width + size.margin;
      key.height = size.height + size.margin;
      drawKey(key.getContext('2d'), markup, 1.4, 0, 0);
      byId('viewer').prepend(key);
    }
    const points = row?.points?.length ? row.points : row?.point ? [row.point] : [];
    points.forEach((point, index) => {
      const [x, y] = viewport.convertToViewportPoint(...point);
      const marker = element('span', '', 'marker' + (row.approximate ? ' approximate' : ''));
      marker.title = (row.approximate ? 'Approximate location: ' : '') + row.text + (points.length > 1 ? ' (' + (index + 1) + ' of ' + points.length + ')' : '');
      marker.style.left = (x / viewport.width * 100) + '%';
      marker.style.top = (y / viewport.height * 100) + '%';
      figure.append(marker);
      if (index === 0 && figure.isConnected) marker.scrollIntoView({block: 'center', inline: 'center'});
    });
  } catch (error) {
    if (figure.isConnected) figure.replaceChildren(element('p', 'Page could not be rendered. ' + error.message));
  }
}

// What to mark on a sheet: the counted lights, one style per light type (the
// same style on every sheet), and the pole labels paired with them.
function pageMarkup(page) {
  const counted = rows.filter(row => row.source === 'counted' && row.points?.length && !row.excluded);
  const types = [...new Set(counted.filter(row => row.description === row.text.split(' / ')[0]).map(row => row.description))];
  const groups = counted.filter(row => row.pageId === page.id && row.description === row.text.split(' / ')[0]).map(row => ({
    name: row.description, points: row.points, style: MARK_STYLES[types.indexOf(row.description) % MARK_STYLES.length],
    pole: counted.find(other => other.pageId === page.id && other.text.endsWith('(for ' + row.description + ')'))?.description || ''}));
  const labels = page.vectors?.labels?.length ? pairLabels(page.vectors.labels, groups.flatMap(group => group.points)) : [];
  const title = [page.meta.drawingNumber || page.file, 'p' + page.number, page.meta.revision ? 'Rev ' + page.meta.revision : ''].filter(Boolean).join(' · ');
  return {title, groups, labels, schedule: page.vectors?.schedule};
}

byId('download-markup').onclick = async () => {
  const page = currentPage;
  if (!page) return;
  const button = byId('download-markup');
  button.disabled = true;
  try {
    // The sheet with its markup, under a band that holds the key.
    const sheet = element('canvas');
    const viewport = await renderPage(page, sheet, 4200);
    const markup = pageMarkup(page);
    drawMarkup(sheet.getContext('2d'), viewport, markup);
    const canvas = element('canvas');
    const scale = sheet.width / 2000;
    const key = keySize(canvas.getContext('2d'), markup, scale);
    canvas.width = sheet.width;
    canvas.height = sheet.height + key.height + key.margin * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawKey(ctx, markup, scale, key.margin, key.margin);
    ctx.drawImage(sheet, 0, key.height + key.margin * 2);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const link = element('a');
    link.href = URL.createObjectURL(blob);
    link.download = (page.meta.drawingNumber || page.file.replace(/\.pdf$/i, '')) + '-p' + page.number + '-marked.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  } catch (error) {
    status('Could not make the marked-up image. ' + error.message);
  } finally {
    button.disabled = false;
    syncButtons();
  }
};

for (const [id, factor] of [['zoom-in', 1.5], ['zoom-out', 1 / 1.5]]) {
  byId(id).onclick = () => {
    zoom = Math.min(4, Math.max(1, zoom * factor));
    if (currentPage) showPage(currentPage, currentRow);
  };
}

// Group the text layer into lines (for reading and for checking AI quotes)
// and into cells split at large horizontal gaps (for schedule tables).
async function readLines(page) {
  const {items} = await page.pdf.getTextContent();
  const pieces = items.filter(item => item.str?.trim()).map(item => ({
    text: item.str.trim(), x: item.transform[4], y: item.transform[5],
    w: item.width || 0, h: Math.abs(item.transform[3]) || Math.abs(item.height) || 8,
  }));
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const piece of pieces) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - piece.y) <= Math.max(2, piece.h * 0.35)) line.pieces.push(piece);
    else lines.push({y: piece.y, pieces: [piece]});
  }
  return lines.map(line => {
    line.pieces.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const piece of line.pieces) {
      const last = cells.at(-1);
      if (last && piece.x - last.end < piece.h * 1.2) { last.text += ' ' + piece.text; last.end = piece.x + piece.w; }
      else cells.push({x: piece.x, text: piece.text, end: piece.x + piece.w});
    }
    return {pageId: page.id, text: cells.map(cell => cell.text).join(' '), point: [line.pieces[0].x, line.y], cells};
  });
}

function titleBlockFromLines(page, lines) {
  const {width, height} = page.pdf.getViewport({scale: 1});
  const corner = lines.filter(line => line.point[0] > width * 0.55 && line.point[1] < height * 0.35).map(line => line.text).join('\n');
  const fromCorner = parseTitleBlock(corner);
  const fromPage = parseTitleBlock(lines.map(line => line.text).join('\n'));
  return Object.fromEntries(Object.keys(fromPage).map(key => [key, fromCorner[key] || fromPage[key]]));
}

function metaField(page, key, label) {
  const input = element('input');
  input.value = page.meta[key] || '';
  input.placeholder = label;
  input.setAttribute('aria-label', label + ' for ' + page.file + ' page ' + page.number);
  input.onchange = () => {
    page.meta[key] = input.value.trim();
    if (rows.length) { reconcile(rows, pages); renderReview(); }
  };
  return input;
}

function addPageCard(page) {
  const card = element('div', null, 'sheet');
  const open = element('button', null, 'thumbnail');
  open.setAttribute('aria-label', 'View ' + page.file + ' page ' + page.number);
  const canvas = element('canvas');
  open.append(canvas);
  open.onclick = () => showPage(page);
  const label = element('label');
  const check = element('input');
  check.type = 'checkbox';
  check.checked = page.selected;
  check.onchange = () => { page.selected = check.checked; card.classList.toggle('skipped', !check.checked); syncButtons(); };
  page.checkbox = check;
  label.append(check, element('span', 'Page ' + page.number));
  const meta = element('div', null, 'meta');
  meta.append(metaField(page, 'drawingNumber', 'Drawing no.'), metaField(page, 'revision', 'Rev'), metaField(page, 'status', 'Status'));
  page.card = card;
  card.append(open, label, element('small', page.file), meta);
  byId('pages').append(card);
  return renderPage(page, canvas, 240).catch(() => open.replaceChildren(element('span', 'Preview unavailable')));
}

function refreshPageCard(page) {
  for (const [index, key] of ['drawingNumber', 'revision', 'status'].entries()) {
    page.card.querySelectorAll('.meta input')[index].value = page.meta[key] || '';
  }
}

byId('select-all').onclick = () => setSelection(true);
byId('select-none').onclick = () => setSelection(false);
function setSelection(selected) {
  for (const page of pages) {
    page.selected = selected;
    page.checkbox.checked = selected;
    page.card.classList.toggle('skipped', !selected);
  }
  syncButtons();
}

byId('drawings').onchange = async event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  loading = true;
  event.target.disabled = true;
  syncButtons();
  const failures = [];
  try {
    for (const file of files) {
      status('Loading ' + file.name + '…');
      try {
        const document = await pdf.getDocument({data: await file.arrayBuffer()}).promise;
        for (let number = 1; number <= document.numPages; number++) {
          const page = {id: pages.length, file: file.name, number, selected: true, pdf: await document.getPage(number), meta: {}};
          page.lines = await readLines(page);
          page.meta = titleBlockFromLines(page, page.lines);
          // Cover sheets and pages with only notes usually have no quantities.
          if (/\b(cover sheet|drawing (?:register|schedule|list)|general notes|standard notes|terms and conditions)\b/i.test(page.lines.slice(0, 40).map(line => line.text).join(' ')) &&
              !page.lines.some(line => /\bqty\b|\bquantity\b/i.test(line.text))) page.selected = false;
          if (!pages.length) byId('pages').replaceChildren();
          pages.push(page);
          await addPageCard(page);
          page.card.classList.toggle('skipped', !page.selected);
          if (!byId('project').value && page.meta.project) byId('project').value = page.meta.project;
        }
      } catch (error) {
        failures.push(file.name + ': ' + error.message);
      }
    }
    if (!currentPage && pages.length) void showPage(pages[0]);
    const skipped = pages.filter(page => !page.selected).length;
    status(failures.length ? failures.join(' · ') : pages.length + ' pages loaded.' +
      (skipped ? ' ' + skipped + ' look like cover or notes sheets and were deselected; tick them to include.' : ''));
  } finally {
    event.target.disabled = false;
    loading = false;
    syncButtons();
  }
};

/* ------------------------------------------------------------- reading */

async function canvasData(canvas, quality) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The whole sheet plus four enlarged, overlapping quarters so fine print and
// small dimensions are legible to the AI.
async function pageImages(page, {fullPx, tilePx, quality}) {
  const base = page.pdf.getViewport({scale: 1});
  const long = Math.max(base.width, base.height);
  const full = element('canvas');
  await renderPage(page, full, base.width * fullPx / long);
  const images = [{label: 'Whole sheet', mimeType: 'image/jpeg', data: await canvasData(full, quality)}];
  const big = element('canvas');
  const scale = tilePx / long;
  const viewport = page.pdf.getViewport({scale});
  big.width = Math.ceil(viewport.width);
  big.height = Math.ceil(viewport.height);
  await page.pdf.render({canvas: big, viewport}).promise;
  const overlap = 0.06;
  const names = [['Top left', 0, 0], ['Top right', 0.5 - overlap, 0], ['Bottom left', 0, 0.5 - overlap], ['Bottom right', 0.5 - overlap, 0.5 - overlap]];
  for (const [label, fx, fy] of names) {
    const tile = element('canvas');
    tile.width = Math.ceil(big.width * (0.5 + overlap));
    tile.height = Math.ceil(big.height * (0.5 + overlap));
    tile.getContext('2d').drawImage(big, -big.width * fx, -big.height * fy);
    images.push({label: label + ' quarter (enlarged)', mimeType: 'image/jpeg', data: await canvasData(tile, quality)});
  }
  return images;
}

async function readPageWithAi(page) {
  const {width, height} = page.pdf.getViewport({scale: 1});
  // Vercel accepts request bodies up to about 4.5 MB, so step the image
  // size down until the page fits.
  const lines = page.lines.map(({text, point}) => ({text, point}));
  let images;
  for (const setting of [{fullPx: 2000, tilePx: 3600, quality: 0.85}, {fullPx: 1800, tilePx: 3000, quality: 0.75},
    {fullPx: 1600, tilePx: 2600, quality: 0.65}, {fullPx: 1400, tilePx: 2200, quality: 0.55}]) {
    images = await pageImages(page, setting);
    const size = images.reduce((sum, image) => sum + image.data.length, 0) + JSON.stringify(lines).length;
    if (size < 4_000_000) break;
  }
  const result = await api('POST', '/api/extract', {
    page: {id: page.id, file: page.file, number: page.number, width, height}, images, lines,
  });
  for (const [key, value] of Object.entries(result.titleBlock || {})) if (value) page.meta[key] = value;
  refreshPageCard(page);
  if (!byId('project').value && page.meta.project) byId('project').value = page.meta.project;
  return {rows: result.rows, dropped: result.dropped?.length || 0};
}

function readPageFromText(page) {
  const table = extractScheduleRows(page.lines);
  const tableLines = new Set(table.map(row => row.text));
  return {rows: [...table, ...extractRows(page.lines.filter(line => !tableLines.has(line.text)))], dropped: 0};
}

/* ------------------------------------------------ legend symbol counting */

const LIGHT_OR_POLE = /\b(lantern|luminaire|streetled|street ?light|light(ing)? pole|pole|column|outreach)\b/i;

async function pageVectors(page) {
  if (!page.vectors) {
    const [operators, text] = await Promise.all([page.pdf.getOperatorList(), page.pdf.getTextContent()]);
    const primitives = pathPrimitives(operators, pdf.OPS);
    page.vectors = {primitives, legends: legendTemplates(text.items, primitives), schedule: labelSchedule(text.items), labels: poleLabels(text.items)};
  }
  return page.vectors;
}

// Counts each lighting legend symbol on the selected pages. A page uses its own
// legend, or else the legend from another sheet of the same PDF.
async function countLegendSymbols(selected, notes) {
  const rowsByPage = new Map();
  for (const page of pages) {
    try { await pageVectors(page); } catch { page.vectors = {primitives: [], legends: []}; }
  }
  for (const page of selected) {
    const own = page.vectors.legends;
    const legends = own.length ? own : pages.filter(other => other.file === page.file && other.vectors.legends.length)[0]?.vectors.legends || [];
    const found = [];
    for (const legend of legends) {
      const hits = findSymbol(legend.template, page.vectors.primitives);
      if (!hits.length) continue;
      const points = hits.map(hit => [hit.x, hit.y]);
      const base = {pageId: page.id, point: points[0], points, approximate: false, source: 'counted', location: 'plan',
        locationNote: 'legend symbol', quantity: hits.length, unit: 'ea', baseNote: '', typical: false, extractConfidence: 'Medium',
        extractNote: 'Counted ' + hits.length + ' legend symbols on the sheet (' + (own.length ? 'legend on this sheet' : 'legend from p' +
          pages.find(other => other.vectors.legends === legends)?.number) + '). Check the markers.'};
      found.push({...base, text: legend.label + (legend.pole ? ' / ' + legend.pole : ''), description: legend.label});
      if (legend.pole) found.push({...base, text: legend.pole + ' (for ' + legend.label + ')', description: legend.pole.replace(/^(ON|MOUNTED ON)\s+(A|AN)\s+/i, '')});
    }
    if (found.length) {
      notes.push(page.file + ' p' + page.number + ': ' + found.filter(row => row.description === row.text.split(' / ')[0]).map(row => row.quantity + ' × ' + row.description).join(', '));
    }
    scheduleCheck(page, found, notes);
    if (found.length) rowsByPage.set(page.id, found);
  }
  return rowsByPage;
}

// Cross-checks the symbol count against the sheet's label schedule, where each
// public lighting pole has a row. A small difference is usually a drawing
// error and a large one a reading problem; either way it is flagged, never
// resolved silently. With no symbols found, the schedule gives a pole count.
function scheduleCheck(page, found, notes) {
  const schedule = page.vectors.schedule;
  if (!schedule?.poles) return;
  const lights = found.filter(row => row.description === row.text.split(' / ')[0]);
  const counted = lights.reduce((sum, row) => sum + row.quantity, 0);
  const missing = schedule.missing.length ? ' ' + schedule.missing.join(', ') + (schedule.missing.length > 1 ? ' are' : ' is') +
    ' in the schedule but not labelled on the plan.' : '';
  const where = page.file + ' p' + page.number;
  if (!lights.length) {
    notes.push(where + ': label schedule lists ' + schedule.poles + ' P/L poles but no light symbols were counted, check the sheet');
    found.push({pageId: page.id, point: null, points: [], approximate: true, source: 'schedule', location: 'schedule',
      locationNote: 'label schedule', quantity: schedule.poles, unit: 'ea', baseNote: '', typical: false, extractConfidence: 'Low',
      text: 'LABEL SCHEDULE: ' + schedule.poles + ' × P/L POLE', description: 'Public lighting pole (P/L POLE)',
      extractNote: 'From the label schedule only: no light symbols were counted on this sheet, so the light and pole types are not known.' + missing});
    return;
  }
  const summary = 'Label schedule: ' + schedule.poles + ' P/L poles; symbols counted: ' + counted + '.';
  if (counted === schedule.poles) {
    for (const row of found) row.extractNote += ' ' + summary.replace(/\.$/, ', they agree.');
    return;
  }
  const gap = Math.abs(counted - schedule.poles);
  const likely = gap > Math.max(2, schedule.poles * 0.2) ? 'A gap this large usually means the reader missed symbols.' : 'This may be an error on the drawing.';
  const flag = 'Count conflict with label schedule: ' + schedule.poles + ' P/L poles listed, ' + counted + ' light symbols counted. ' + likely + missing;
  for (const row of found) row.scheduleNote = flag;
  notes.push(where + ': label schedule lists ' + schedule.poles + ' P/L poles but ' + counted + ' light symbols were counted');
}

byId('scan').onclick = async () => {
  if (rows.length && !window.confirm('Replace the current takeoff with a new reading?')) return;
  scanning = true;
  byId('drawings').disabled = true;
  syncButtons();
  const next = [];
  const notes = [];
  const selected = pages.filter(page => page.selected);
  let aiStopped = '';
  try {
    status('Looking for lighting legend symbols…');
    const legendRows = await countLegendSymbols(selected, notes);
    for (const [index, page] of selected.entries()) {
      status('Reading ' + page.file + ' p' + page.number + ' (' + (index + 1) + ' of ' + selected.length + ')' + (health.ai ? ' with the AI reader…' : '…'));
      let result;
      if (health.ai && !aiStopped) {
        try {
          result = await readPageWithAi(page);
        } catch (error) {
          // A quota or key problem will fail every page, so say it once and read the rest as text.
          if (/^Gemini (quota|key|access)/.test(error.message)) {
            aiStopped = error.message;
            notes.push(error.message + ' The remaining pages were read as text only.');
          } else {
            notes.push('AI could not read ' + page.file + ' p' + page.number + ' (' + error.message + '), used text-only reading');
          }
          result = readPageFromText(page);
        }
      } else {
        result = readPageFromText(page);
      }
      if (!page.lines.length && !health.ai) notes.push('No readable text on ' + page.file + ' p' + page.number + ', review it manually');
      if (result.dropped) notes.push(result.dropped + ' AI items on p' + page.number + ' had no source wording and were discarded');
      // Legend symbol counts replace the reader's own guesses at lights and poles on that sheet;
      // a written schedule still wins.
      const counted = legendRows.get(page.id) || [];
      const kept = counted.some(row => row.source === 'counted') ? result.rows.filter(row => row.source === 'schedule' || !LIGHT_OR_POLE.test(row.description)) : result.rows;
      for (const row of [...counted, ...kept]) next.push({...row, id: nextRowId++, pageId: page.id});
    }
    next.forEach(applyMatch);
    rows = reconcile(next, pages);
    renderReview();
    status(rows.length + ' items found on ' + selected.length + ' pages.' + (notes.length ? ' ' + notes.join('. ') + '.' : '') +
      (health.ai ? '' : ' Text-only reading finds written quantities only; turn on the AI reader to count symbols and read scanned or image-only sheets.') +
      ' Check the drawings for missed items.');
  } catch (error) {
    status('Reading failed. ' + error.message);
  } finally {
    scanning = false;
    byId('drawings').disabled = false;
    syncButtons();
  }
};

/* ------------------------------------------------------------- matching */

function applyMatch(row) {
  const result = matchItem(row.description, catalogue, library.aliases, {exclusions: exclusionTerms(catalogue, library.exclusions)});
  row.autoSku = result.sku;
  if (!row.skuOverride) row.sku = row.skuCleared ? '' : result.sku;
  row.matchConfidence = row.skuOverride ? 'High' : result.confidence;
  row.reason = row.skuOverride ? 'SKU chosen by estimator' : result.reason;
  row.candidates = result.candidates || [];
  row.matchExcluded = !!result.excluded && !row.skuOverride;
}

function rematchAll() {
  for (const row of rows) { row.verified = false; applyMatch(row); }
  reconcile(rows, pages);
  renderReview();
}

const activeItem = sku => sku && catalogue.find(item => item.sku.toLowerCase() === sku.toLowerCase());

async function chooseSku(row, sku) {
  const item = activeItem(sku);
  const previous = row.sku;
  row.sku = item?.sku || '';
  row.skuOverride = !!item;
  row.skuCleared = false;
  row.verified = false;
  applyMatch(row);
  reconcile(rows, pages);
  renderReview();
  if (!item || item.sku === row.autoSku || item.sku === previous) return;
  // Learn from the correction: log it and remember the drawing wording.
  const page = pages[row.pageId];
  const label = normalize(row.description);
  const correction = {text: row.text, description: row.description, fromSku: row.autoSku || '', toSku: item.sku, file: page?.file, page: page?.number};
  await saveLibrary('POST /api/library/corrections', {correction, alias: label ? {label, sku: item.sku} : null}, data => {
    data.corrections.push({...correction, at: new Date().toISOString()});
    if (label) data.aliases[label] = item.sku;
  });
  status('Saved "' + row.description + '" → ' + item.sku + ' as an alias for future matching.');
}

/* --------------------------------------------------------------- review */

const needsReview = row => !row.excluded && (row.confidence !== 'High' || !row.sku || row.flags.length > 0) && !row.verified;
const filters = {
  all: () => true,
  review: needsReview,
  unmatched: row => !row.sku && !row.excluded,
  excluded: row => row.excluded,
  verified: row => row.verified,
};

for (const button of document.querySelectorAll('[data-filter]')) {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(other => other.classList.toggle('active', other === button));
    renderReview();
  };
}

function editField(label, input) {
  const field = element('label', label);
  field.append(input);
  return field;
}

function renderReview() {
  const review = byId('review');
  review.replaceChildren();
  const visible = rows.filter(filters[filter]);
  byId('counts').textContent = rows.length ? rows.filter(needsReview).length + ' to review · ' + rows.filter(row => row.verified).length + ' verified · ' +
    rows.filter(row => row.excluded).length + ' excluded' : '';
  if (!visible.length) review.append(element('p', rows.length ? 'No rows match this filter.' : 'No takeoff rows. Read selected pages or add an item manually.', 'empty'));
  const suggestions = element('datalist');
  suggestions.id = 'sku-options';
  for (const item of catalogue) {
    const option = element('option');
    option.value = item.sku;
    option.label = item.description;
    suggestions.append(option);
  }
  review.append(suggestions);

  for (const row of visible) {
    const page = pages[row.pageId];
    const item = activeItem(row.sku);
    const card = element('article', null, 'line ' + row.confidence.toLowerCase() + '-row' + (row.excluded ? ' excluded' : '') + (row.verified ? ' verified' : ''));
    const title = element('div', null, 'row-title');
    const source = element('button', page.file + ' · p' + page.number + (page.meta.drawingNumber ? ' · ' + page.meta.drawingNumber : ''), 'source');
    source.onclick = () => showPage(page, row);
    title.append(source, element('span', row.source, 'tag'),
      row.location && row.location !== row.source ? element('span', row.location.replace('_', ' '), 'tag') : '',
      element('span', row.sku ? row.confidence : (row.excluded ? 'Excluded' : 'Unmatched'), 'confidence ' + (row.sku ? row.confidence : 'Low').toLowerCase()));
    if (row.excluded) title.append(element('span', 'Excluded from total', 'tag excluded-tag'));

    const description = element('input');
    description.value = row.description;
    description.onchange = () => {
      row.description = description.value;
      row.verified = false;
      if (row.source === 'manual') row.text = description.value;
      row.skuOverride = false;
      row.skuCleared = false;
      applyMatch(row);
      reconcile(rows, pages);
      renderReview();
    };
    const sku = element('input');
    sku.setAttribute('list', 'sku-options');
    sku.value = row.sku;
    sku.placeholder = 'Search active SKUs';
    sku.onchange = () => {
      const value = sku.value.trim();
      const found = activeItem(value) || catalogue.find(entry => entry.description.toLowerCase() === value.toLowerCase());
      if (!found && value) {
        sku.setCustomValidity('Choose an active SKU from the Item List.');
        sku.reportValidity();
        sku.value = row.sku;
        sku.setCustomValidity('');
        return;
      }
      if (!value) { row.skuOverride = false; row.skuCleared = true; row.verified = false; applyMatch(row); reconcile(rows, pages); renderReview(); return; }
      chooseSku(row, found.sku);
    };
    const quantity = element('input');
    quantity.type = 'number';
    quantity.min = '0';
    quantity.step = 'any';
    quantity.value = row.quantity ?? '';
    quantity.onchange = () => {
      row.quantity = quantity.value === '' ? null : quantity.valueAsNumber;
      row.verified = false;
      reconcile(rows, pages);
      renderReview();
    };
    const unit = element('select');
    for (const label of ['ea', 'm']) {
      const option = element('option', label);
      option.value = label;
      unit.append(option);
    }
    unit.value = row.unit;
    unit.onchange = () => { row.unit = unit.value; row.verified = false; reconcile(rows, pages); renderReview(); };
    const fields = element('div', null, 'fields');
    fields.append(editField('Drawing item', description), editField('Plasgain SKU', sku), editField('Quantity', quantity), editField('Unit', unit));

    const details = element('ul', null, 'details');
    const add = (text, className) => { if (text) details.append(element('li', text, className)); };
    add(item ? item.sku + ': ' + item.description : '');
    add(row.reason);
    for (const flag of row.flags) add(flag, /conflict|Duplicate|Superseded|not found/i.test(flag) ? 'warn' : '');
    const packCount = packs(item, row);
    if (packCount) add('Drawing count ' + row.quantity + ' ' + row.unit + ' → quote ' + packCount + ' pack' + (packCount > 1 ? 's' : '') + ' of ' + item.pack_size);
    const accessories = accessoriesFor(item, catalogue);
    if (accessories.length) add('Optional add-ons to check: ' + accessories.join(', '), 'accessory');
    if (row.locationNote) add('Location: ' + row.locationNote);

    const chips = element('div', null, 'candidates');
    for (const code of row.candidates.filter(code => code !== row.sku)) {
      const candidate = activeItem(code);
      if (!candidate) continue;
      const chip = element('button', code + ' · ' + candidate.description, 'chip');
      chip.title = 'Use ' + code;
      chip.onclick = () => chooseSku(row, code);
      chips.append(chip);
    }
    if (chips.childElementCount) chips.prepend(element('span', 'Candidates:'));

    const verified = element('input');
    verified.type = 'checkbox';
    verified.checked = row.verified;
    verified.disabled = !item || !(row.quantity > 0) || row.excluded;
    verified.onchange = () => { row.verified = verified.checked; renderReview(); };
    const excluded = element('input');
    excluded.type = 'checkbox';
    excluded.checked = !!row.excluded;
    excluded.onchange = () => {
      row.userExcluded = excluded.checked === row.autoExcluded ? undefined : excluded.checked;
      row.verified = false;
      reconcile(rows, pages);
      renderReview();
    };
    const remove = element('button', 'Remove', 'secondary');
    remove.onclick = () => { rows = rows.filter(candidate => candidate !== row); reconcile(rows, pages); renderReview(); };
    const actions = element('div', null, 'row-actions');
    actions.append(editField('Verified', verified), editField(row.autoExcluded ? 'Excluded (uncheck to include)' : 'Exclude', excluded), remove);
    card.append(title, element('blockquote', row.text || 'Manual entry'), fields, chips, details, actions);
    review.append(card);
  }
  renderSummary();
  syncButtons();
}

function renderSummary() {
  const lines = quoteLines(rows, catalogue, pages);
  const box = byId('summary');
  box.replaceChildren();
  if (!lines.length) { box.append(element('p', 'Verified rows with an active SKU and a quantity appear here.', 'empty')); return; }
  const table = element('table');
  const head = element('tr');
  for (const label of ['SKU', 'Description', 'Qty', 'Unit', 'Packs', 'Drawing references', 'Add-ons to check']) head.append(element('th', label));
  table.append(head);
  for (const line of lines) {
    const tr = element('tr');
    for (const value of [line.sku, line.description, line.quantity, line.unit, line.packs ? line.packs + ' × ' + line.packSize : '', line.references, line.accessories]) {
      tr.append(element('td', String(value ?? '')));
    }
    table.append(tr);
  }
  const unverified = rows.filter(row => !row.verified && !row.excluded).length;
  box.append(table);
  if (unverified) box.append(element('p', unverified + ' rows are not verified yet and are left out of the quote list.', 'hint'));
}

byId('add').onclick = () => {
  const row = {id: nextRowId++, pageId: currentPage.id, description: '', text: '', quantity: null, unit: 'ea', source: 'manual', flags: []};
  applyMatch(row);
  rows.push(row);
  reconcile(rows, pages);
  filter = 'all';
  document.querySelectorAll('[data-filter]').forEach(other => other.classList.toggle('active', other.dataset.filter === 'all'));
  renderReview();
  byId('review').lastElementChild.querySelector('input').focus();
};

/* --------------------------------------------------------------- export */

function download(name, text) {
  const url = URL.createObjectURL(new Blob(['﻿', text], {type: 'text/csv;charset=utf-8'}));
  const link = element('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function projectHeader() {
  const latest = new Map();
  for (const page of pages.filter(page => page.selected)) {
    const key = (page.meta.drawingNumber || '').toUpperCase() || page.id;
    if (!latest.has(key) || compareRevision(page.meta.revision, latest.get(key).meta.revision) > 0) latest.set(key, page);
  }
  const statuses = [...new Set([...latest.values()].map(page => page.meta.status).filter(Boolean))];
  return [
    ['Project', byId('project').value],
    ['Drawing status', statuses.join(', ')],
    ['Drawings', [...latest.values()].map(page => [page.meta.drawingNumber || page.file + ' p' + page.number,
      page.meta.revision && 'rev ' + page.meta.revision, page.meta.status].filter(Boolean).join(' ')).join('; ')],
    ['Item List', library.itemList.fileName + (library.itemList.uploadedAt ? ' (' + library.itemList.uploadedAt.slice(0, 10) + ')' : '')],
    ['Exported', new Date().toLocaleString('en-AU')],
    [],
  ];
}

const fileStem = () => (byId('project').value || 'plasgain').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'plasgain';

byId('export').onclick = () => {
  const data = [...projectHeader(),
    ['Part number', 'Description', 'Quantity', 'Unit', 'Packs to quote', 'Pack size', 'Drawing references', 'Drawing wording', 'Optional add-ons to check']];
  for (const line of quoteLines(rows, catalogue, pages)) {
    data.push([line.sku, line.description, line.quantity, line.unit, line.packs, line.packSize, line.references, line.wording, line.accessories]);
  }
  download(fileStem() + '-quote.csv', quoteCsv(data));
};

byId('export-detail').onclick = () => {
  const data = [...projectHeader(),
    ['Status', 'Part number', 'Item List description', 'Drawing description', 'Drawing wording', 'Quantity', 'Unit', 'Packs', 'Source type',
      'Location', 'PDF', 'Page', 'Drawing no.', 'Revision', 'Confidence', 'Match reason', 'Flags', 'Candidates']];
  for (const row of rows) {
    const page = pages[row.pageId];
    const item = activeItem(row.sku);
    data.push([row.excluded ? 'Excluded' : row.verified ? 'Verified' : 'Not verified', row.sku, item?.description || '', row.description, row.text,
      row.quantity ?? '', row.unit, packs(item, row), row.source, [row.location, row.locationNote].filter(Boolean).join(': '), page.file, page.number,
      page.meta.drawingNumber || '', page.meta.revision || '', row.sku ? row.confidence : 'Unmatched', row.reason, row.flags.join(' | '), row.candidates.join(' ')]);
  }
  download(fileStem() + '-takeoff-detail.csv', quoteCsv(data));
};

window.addEventListener('beforeunload', event => { if (rows.length) event.preventDefault(); });

loadHealth();
loadLibrary();
