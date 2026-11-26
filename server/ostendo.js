// Read-only Ostendo client for the Item List. SERVER-SIDE ONLY.
// Follows the Plasgain Ostendo handover guide (18/11/2026), as used in WeeklyFollowUp:
// - only ever GET /tabledata
// - https + host plasgain.southeastit.com.au + port 8843 guard
// - 45 s timeout, no redirects, detection of error pages sent with HTTP 200
// - never log the URL, and scrub the key from every message

import {list} from '../src/takeoff.js';

const ALLOWED_HOST = 'plasgain.southeastit.com.au';
const ALLOWED_PORT = '8843';
const TIMEOUT_MS = 45_000;

export const itemTable = () => (process.env.OSTENDO_ITEM_TABLE || 'ITEMMASTER').trim().toUpperCase();
export const configured = () => Boolean(process.env.OSTENDO_API_URL?.trim() && process.env.OSTENDO_API_KEY?.trim());

// The uploaded Item List is the main source. Replacing it from Ostendo is
// switched on only when OSTENDO_ITEM_SYNC is set (on, yes, true or 1).
export const syncEnabled = () => configured() && /^(1|on|yes|true)$/i.test(process.env.OSTENDO_ITEM_SYNC?.trim() || '');

export class OstendoError extends Error {
  constructor(message, kind) {
    super(sanitize(message));
    this.name = 'OstendoError';
    this.kind = kind; // settings | key | ostendo | network
    this.status = kind === 'settings' ? 503 : 502;
  }
}

export function sanitize(message) {
  const key = process.env.OSTENDO_API_KEY?.trim();
  let out = String(message);
  if (key) out = out.split(key).join('[REDACTED]').split(encodeURIComponent(key)).join('[REDACTED]');
  return out.replace(/apikey=[^&\s]+/gi, 'apikey=[REDACTED]').replace(/bearer\s+[a-z0-9_.-]+/gi, 'Bearer [REDACTED]');
}

const encodeParam = value => encodeURIComponent(value)
  .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');

export function checkSettings() {
  const rawUrl = process.env.OSTENDO_API_URL?.trim();
  const key = process.env.OSTENDO_API_KEY?.trim();
  if (!rawUrl) throw new OstendoError('OSTENDO_API_URL is not set in Vercel', 'settings');
  if (!key) throw new OstendoError('OSTENDO_API_KEY is not set in Vercel', 'settings');
  let base;
  try { base = new URL(rawUrl); } catch { throw new OstendoError('OSTENDO_API_URL is not a valid web address', 'settings'); }
  if (base.protocol !== 'https:') throw new OstendoError('OSTENDO_API_URL must start with https://', 'settings');
  if (base.hostname.toLowerCase() !== ALLOWED_HOST) throw new OstendoError('OSTENDO_API_URL host must be ' + ALLOWED_HOST, 'settings');
  if (base.port !== ALLOWED_PORT) throw new OstendoError('OSTENDO_API_URL port must be ' + ALLOWED_PORT, 'settings');
  return base;
}

export function tableUrl(table, condition) {
  const base = checkSettings();
  if (!/^[A-Z0-9_$]+$/i.test(table)) throw new OstendoError('Invalid table name', 'settings');
  const parts = ['configuration=0', 'tablename=' + encodeURIComponent(table.toUpperCase()),
    'apikey=' + encodeURIComponent(process.env.OSTENDO_API_KEY.trim()), 'format=json'];
  if (condition?.trim()) parts.push('condition=' + encodeParam(condition.trim().replace(/\s*([=><!]+)\s*/g, '$1').replace(/\s+/g, ' ')));
  return base.origin + base.pathname.replace(/\/+$/, '') + '/tabledata?' + parts.join('&');
}

function extractRows(json, table) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const key = Object.keys(json).find(k => [table.toUpperCase(), 'DATA', 'ROWS'].includes(k.toUpperCase()));
    if (key) return Array.isArray(json[key]) ? json[key] : [json[key]];
    if (Object.keys(json).length) return [json];
  }
  return [];
}

// One Ostendo read at a time per server instance.
let queue = Promise.resolve();

export function readTable(table, condition, {fetchImpl = fetch} = {}) {
  const run = queue.then(() => readOnce(table, condition, fetchImpl));
  queue = run.catch(() => {});
  return run;
}

async function readOnce(table, condition, fetchImpl) {
  const url = tableUrl(table, condition);
  let response;
  try {
    response = await fetchImpl(url, {method: 'GET', headers: {Accept: 'application/json, text/plain, */*'}, redirect: 'manual',
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS)});
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new OstendoError('Ostendo took longer than 45 seconds (try again later, or set OSTENDO_ITEM_CONDITION to read fewer rows)', 'network');
    }
    throw new OstendoError('Could not reach Ostendo (connection problem, try again later)', 'network');
  }
  const text = await response.text();
  const head = text.trim();
  const denied = /invalid\s*api\s*key|access\s*denied|unauthori[sz]ed/i.test(head.slice(0, 500));
  if (response.status >= 300 && response.status < 400) throw new OstendoError('Ostendo redirect ' + response.status, 'ostendo');
  if (response.status === 401 || response.status === 403) throw new OstendoError('Ostendo rejected the API key', 'key');
  if (head.startsWith('<') || denied) {
    throw new OstendoError('Ostendo error: ' + head.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200), denied ? 'key' : 'ostendo');
  }
  if (!response.ok) throw new OstendoError('Ostendo HTTP ' + response.status + ': ' + head.slice(0, 200), 'ostendo');
  let json;
  try { json = JSON.parse(text); } catch { throw new OstendoError("Ostendo returned something that isn't JSON: " + head.slice(0, 120), 'ostendo'); }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const error = json.ERROR || json.error || json.FAULT || json.fault || json.errorMessage;
    if (error) throw new OstendoError('Ostendo error: ' + (typeof error === 'string' ? error : JSON.stringify(error)), 'ostendo');
  }
  return extractRows(json, table);
}

const cell = value => (value === null || value === undefined ? '' : String(value).trim());

/* ---------------------------------------------------- Item List mapping */

// Ostendo column names to try for each Item List field, best first. Override
// any field with OSTENDO_COLUMN_<FIELD>, e.g. OSTENDO_COLUMN_UNIT=SELLUNIT.
export const OSTENDO_COLUMNS = {
  sku: ['ITEMCODE', 'CODE', 'PARTNUMBER'],
  description: ['ITEMDESCRIPTION', 'DESCRIPTION', 'ITEMNAME'],
  status: ['ITEMSTATUS', 'STATUS'],
  category: ['ITEMCATEGORY', 'CATEGORY', 'ITEMGROUP', 'ITEMTYPE'],
  subcategory: ['ITEMSUBCATEGORY', 'SUBCATEGORY'],
  specifications: ['ITEMSPECIFICATION', 'SPECIFICATIONS', 'ITEMNOTES', 'EXTENDEDDESCRIPTION'],
  unit: ['STOCKUNIT', 'SELLUNIT', 'ITEMUNIT', 'UNIT', 'BASEUNIT'],
};
// Yes/no columns that mean the item is no longer sold, used when there is no status column.
const INACTIVE_FLAGS = ['INACTIVE', 'OBSOLETE', 'DISCONTINUED', 'ITEMOBSOLETE', 'ITEMINACTIVE'];
const ACTIVE = /^(active|current|available|yes|y|true|t|1)$/i;
const TRUE = /^(yes|y|true|t|1)$/i;
// Item List fields that Ostendo does not hold; kept from the previous Item List by SKU.
export const KEPT_FIELDS = ['drawing_aliases', 'competitor_equivalents', 'required_accessories', 'exclusion_notes', 'pack_size', 'pack_unit'];

function pickColumns(columns) {
  const upper = new Map(columns.map(name => [name.toUpperCase(), name]));
  const picked = {};
  for (const [field, names] of Object.entries(OSTENDO_COLUMNS)) {
    const override = process.env['OSTENDO_COLUMN_' + field.toUpperCase()]?.trim().toUpperCase();
    const name = override ? [override] : names;
    picked[field] = name.map(n => upper.get(n)).find(Boolean) || '';
  }
  picked.inactive = picked.status ? '' : INACTIVE_FLAGS.map(n => upper.get(n)).find(Boolean) || '';
  return picked;
}

const columnsOf = rows => [...new Set(rows.flatMap(row => Object.keys(row)))];

// Turns Ostendo rows into Active Item List entries. Fields Ostendo doesn't hold
// (aliases, packs, accessories, exclusion notes) carry over from `previous`.
export function itemsFromOstendo(rows, previous = []) {
  const columns = columnsOf(rows);
  const picked = pickColumns(columns);
  const missing = ['sku', 'description'].filter(field => !picked[field]);
  if (missing.length) {
    throw new OstendoError('Ostendo ' + itemTable() + ' has no ' + missing.join(' or ') + ' column. Columns found: ' +
      columns.slice(0, 60).join(', '), 'ostendo');
  }
  const kept = new Map(previous.map(item => [String(item.sku).toLowerCase(), item]));
  const seen = new Set();
  const items = [];
  let inactive = 0;
  for (const row of rows) {
    const sku = cell(row[picked.sku]);
    const description = cell(row[picked.description]);
    if (!sku || !description) continue;
    const active = picked.status ? ACTIVE.test(cell(row[picked.status])) : picked.inactive ? !TRUE.test(cell(row[picked.inactive])) : true;
    if (!active) { inactive++; continue; }
    const key = sku.toLowerCase();
    if (seen.has(key)) continue; // Ostendo item codes are unique; ignore a repeated row
    seen.add(key);
    const item = {sku, description, status: 'Active',
      category: [cell(row[picked.category]), cell(row[picked.subcategory])].filter(Boolean).join(' '),
      specifications: picked.specifications ? cell(row[picked.specifications]).slice(0, 500) : '',
      unit: cell(row[picked.unit])};
    const before = kept.get(key);
    for (const field of KEPT_FIELDS) {
      if (before?.[field] && list(before[field]).length) item[field] = before[field];
    }
    items.push(item);
  }
  return {items, inactive, columns: picked, statusRule: picked.status ? picked.status + ' = Active' :
    picked.inactive ? picked.inactive + ' is not ticked' : 'no status column found, so every item is treated as Active'};
}

// Structure only: column names, how full they are, and values of the status
// column. Never returns item rows.
export function describeColumns(rows) {
  const columns = columnsOf(rows);
  const picked = pickColumns(columns);
  const total = rows.length || 1;
  const statusColumn = picked.status || picked.inactive;
  const counts = {};
  if (statusColumn) for (const row of rows) { const v = cell(row[statusColumn]) || '(blank)'; counts[v] = (counts[v] || 0) + 1; }
  return {table: itemTable(), rows: rows.length, mapping: picked,
    statusValues: Object.keys(counts).length <= 20 ? counts : {note: Object.keys(counts).length + ' distinct values'},
    columns: columns.map(name => ({name, filledPct: Math.round(rows.filter(row => cell(row[name])).length / total * 1000) / 10}))};
}
