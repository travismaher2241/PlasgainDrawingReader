// Pure takeoff rules shared by the browser app, the server and the tests.
// Nothing in this file touches the DOM, the network or storage.

export const SOURCE_RANK = {schedule: 4, callout: 3, counted: 2, measured: 2, unspecified: 1, manual: 0};
export const CONFIDENCE_ORDER = {Low: 0, Medium: 1, High: 2};

const lowest = (...levels) => levels.filter(Boolean)
  .reduce((a, b) => CONFIDENCE_ORDER[b] < CONFIDENCE_ORDER[a] ? b : a, 'High');

/* ------------------------------------------------------------------ CSV */

export function readCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"' && (quoted || field === '')) {
      quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      record.push(field);
      field = '';
      if (char !== ',') {
        if (record.some(value => value.trim())) records.push(record);
        record = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('The Item List CSV contains an unclosed quoted field.');
  record.push(field);
  if (record.some(value => value.trim())) records.push(record);
  return records;
}

export function quoteCsv(rows) {
  return rows.map(record => record.map(value => {
    const text = String(value ?? '');
    const safe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------ Item List */

// Header spellings accepted for each Item List field. The first entry is the
// canonical name used everywhere else in the app.
export const ITEM_LIST_COLUMNS = {
  sku: ['sku', 'part_number', 'part_no', 'part', 'item_code', 'item_number', 'item_no', 'code', 'product_code'],
  description: ['description', 'item_description', 'product_description', 'name', 'item_name'],
  status: ['status', 'item_status', 'active', 'lifecycle'],
  category: ['category', 'itemcategory', 'item_category', 'product_type', 'type', 'item_type', 'group', 'product_group'],
  subcategory: ['subcategory', 'itemsubcategory', 'item_subcategory', 'sub_category', 'product_subgroup'],
  specifications: ['specifications', 'specs', 'spec', 'attributes', 'dimensions', 'size'],
  unit: ['unit', 'uom', 'unit_of_measure', 'sell_unit'],
  pack_size: ['pack_size', 'pack_qty', 'pack_quantity', 'box_qty', 'units_per_pack'],
  pack_unit: ['pack_unit', 'pack_uom'],
  drawing_aliases: ['drawing_aliases', 'aliases', 'alias', 'drawing_codes', 'dnsp_codes'],
  competitor_equivalents: ['competitor_equivalents', 'competitor_codes', 'legacy_codes', 'equivalents', 'cross_reference'],
  required_accessories: ['required_accessories', 'accessories', 'linked_accessories'],
  exclusion_notes: ['exclusion_notes', 'exclusions', 'exclude'],
};

const headerKey = header => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function mapItemListHeaders(headers) {
  const keys = headers.map(headerKey);
  return keys.map(key => Object.entries(ITEM_LIST_COLUMNS).find(([, names]) => names.includes(key))?.[0] ?? key);
}

const ACTIVE_STATUS = /^(active|yes|y|true|current|1)$/i;

export function readCatalogue(text) {
  return catalogueFromRows(readCsv(text.replace(/^\uFEFF/, '')));
}

// Spreadsheets often have title rows above the headings, so use the first row
// that names a part number and a description column.
export function catalogueFromRows(rows) {
  const cleaned = rows.map(row => row.map(value => value == null ? '' : String(value)));
  const index = cleaned.findIndex(row => {
    const keys = mapItemListHeaders(row);
    return keys.includes('sku') && keys.includes('description');
  });
  const start = index < 0 ? 0 : index;
  return catalogueFromRecords(cleaned[start] || [], cleaned.slice(start + 1));
}

export function catalogueFromRecords(headers, records) {
  const keys = mapItemListHeaders(headers.map(String));
  for (const required of ['sku', 'description']) {
    if (!keys.includes(required)) {
      throw new Error('Missing Item List column: ' + required + ' (accepted headings: ' + ITEM_LIST_COLUMNS[required].join(', ') + ')');
    }
  }
  const all = records.map(record => Object.fromEntries(keys.map((key, i) => [key, String(record[i] ?? '').trim()])))
    .filter(item => item.sku || item.description);
  // A list without a status column (such as an export of active stock items)
  // is taken to hold only active items.
  const hasStatus = keys.includes('status');
  const active = all.filter(item => (!hasStatus || ACTIVE_STATUS.test(item.status)) && item.sku && item.description)
    .map(item => hasStatus ? item : {...item, status: 'Active'});
  const seen = new Map();
  for (const item of active) {
    const key = item.sku.toLowerCase();
    if (seen.has(key)) throw new Error('The Item List contains duplicate active SKUs: ' + item.sku);
    seen.set(key, item);
  }
  return active;
}

export const list = value => (Array.isArray(value) ? value : String(value || '').split(/[|;\n]/))
  .map(value => String(value).trim()).filter(Boolean);

/* ------------------------------------------------------ Text normalising */

const ABBREVIATIONS = {
  galv: 'galvanised', galvanized: 'galvanised', gal: 'galvanised', hdg: 'galvanised',
  alum: 'aluminium', aluminum: 'aluminium', ally: 'aluminium',
  ss: 'stainless', stainles: 'stainless',
  // A lantern and a luminaire are the same thing on lighting drawings.
  lum: 'lantern', luminare: 'lantern', lumanaire: 'lantern', luminaires: 'lantern', luminaire: 'lantern',
  lanterns: 'lantern', lights: 'light',
  dia: 'diameter', diam: 'diameter',
  hd: 'heavyduty', 'heavy-duty': 'heavyduty',
  cond: 'conduit', condiut: 'conduit', conduits: 'conduit',
  // Item Lists call a light pole a column; drawings usually call it a pole.
  poles: 'pole', column: 'pole', columns: 'pole', col: 'pole',
  mh: 'mountingheight', aero: 'aeroscreen', aeroscreens: 'aeroscreen',
  pits: 'pit', bollards: 'bollard', lids: 'lid', covers: 'cover', brackets: 'bracket',
  outreach: 'outreach', o_reach: 'outreach',
  sw: 'switch', gpo: 'gpo', jb: 'junction', jbox: 'junction',
};

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'per', 'off', 'qty', 'quantity', 'type', 'item', 'each',
  'new', 'supply', 'install', 'provide', 'refer', 'see', 'note', 'notes', 'from', 'into', 'all', 'only', 'length',
  'schedule', 'callout', 'drawing', 'similar', 'equivalent', 'approved', 'equal', 'typ', 'typical', 'nom', 'nominal']);

const unitScale = unit => /^mm$/i.test(unit) ? 1 : /^cm$/i.test(unit) ? 10 : 1000;

// Convert metric sizes to a single unit and lower-case, keeping digits and dots.
export function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2')
    .replace(/\b(\d+(?:\.\d+)?)\s*(mm|cm|mtrs?|metres?|meters?|m)\b(?!\w)/g, (_, value, unit) =>
      String(+(Number(value) * unitScale(unit)).toFixed(3)) + 'mm')
    .replace(/[^a-z0-9.]+/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Wording that drawings and Item Lists write differently. Each phrase becomes
// one word before matching.
const PHRASES = [
  [/\bmounting height\b/g, 'mountingheight'],
  [/\baero screen\b/g, 'aeroscreen'],
  [/\bstreet led\b/g, 'streetled'],
  [/\broad led\b/g, 'roadled'],
];

export function words(text) {
  let normal = normalize(text);
  for (const [pattern, replacement] of PHRASES) normal = normal.replace(pattern, replacement);
  // A product family number ("StreetLED3") is dropped so it matches the
  // family name on a drawing ("StreetLED").
  normal = normal.replace(/\b([a-z]{4,})\d\b/g, '$1');
  return normal.split(' ')
    .map(word => ABBREVIATIONS[word] || word)
    .filter(word => word.length > 2 && !/\d/.test(word) && !STOPWORDS.has(word));
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const wordMatches = (word, other) => word === other ||
  (word.length >= 5 && other.length >= 5 && editDistanceAtMostOne(word, other)) ||
  (word.length >= 4 && other.startsWith(word)) || (other.length >= 4 && word.startsWith(other));

/* ---------------------------------------------------------- Specifications */

// Specifications are grouped by what they measure, so a 6.5 m pole can be
// compared with a 6500 mm Item List entry, and a 150 W light never matches a
// 100 W light.
const SPEC_PATTERNS = [
  {kind: 'size', re: /\b(\d+(?:\.\d+)?)\s*(mm|cm|mtrs?|metres?|meters?|m)\b(?!\/)/gi, value: (n, u) => n * unitScale(u), unit: 'mm'},
  {kind: 'power', re: /\b(\d+(?:\.\d+)?)\s*(?:w|watts?)\b/gi, value: n => n, unit: 'W'},
  {kind: 'current', re: /\b(\d+(?:\.\d+)?)\s*a\b/gi, value: n => n, unit: 'A'},
  {kind: 'voltage', re: /\b(\d+(?:\.\d+)?)\s*v\b/gi, value: n => n, unit: 'V'},
  {kind: 'load', re: /\b(\d+(?:\.\d+)?)\s*kn\b/gi, value: n => n, unit: 'kN'},
  {kind: 'colour temperature', re: /\b(\d{4})\s*k\b/gi, value: n => n, unit: 'K'},
  {kind: 'ip rating', re: /\bip\s?(\d{2})\b/gi, value: n => n, unit: 'IP'},
  {kind: 'load class', re: /\bclass\s+([a-g])\b/gi, value: (n, _u, raw) => raw.toUpperCase(), unit: ''},
];

const MATERIALS = ['steel', 'galvanised', 'aluminium', 'stainless', 'concrete', 'polymer', 'plastic', 'pvc', 'hdpe',
  'fibreglass', 'frp', 'timber', 'cast iron', 'composite', 'polycarbonate'];

export function parseSpecs(text) {
  const specs = {};
  const source = String(text || '').replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  for (const pattern of SPEC_PATTERNS) {
    for (const match of source.matchAll(pattern.re)) {
      const raw = match[1];
      const value = pattern.unit === '' ? pattern.value(raw, '', raw) : pattern.value(Number(raw), match[2] || '', raw);
      (specs[pattern.kind] ||= []).push(value);
    }
  }
  const lower = normalize(source).split(' ').map(word => ABBREVIATIONS[word] || word).join(' ');
  const materials = MATERIALS.filter(material => new RegExp('\\b' + material + '\\b').test(lower));
  if (materials.length) specs.material = materials;
  return specs;
}

// Lamp wattage on a drawing is nominal (a "14W" lantern is sold as 13.7 W),
// so power agrees within 10%. Other measures must be the same.
const sameValue = (a, b, kind) => typeof a === 'number' && typeof b === 'number'
  ? Math.abs(a - b) <= (kind === 'power' ? Math.max(0.5, Math.max(a, b) * 0.1) : Math.max(0.5, a * 0.001)) : a === b;

function compareSpecs(drawingSpecs, itemSpecs) {
  const conflicts = [], missing = [], agreed = [];
  for (const [kind, values] of Object.entries(itemSpecs)) {
    const drawn = drawingSpecs[kind];
    if (!drawn) { missing.push(kind); continue; }
    if (kind === 'material') {
      // Galvanised is a finish of steel, so treat them as compatible.
      const ok = values.some(value => drawn.includes(value)) ||
        (values.includes('galvanised') && drawn.includes('steel')) || (values.includes('steel') && drawn.includes('galvanised'));
      (ok ? agreed : conflicts).push(kind);
    } else if (values.some(value => drawn.some(other => sameValue(value, other, kind)))) {
      agreed.push(kind);
    } else {
      conflicts.push(kind);
    }
  }
  return {conflicts, missing, agreed};
}

export function describeSpec(kind, values) {
  const unit = {size: 'mm', power: 'W', current: 'A', voltage: 'V', load: 'kN', 'colour temperature': 'K'}[kind];
  if (kind === 'ip rating') return values.map(value => 'IP' + value).join('/');
  return values.map(value => value + (unit || '')).join('/');
}

/* ------------------------------------------------------------ Quantities */

const UNSPECIFIED = /\b(as\s+req(?:uired|'?d)?|a\/r|tba|tbc|tbd|to\s+be\s+(?:advised|confirmed|determined)|by\s+others|n\/a)\b/i;

// Read a quantity note such as "Qty 4", "3x", "x4", "3 x 2", "6.5m", "6500 mm",
// or "as required". Lengths come back in metres.
export function parseQuantity(text) {
  const raw = String(text || '').trim();
  if (!raw) return {quantity: null, unit: 'ea', unspecified: true, note: ''};
  if (UNSPECIFIED.test(raw)) return {quantity: null, unit: /m\b|length|run/i.test(raw) ? 'm' : 'ea', unspecified: true, note: raw};
  const cleaned = raw.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  const length = cleaned.match(/(\d+(?:\.\d+)?)\s*(mm|m|lm|metres?|meters?)\b(?:\s*[x×]\s*(\d+))?/i);
  const multiplier = (a, b) => a * (b ? Number(b) : 1);
  if (length && !/^\s*(?:qty|quantity)\b/i.test(cleaned)) {
    const value = Number(length[1]) / (length[2].toLowerCase() === 'mm' ? 1000 : 1);
    const times = length[3] ? Number(length[3]) : 1;
    return {quantity: +(value * times).toFixed(3), base: value, multiplier: times, unit: 'm', unspecified: false, note: raw};
  }
  const count = cleaned.match(/(?:(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?))|(?:[x×]\s*(\d+(?:\.\d+)?))|(?:(\d+(?:\.\d+)?)\s*[x×](?!\s*\d))|(\d+(?:\.\d+)?)/i);
  if (!count) return {quantity: null, unit: 'ea', unspecified: true, note: raw};
  if (count[1]) return {quantity: multiplier(Number(count[1]), count[2]), base: Number(count[1]), multiplier: Number(count[2]), unit: 'ea', unspecified: false, note: raw};
  if (count[3]) return {quantity: Number(count[3]), base: 1, multiplier: Number(count[3]), unit: 'ea', unspecified: false, note: raw};
  if (count[4]) return {quantity: Number(count[4]), base: 1, multiplier: Number(count[4]), unit: 'ea', unspecified: false, note: raw};
  return {quantity: Number(count[5]), base: Number(count[5]), multiplier: 1, unit: 'ea', unspecified: false, note: raw};
}

/* ------------------------------------------------------------ Exclusions */

// General civil and installation work that Plasgain does not supply.
export const NON_SUPPLY_TERMS = ['trenching', 'trench', 'excavation', 'excavate', 'backfill', 'labour', 'labor',
  'installation', 'install only', 'concrete pour', 'concrete footing', 'mass concrete', 'blinding', 'compaction',
  'reinstatement', 'traffic control', 'survey', 'set out', 'testing and commissioning', 'commissioning', 'by others',
  'existing to remain', 'existing retained', 'remove existing', 'demolish', 'make good'];

export function exclusionTerms(catalogue = [], rules = []) {
  const fromItems = catalogue.flatMap(item => list(item.exclusion_notes));
  return [...new Set([...fromItems, ...list(rules)].map(term => normalize(term)).filter(Boolean))];
}

const containsPhrase = (label, phrase) => (' ' + label + ' ').includes(' ' + phrase + ' ');

/* --------------------------------------------------------------- Matching */

function identifiers(item) {
  return [item.sku, ...list(item.drawing_aliases), ...list(item.competitor_equivalents)].filter(Boolean);
}

const codeLike = value => /\d/.test(value) && /[a-z]/i.test(value) && value.replace(/\W/g, '').length >= 3;

// Stage two: match one drawing description against the active Item List.
// Returns a SKU only when the product type and its defining specifications
// line up with one active entry; otherwise it leaves the SKU blank and lists
// candidates with the reason.
export function matchItem(description, catalogue, aliases = {}, options = {}) {
  const label = normalize(description);
  const none = (confidence, reason, extra = {}) => ({sku: '', confidence, reason, candidates: [], ...extra});
  if (!label) return none('Low', 'No drawing description');

  const userAlias = aliases[label];
  const aliased = userAlias && catalogue.find(item => item.sku.toLowerCase() === String(userAlias).toLowerCase());
  const labelTokens = label.split(' ');
  const exact = aliased ? [{item: aliased, why: 'Saved correction alias'}] : catalogue.flatMap(item => {
    const hit = identifiers(item).find(value => {
      const code = normalize(value);
      return code === label || (codeLike(value) && containsPhrase(label, code));
    });
    if (hit) return [{item, why: (hit === item.sku ? 'Part number ' : 'Alias/competitor code ') + hit}];
    return normalize(item.description) === label ? [{item, why: 'Exact Item List description'}] : [];
  });

  const terms = options.exclusions ?? exclusionTerms(catalogue);
  const excludedBy = [...terms, ...NON_SUPPLY_TERMS.map(normalize)].find(term => containsPhrase(label, term));
  if (excludedBy && !exact.length) {
    return none('Low', 'Excluded: non-supply or exclusion rule "' + excludedBy + '"', {excluded: true});
  }

  const drawingSpecs = parseSpecs(description);
  const orEquivalent = /\b(or\s+(?:similar|equivalent|equal|approved\s+equivalent)|equivalent|approved\s+equal|similar\s+to|or\s+eq\.?)\b/i.test(description);

  if (exact.length === 1) {
    const {item, why} = exact[0];
    const {conflicts} = compareSpecs(drawingSpecs, itemSpecs(item));
    if (conflicts.length) {
      return {sku: '', confidence: 'Low', candidates: [item.sku],
        reason: why + ' but drawing ' + conflicts.join(', ') + ' (' + conflicts.map(kind => describeSpec(kind, drawingSpecs[kind])).join(', ') +
          ') conflicts with ' + item.sku + ' (' + conflicts.map(kind => describeSpec(kind, itemSpecs(item)[kind])).join(', ') + ')'};
    }
    return {sku: item.sku, confidence: orEquivalent ? 'Medium' : 'High', candidates: [],
      reason: why + (orEquivalent ? ' · "Or equivalent" wording on drawing, confirm' : '')};
  }
  if (exact.length > 1) {
    return {sku: '', confidence: 'Medium', candidates: exact.slice(0, 3).map(entry => entry.item.sku),
      reason: 'Several active SKUs share this code or description'};
  }

  // Words the Item List never uses (a maker's name such as "Sylvania") can't
  // tell its items apart, so they don't count against a match.
  const vocabulary = catalogueWords(catalogue);
  const allDrawn = words(description);
  const drawn = allDrawn.filter(word => vocabulary.has(word) || [...vocabulary].some(other => wordMatches(word, other)));
  if (!allDrawn.length) return none('Low', 'No product type words to match');
  if (!drawn.length) return none('Low', 'Unmatched: none of these words appear in the Item List');
  const conflicted = [];
  const scored = catalogue.flatMap(item => {
    const itemWords = wordsOf(item);
    const matched = drawn.filter(word => itemWords.some(other => wordMatches(word, other)));
    if (!matched.length) return [];
    const typeScore = matched.length / drawn.length;
    // Share of the Item List entry's own words found on the drawing, so a
    // "pit" callout prefers "Pit" over "Pit lid".
    const ownWords = [...new Set(words(item.description))];
    const coverage = ownWords.filter(word => drawn.some(other => wordMatches(word, other))).length / (ownWords.length || 1);
    const specs = compareSpecs(drawingSpecs, itemSpecs(item));
    if (specs.conflicts.length) { conflicted.push({item, specs}); return []; }
    const unmatched = ownWords.filter(word => !drawn.some(other => wordMatches(word, other)));
    return [{item, typeScore, coverage, matched, unmatched, ...specs}];
  }).sort((a, b) => b.typeScore - a.typeScore || b.agreed.length - a.agreed.length || b.coverage - a.coverage ||
    a.missing.length - b.missing.length);
  const weak = scored.filter(entry => entry.typeScore < 0.67 && !(drawn.length === 1 && entry.typeScore === 1));
  const strongEnough = scored.filter(entry => !weak.includes(entry));

  if (!strongEnough.length) {
    const conflictNote = conflicted.length ? ' · Same product type but conflicting specs: ' +
      conflicted.slice(0, 3).map(({item, specs}) => item.sku + ' (' + specs.conflicts.join(', ') + ')').join(', ') : '';
    return none('Low', 'Unmatched: no active SKU aligns on product type and specifications' + conflictNote +
      (weak.length ? ' · Loosely related items listed as candidates' : ''),
      {candidates: [...weak.slice(0, 3), ...conflicted.slice(0, 3)].slice(0, 3).map(entry => entry.item.sku)});
  }

  const [best] = strongEnough;
  const ties = strongEnough.filter(entry => entry.typeScore === best.typeScore && entry.coverage === best.coverage &&
    entry.missing.length === best.missing.length);
  const generic = drawn.length < 2 && !Object.keys(drawingSpecs).length;
  const candidates = strongEnough.slice(0, 3).map(entry => entry.item.sku);

  // A detail the drawing leaves out only matters when it would pick a
  // different item: the 1 kN base rating every URD column shares doesn't.
  const close = strongEnough.filter(entry => entry !== best && entry.typeScore >= best.typeScore - 0.01);
  const deciders = best.missing.filter(kind => close.some(entry =>
    describeSpec(kind, itemSpecs(entry.item)[kind] || []) !== describeSpec(kind, itemSpecs(best.item)[kind])));
  // Another item that fits the drawing just as well is a real choice, unless
  // it is the same item with extras (a "Reversed Panel Door" version).
  const rivals = close.filter(entry => entry.agreed.length === best.agreed.length &&
    !best.unmatched.every(word => entry.unmatched.includes(word)));
  if (ties.length === 1 && !generic && best.typeScore >= 0.8 && !deciders.length && !rivals.length &&
      (best.agreed.length || !Object.keys(itemSpecs(best.item)).length)) {
    const ignored = allDrawn.filter(word => !drawn.includes(word));
    const strong = best.typeScore === 1 && best.agreed.length > 0 && !orEquivalent && !best.missing.length && !ignored.length;
    return {sku: best.item.sku, confidence: strong ? 'High' : 'Medium',
      candidates: strongEnough.slice(1, 3).filter(entry => entry.typeScore >= 0.8).map(entry => entry.item.sku),
      reason: 'Type and specs align' + (best.agreed.length ? ' (' + best.agreed.join(', ') + ')' : '') +
        (best.typeScore < 1 ? ' · Some drawing words not in Item List description' : '') +
        (ignored.length ? ' · Not in Item List, ignored: ' + [...new Set(ignored)].join(', ') : '') +
        (best.missing.length ? ' · Drawing does not state ' + best.missing.map(kind => kind + ' (' + describeSpec(kind, itemSpecs(best.item)[kind]) + ')').join(', ') + ', check' : '') +
        (orEquivalent ? ' · "Or equivalent" wording on drawing, confirm' : '')};
  }

  // Explain which detail would decide between the remaining candidates.
  const deciding = [...new Set(ties.flatMap(entry => entry.missing))];
  const missingNote = deciding.length ? 'Missing ' + deciding.join(', ') + ' on drawing: ' + ties.slice(0, 3).map(entry =>
    entry.item.sku + ' ' + deciding.map(kind => itemSpecs(entry.item)[kind] ? describeSpec(kind, itemSpecs(entry.item)[kind]) : '').join(' ').trim()).join(' / ') : '';
  const reason = generic ? 'Generic label, choose from candidates' + (missingNote ? ' · ' + missingNote : '') :
    missingNote || (ties.length > 1 || rivals.length ? 'Several active SKUs fit equally, choose one' : 'Partial description match, check type and specs');
  return {sku: '', confidence: best.typeScore >= 0.8 && !generic ? 'Medium' : 'Low', candidates, reason, missing: deciding};
}

const wordCache = new WeakMap();
function wordsOf(item) {
  if (!wordCache.has(item)) wordCache.set(item, words([item.description, item.category, item.subcategory, ...list(item.drawing_aliases)].join(' ')));
  return wordCache.get(item);
}

const vocabularyCache = new WeakMap();
function catalogueWords(catalogue) {
  if (!vocabularyCache.has(catalogue)) vocabularyCache.set(catalogue, new Set(catalogue.flatMap(wordsOf)));
  return vocabularyCache.get(catalogue);
}

const specCache = new WeakMap();
function itemSpecs(item) {
  if (!specCache.has(item)) specCache.set(item, parseSpecs([item.description, item.specifications].filter(Boolean).join(' ')));
  return specCache.get(item);
}

/* ---------------------------------------------------- Text-only extraction */

const LINE_PATTERN = /^(?:(schedule|callout)\s*[:–-]\s*)?(.+?)\s+(?:qty\s*[:=]?\s*|quantity\s*[:=]?\s*|length\s*[:=]?\s*|[x×]\s*(?=\d))(\d+(?:\.\d+)?|as required|as req'?d|tba|tbc)(?:\s*(mm|m|lm|ea|each|no\.?|off)\b)?(?:\s*[x×]\s*(\d+))?\s*$/i;
const LEADING_COUNT = /^(\d+)\s*(?:[x×]|no\.?|off)\s+(.{3,})$/i;

// Fallback reader for searchable PDFs when the AI reader is not configured.
// It only reads quantities that are written out; it never counts symbols.
export function extractRows(lines) {
  return lines.flatMap(({text, ...location}) => {
    const match = text.match(LINE_PATTERN);
    const leading = !match && text.match(LEADING_COUNT);
    if (!match && !leading) return [];
    let description, quantityText, source;
    if (match) {
      const [, label, , rawQuantity, rawUnit, times] = match;
      description = match[2];
      quantityText = rawQuantity + (rawUnit ? ' ' + rawUnit : '') + (times ? ' x ' + times : '');
      source = label?.toLowerCase();
      if (/^\s*[x×]/.test(text.slice(text.indexOf(description) + description.length))) {
        // "1.7m x 2.3m" or "679 x 960" is a size, not a count.
        if (/\d(?:\.\d+)?\s*(?:mm|m)?$/i.test(description) || !/^\d+$/.test(rawQuantity) || rawUnit) return [];
        quantityText = 'x' + rawQuantity;
      }
    } else {
      description = leading[2];
      quantityText = leading[1];
    }
    const parsed = parseQuantity(quantityText);
    description = description.replace(/^\s*typ(?:ical|\.)?\s+(?:detail|section)\s*[:\-]?\s*/i, '');
    return [{...location, text, description: description.trim(),
      source: parsed.unspecified ? 'unspecified' : (source || 'callout'),
      quantity: parsed.quantity, unit: parsed.unit, baseNote: parsed.multiplier > 1 ? parsed.note : '',
      typical: /\btyp(?:ical|\.)?\b/i.test(text)}];
  });
}

// Read schedule tables from positioned text lines. A header line naming a
// description column and a quantity column starts a table; each later line is
// split into cells by the header's column positions.
export function extractScheduleRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!header.cells?.length) continue;
    const names = header.cells.map(cell => cell.text.toLowerCase());
    const qtyCol = names.findIndex(name => /^(qty|quantity|no\.?|number|count)$/.test(name.trim()));
    const descPatterns = [/description/, /fitting|product|luminaire|item/, /type/];
    const descCol = descPatterns.map(re => names.findIndex((name, index) => index !== qtyCol && re.test(name))).find(index => index >= 0) ?? -1;
    if (qtyCol < 0 || descCol < 0 || qtyCol === descCol) continue;
    const lengthCol = names.findIndex(name => /length|run/.test(name));
    // Headings are often centred over left-aligned values, so compare cell
    // centres with the midpoints between heading centres.
    const centre = cell => (cell.x + (cell.end ?? cell.x)) / 2;
    const columns = header.cells.map(centre);
    const nearest = x => columns.reduce((best, col, index) => Math.abs(col - x) < Math.abs(columns[best] - x) ? index : best, 0);
    let previous = header;
    let spacing = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.cells?.length || line.pageId !== header.pageId) break;
      // A big vertical gap means the table has ended.
      const gap = Math.abs((previous.point?.[1] ?? 0) - (line.point?.[1] ?? 0));
      spacing ??= gap;
      if (spacing && gap > spacing * 2.5) break;
      previous = line;
      const cells = {};
      for (const cell of line.cells) (cells[nearest(centre(cell))] ||= []).push(cell.text);
      const description = (cells[descCol] || []).join(' ').trim();
      const quantityText = (cells[lengthCol] || cells[qtyCol] || []).join(' ').trim();
      if (!description && !quantityText) break;
      if (/^(total|notes?)\b/i.test(description)) break;
      if (!description) continue;
      const parsed = parseQuantity(quantityText || 'TBA');
      const labelCells = Object.entries(cells).filter(([col]) => Number(col) !== descCol && Number(col) !== qtyCol && Number(col) !== lengthCol)
        .map(([, text]) => text.join(' '));
      rows.push({pageId: line.pageId, point: line.point, text: line.text,
        description: [labelCells.find(text => /^[A-Z]{1,4}\d{0,3}$/.test(text.trim())), description].filter(Boolean).join(' ').trim(),
        source: parsed.unspecified ? 'unspecified' : 'schedule', quantity: parsed.quantity, unit: parsed.unit,
        baseNote: parsed.multiplier > 1 ? parsed.note : '', typical: false});
      i = j;
    }
  }
  return rows;
}

/* -------------------------------------------------------------- Title block */

const STATUSES = ['NOT FOR CONSTRUCTION', 'FOR CONSTRUCTION', 'ISSUED FOR CONSTRUCTION', 'CONSTRUCTION ISSUE', 'TENDER',
  'FOR TENDER', 'PRELIMINARY', 'FOR APPROVAL', 'FOR INFORMATION', 'FOR REVIEW', 'AS BUILT', 'AS CONSTRUCTED', 'DRAFT', 'SUPERSEDED'];

export function parseTitleBlock(text) {
  const source = String(text || '');
  const pick = re => source.match(re)?.[1]?.trim() || '';
  const upper = source.toUpperCase();
  const status = STATUSES.find(value => upper.includes(value)) || '';
  return {
    project: pick(/\bproject(?:\s+(?:name|title))?\s*[:\-]\s*([^\n|]{3,80})/i),
    // A drawing number always has a digit, so headings that follow the label (DATE, SCALE) are skipped.
    drawingNumber: pick(/\b(?:dwg|drawing|sheet)\s*(?:no\.?|number|#)\s*[:\-]?\s*(?=[A-Z0-9\-_./]*\d)([A-Z0-9][A-Z0-9\-_./]{2,30})/i),
    revision: pick(/\brev(?:ision)?\.?\s*(?:no\.?)?\s*[:\-]?\s*([A-Z]{1,2}\d{0,2}|\d{1,3})\b/i),
    status: status === 'FOR TENDER' ? 'TENDER' : status,
  };
}

// Compare drawing revisions. Letters are preliminary issues and numbers are
// construction issues, so "1" is later than "C"; P-prefixed revisions are
// preliminary as well.
export function compareRevision(a, b) {
  const rank = value => {
    const text = String(value || '').toUpperCase().trim();
    if (!text) return [-1, 0];
    if (/^\d+$/.test(text)) return [2, Number(text)];
    if (/^P\d+$/.test(text)) return [0, Number(text.slice(1))];
    if (/^[A-Z]+\d*$/.test(text)) {
      const letters = text.match(/^[A-Z]+/)[0];
      return [1, [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) * 100 + Number(text.slice(letters.length) || 0)];
    }
    return [0, 0];
  };
  const [ra, va] = rank(a), [rb, vb] = rank(b);
  return ra - rb || va - vb;
}

/* ----------------------------------------------- Count and duplicate rules */

const pageLabel = page => page ? page.file + ' p' + page.number : 'page ?';

// Apply the brief's quantity rules to the whole takeoff. Each row keeps its own
// match result (row.matchConfidence, row.reason); this adds row.flags,
// row.autoExcluded and the final row.confidence. The user's own include or
// exclude choice (row.userExcluded) always wins.
export function reconcile(rows, pages = []) {
  const pageOf = row => pages[row.pageId];
  for (const row of rows) {
    row.flags = [];
    row.autoExcluded = false;
    row.confidence = lowest(row.matchConfidence || 'High', row.extractConfidence || 'High');
    if (row.extractNote) row.flags.push(row.extractNote);
    if (row.scheduleNote) row.flags.push(row.scheduleNote);
    if (row.matchExcluded) { row.autoExcluded = true; }
    if (row.quantity == null) {
      row.flags.push(row.unit === 'm' ? 'Length unspecified (as required / TBA), measure or confirm' : 'Quantity unspecified, confirm');
      row.confidence = 'Low';
    }
    if (row.baseNote) row.flags.push('Multiplier note "' + row.baseNote + '" gives ' + row.quantity);
  }

  // Superseded revisions: the same drawing number with an older revision.
  const byDrawing = Map.groupBy(pages.filter(page => page?.meta?.drawingNumber), page => page.meta.drawingNumber.toUpperCase());
  const superseded = new Map();
  for (const sheetPages of byDrawing.values()) {
    const revisions = [...new Set(sheetPages.map(page => page.meta.revision || ''))];
    if (revisions.length < 2) continue;
    const latest = revisions.reduce((a, b) => compareRevision(b, a) > 0 ? b : a);
    for (const page of sheetPages) {
      if ((page.meta.revision || '') !== latest) superseded.set(page.id, latest);
      else page.latestOf = revisions.length;
    }
  }
  for (const row of rows) {
    const page = pageOf(row);
    if (page && superseded.has(page.id)) {
      row.autoExcluded = true;
      row.confidence = 'Low';
      row.flags.push('Superseded revision ' + (page.meta.revision || '(none)') + ' of ' + page.meta.drawingNumber + ', latest in this upload is ' + superseded.get(page.id));
    } else if (page?.latestOf) {
      row.flags.push('Older revisions of ' + page.meta.drawingNumber + ' are also in this upload');
    }
    if (row.typical) {
      row.autoExcluded = true;
      row.flags.push('Found in a typical detail or section, not added to plan counts');
    }
  }

  const live = rows.filter(row => !row.autoExcluded && !row.userExcluded && row.source !== 'manual');
  const groups = Map.groupBy(live, row => (row.sku ? 'sku:' + row.sku.toLowerCase() : 'text:' + normalize(row.description)) + '|' + row.unit);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const topRank = Math.max(...group.map(row => SOURCE_RANK[row.source] ?? 0));
    const top = group.filter(row => (SOURCE_RANK[row.source] ?? 0) === topRank);
    const lower = group.filter(row => !top.includes(row));
    const topTotal = top.reduce((sum, row) => sum + (row.quantity ?? 0), 0);
    const where = rows => [...new Set(rows.map(row => pageLabel(pageOf(row))))].join(', ');

    for (const row of lower) {
      // Separate linear runs are only overridden by a schedule length.
      if (row.unit === 'm' && topRank !== SOURCE_RANK.schedule) continue;
      row.autoExcluded = true;
      row.flags.push('Potential Duplicate (Excluded from Total): ' + top[0].source + ' on ' + where(top) + ' takes priority over ' + row.source);
      if (row.quantity != null && row.unit !== 'm' && row.quantity !== topTotal) {
        row.confidence = 'Low';
        row.flags.push('Count conflict: ' + row.source + ' shows ' + row.quantity + ', ' + top[0].source + ' shows ' + topTotal + '. Not averaged, confirm');
        for (const kept of top) {
          kept.confidence = 'Low';
          kept.flags.push('Count conflict: ' + row.source + ' on ' + pageLabel(pageOf(row)) + ' shows ' + row.quantity + ' vs ' + topTotal + '. Not averaged, confirm');
        }
      }
    }

    if (top.length < 2) continue;
    const topPages = new Set(top.map(row => row.pageId));
    if (group[0].unit === 'm') {
      const runs = top.length;
      const total = +top.reduce((sum, row) => sum + (row.quantity ?? 0), 0).toFixed(3);
      for (const row of top) {
        row.flags.push(row.sku ? 'Run ' + (top.indexOf(row) + 1) + ' of ' + runs + ', total ' + total + ' m across ' + where(top)
          : 'Separate run, not summed until a SKU is confirmed');
      }
      continue;
    }
    if (topRank === SOURCE_RANK.schedule && topPages.size > 1) {
      const values = [...new Set(top.map(row => row.quantity))];
      if (values.length === 1) {
        // The same schedule repeated on several sheets: count it once.
        const [first, ...repeats] = top;
        for (const row of repeats) {
          row.autoExcluded = true;
          row.flags.push('Potential Duplicate (Excluded from Total): same schedule entry as ' + pageLabel(pageOf(first)));
        }
      } else {
        for (const row of top) {
          row.confidence = 'Low';
          row.flags.push('Count conflict between schedules: ' + top.map(other => (other.quantity ?? '?') + ' on ' + pageLabel(pageOf(other))).join(' vs ') + '. Not averaged, confirm');
        }
      }
    } else if (topPages.size > 1) {
      for (const row of top) {
        row.confidence = lowest(row.confidence, 'Medium');
        row.flags.push('Also on ' + where(top.filter(other => other.pageId !== row.pageId)) + '. Confirm separate areas, not overlapping key plans');
      }
    }
  }

  for (const row of rows) row.excluded = row.userExcluded ?? row.autoExcluded;
  return rows;
}

// Kept for older callers.
export const flagDuplicates = reconcile;

/* ---------------------------------------------------------- Packs & totals */

export function packs(item, row) {
  const size = Number(item?.pack_size);
  if (!(size > 1) || row.quantity == null) return '';
  const unit = (item.pack_unit || item.unit || 'ea').toLowerCase();
  const rowUnit = row.unit === 'm' ? 'm' : 'ea';
  if ((unit === 'm' || unit === 'lm' || unit === 'metre') !== (rowUnit === 'm')) return '';
  return Math.ceil(+(row.quantity / size).toFixed(6));
}

export function accessoriesFor(item, catalogue) {
  return list(item?.required_accessories).map(code => {
    const match = catalogue.find(other => other.sku.toLowerCase() === code.toLowerCase());
    return match ? match.sku + ' ' + match.description : code;
  });
}

// Combine verified rows into quote lines: one per SKU and unit, with page
// references and source wording carried through.
export function quoteLines(rows, catalogue, pages = []) {
  const bySku = new Map(catalogue.map(item => [item.sku.toLowerCase(), item]));
  const usable = rows.filter(row => row.verified && !row.excluded && row.sku && bySku.has(row.sku.toLowerCase()) &&
    Number.isFinite(row.quantity) && row.quantity > 0);
  const groups = Map.groupBy(usable, row => row.sku.toLowerCase() + '|' + row.unit);
  return [...groups.values()].map(group => {
    const item = bySku.get(group[0].sku.toLowerCase());
    const quantity = +group.reduce((sum, row) => sum + row.quantity, 0).toFixed(3);
    return {
      sku: item.sku, description: item.description, quantity, unit: group[0].unit,
      packSize: Number(item.pack_size) > 1 ? Number(item.pack_size) : '',
      packs: packs(item, {quantity, unit: group[0].unit}),
      accessories: accessoriesFor(item, catalogue).join('; '),
      references: group.map(row => {
        const page = pages[row.pageId];
        const sheet = page?.meta?.drawingNumber ? page.meta.drawingNumber + (page.meta.revision ? ' rev ' + page.meta.revision : '') + ', ' : '';
        return sheet + pageLabel(page) + ' (' + row.source + ': ' + row.quantity + ')';
      }).join('; '),
      wording: [...new Set(group.map(row => row.text).filter(Boolean))].join(' | '),
      lines: group.length,
    };
  });
}
