import * as pdf from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {extractRows, flagDuplicates, matchItem, normalize, quoteCsv, readCatalogue} from './takeoff.js';
import './style.css';

pdf.GlobalWorkerOptions.workerSrc = worker;
const byId = id => document.getElementById(id);
const pages = [];
let catalogue = [];
let rows = [];
let currentPage;
let loading = false;
let scanning = false;
let aliases = {};
try {
  aliases = JSON.parse(localStorage.getItem('plasgain-aliases') || '{}') || {};
} catch {
  // A corrupt or unavailable local store does not prevent review.
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function status(message) {
  byId('status').textContent = message;
}

function syncButtons() {
  byId('scan').disabled = loading || scanning || !pages.some(page => page.selected);
  byId('add').disabled = loading || scanning || !currentPage;
  byId('export').disabled = loading || scanning || !rows.some(exportable);
}

async function renderPage(page, canvas, width) {
  const initial = page.pdf.getViewport({scale: 1});
  const viewport = page.pdf.getViewport({scale: width / initial.width});
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.pdf.render({canvas, viewport}).promise;
  return initial;
}

async function showPage(page, row) {
  currentPage = page;
  byId('page-title').textContent = page.file + ' · Page ' + page.number;
  const canvas = element('canvas');
  const figure = element('figure');
  figure.append(canvas);
  byId('viewer').replaceChildren(figure);
  syncButtons();
  try {
    const viewport = await renderPage(page, canvas, 1800);
    if (row?.point) {
      const [x, y] = viewport.convertToViewportPoint(...row.point);
      const marker = element('span', '', 'marker');
      marker.title = row.text;
      marker.style.left = (x / viewport.width * 100) + '%';
      marker.style.top = (y / viewport.height * 100) + '%';
      figure.append(marker);
      if (figure.isConnected) marker.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
  } catch (error) {
    if (figure.isConnected) figure.replaceChildren(element('p', 'Page could not be rendered. ' + error.message));
  }
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
  check.checked = true;
  check.onchange = () => { page.selected = check.checked; syncButtons(); };
  label.append(check, element('span', 'Page ' + page.number));
  card.append(open, label, element('small', page.file));
  byId('pages').append(card);
  return renderPage(page, canvas, 240).catch(() => open.replaceChildren(element('span', 'Preview unavailable')));
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
          const page = {id: pages.length, file: file.name, number, selected: true, pdf: await document.getPage(number)};
          if (!pages.length) byId('pages').replaceChildren();
          pages.push(page);
          await addPageCard(page);
        }
      } catch (error) {
        failures.push(file.name + ' — ' + error.message);
      }
    }
    if (!currentPage && pages.length) void showPage(pages[0]);
    status(failures.length ? failures.join(' · ') : pages.length + ' pages available.');
  } finally {
    event.target.disabled = false;
    loading = false;
    syncButtons();
  }
};

function applyMatch(row) {
  Object.assign(row, matchItem(row.description, catalogue, aliases));
  if (row.quantity == null) {
    row.confidence = 'Low';
    row.reason += ' · Quantity unspecified';
  }
}

byId('catalogue').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    catalogue = readCatalogue(await file.text());
    byId('catalogue-status').textContent = catalogue.length + ' active SKUs loaded';
    for (const row of rows) {
      row.verified = false;
      row.excluded = false;
      applyMatch(row);
    }
    flagDuplicates(rows);
    renderReview();
  } catch (error) {
    status(error.message);
  } finally {
    event.target.value = '';
  }
};

async function readLines(page) {
  const {items} = await page.pdf.getTextContent();
  const lines = [];
  let line;
  for (const item of items) {
    if (!item.str) continue;
    const point = item.transform.slice(4, 6);
    if (!line || Math.abs(point[1] - line.point[1]) > 2) {
      line = {text: '', point, pageId: page.id};
      lines.push(line);
    }
    line.text += (line.text ? ' ' : '') + item.str.trim();
    if (item.hasEOL) line = null;
  }
  return lines;
}

byId('scan').onclick = async () => {
  if (rows.length && !window.confirm('Replace the current takeoff with a new scan?')) return;
  scanning = true;
  byId('drawings').disabled = true;
  byId('catalogue').disabled = true;
  syncButtons();
  const next = [];
  const unreadable = [];
  try {
    for (const page of pages.filter(page => page.selected)) {
      status('Reading ' + page.file + ' · Page ' + page.number + '…');
      const lines = await readLines(page);
      if (!lines.length) unreadable.push(page.file + ' p' + page.number);
      next.push(...extractRows(lines));
    }
    next.forEach(applyMatch);
    rows = flagDuplicates(next);
    renderReview();
    status(rows.length + ' explicit quantity lines found.' + (unreadable.length ?
      ' No readable text on ' + unreadable.join(', ') + '. Review those pages manually.' : ' Review the drawings for missed items.'));
  } catch (error) {
    status('Scan failed. ' + error.message);
  } finally {
    scanning = false;
    byId('drawings').disabled = false;
    byId('catalogue').disabled = false;
    syncButtons();
  }
};

const activeItem = sku => catalogue.find(item => item.sku === sku);
const exportable = row => row.verified && !row.excluded && !!activeItem(row.sku) && Number.isFinite(row.quantity) && row.quantity > 0;
function packs(item, row) {
  const size = Number(item?.pack_size);
  return size > 1 && row.unit === (item.pack_unit || 'ea') && row.quantity !== null ? Math.ceil(row.quantity / size) : '';
}

function editField(label, input) {
  const field = element('label', label);
  field.append(input);
  return field;
}

function renderReview() {
  const review = byId('review');
  review.replaceChildren();
  if (!rows.length) review.append(element('p', 'No takeoff rows. Scan selected pages or add an item manually.', 'empty'));
  const suggestions = element('datalist');
  suggestions.id = 'sku-options';
  for (const item of catalogue) {
    const option = element('option');
    option.value = item.sku;
    option.label = item.description;
    suggestions.append(option);
  }
  review.append(suggestions);

  for (const row of rows) {
    const page = pages[row.pageId];
    const card = element('article', null, 'line');
    const title = element('div', null, 'row-title');
    const source = element('button', page.file + ' · p' + page.number, 'source');
    source.onclick = () => showPage(page, row);
    title.append(source, element('span', row.source, 'tag'), element('span', row.confidence, 'confidence ' + row.confidence.toLowerCase()));

    const description = element('input');
    description.value = row.description;
    description.onchange = () => {
      row.description = description.value;
      row.verified = false;
      if (row.source === 'manual') row.text = description.value;
      applyMatch(row);
      renderReview();
    };
    const sku = element('input');
    sku.setAttribute('list', 'sku-options');
    sku.value = row.sku;
    sku.placeholder = 'Search active SKUs';
    sku.onchange = () => {
      const item = catalogue.find(item => item.sku.toLowerCase() === sku.value.trim().toLowerCase());
      if (!item && sku.value.trim()) {
        sku.setCustomValidity('Choose an active SKU from the Item List.');
        sku.reportValidity();
        sku.value = row.sku;
        sku.setCustomValidity('');
        return;
      }
      row.sku = item?.sku || '';
      row.verified = false;
      renderReview();
    };
    const quantity = element('input');
    quantity.type = 'number';
    quantity.min = '0';
    quantity.step = 'any';
    quantity.value = row.quantity ?? '';
    quantity.onchange = () => {
      row.quantity = quantity.value === '' ? null : quantity.valueAsNumber;
      row.verified = false;
      renderReview();
    };
    const unit = element('select');
    for (const label of ['ea', 'm']) {
      const option = element('option', label);
      option.value = label;
      unit.append(option);
    }
    unit.value = row.unit;
    unit.onchange = () => { row.unit = unit.value; row.verified = false; renderReview(); };
    const fields = element('div', null, 'fields');
    fields.append(editField('Drawing item', description), editField('Plasgain SKU', sku), editField('Quantity', quantity), editField('Unit', unit));

    const item = activeItem(row.sku);
    const details = [row.reason, row.candidates.length ? 'Candidates: ' + row.candidates.join(', ') : '',
      packs(item, row) ? 'Quote packs: ' + packs(item, row) : '', item?.required_accessories ? 'Check accessories: ' + item.required_accessories : ''].filter(Boolean);
    const verified = element('input');
    verified.type = 'checkbox';
    verified.checked = row.verified;
    verified.disabled = !item || !row.quantity || row.quantity < 0 || row.excluded;
    verified.onchange = () => { row.verified = verified.checked; syncButtons(); };
    const excluded = element('input');
    excluded.type = 'checkbox';
    excluded.checked = !!row.excluded;
    excluded.onchange = () => { row.excluded = excluded.checked; row.verified = false; renderReview(); };
    const remember = element('button', 'Save alias', 'secondary');
    remember.disabled = !item || !normalize(row.description);
    remember.onclick = () => {
      try {
        const next = {...aliases, [normalize(row.description)]: item.sku};
        localStorage.setItem('plasgain-aliases', JSON.stringify(next));
        aliases = next;
        status('Alias saved for ' + item.sku + ' in this browser.');
      } catch (error) {
        status('Alias could not be saved. ' + error.message);
      }
    };
    const remove = element('button', 'Remove', 'secondary');
    remove.onclick = () => { rows = rows.filter(candidate => candidate !== row); renderReview(); };
    const actions = element('div', null, 'row-actions');
    actions.append(editField('Verified', verified), editField('Exclude', excluded), remember, remove);
    card.append(title, element('blockquote', row.text || 'Manual entry'), fields, element('p', details.join(' · '), 'details'), actions);
    review.append(card);
  }
  syncButtons();
}

byId('add').onclick = () => {
  const row = {pageId: currentPage.id, description: '', text: '', quantity: null, unit: 'ea', source: 'manual'};
  applyMatch(row);
  rows.push(row);
  renderReview();
  byId('review').lastElementChild.querySelector('input').focus();
};

byId('export').onclick = () => {
  const data = [['Project', 'SKU', 'Description', 'Drawing quantity', 'Unit', 'Quote packs', 'PDF', 'Page', 'Source type', 'Source wording']];
  for (const row of rows.filter(exportable)) {
    const item = activeItem(row.sku);
    const page = pages[row.pageId];
    data.push([byId('project').value, row.sku, item.description, row.quantity, row.unit, packs(item, row),
      page.file, page.number, row.source, row.text]);
  }
  const url = URL.createObjectURL(new Blob(['\uFEFF', quoteCsv(data)], {type: 'text/csv;charset=utf-8'}));
  const download = element('a');
  download.href = url;
  download.download = 'plasgain-takeoff.csv';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
