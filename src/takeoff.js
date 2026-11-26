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

export function readCatalogue(text) {
  const [headers = [], ...records] = readCsv(text.replace(/^\uFEFF/, ''));
  const keys = headers.map(header => header.trim().toLowerCase().replace(/\s+/g, '_'));
  for (const required of ['sku', 'description', 'status']) {
    if (!keys.includes(required)) throw new Error('Missing Item List column: ' + required);
  }
  const active = records.map(record => Object.fromEntries(keys.map((key, i) => [key, record[i]?.trim() ?? ''])))
    .filter(item => item.status.toLowerCase() === 'active' && item.sku && item.description);
  if (new Set(active.map(item => item.sku.toLowerCase())).size !== active.length) {
    throw new Error('The Item List contains duplicate active SKUs.');
  }
  return active;
}

export function normalize(text) {
  return text.toLowerCase().replace(/\b(\d+(?:\.\d+)?)\s*(mm|m)\b/g, (_, value, unit) =>
    String(Number(value) * (unit === 'm' ? 1000 : 1)) + 'mm'
  ).replace(/[^a-z0-9.]+/g, ' ').trim();
}

const list = value => (value || '').split(/[|;]/).map(value => value.trim()).filter(Boolean);

export function matchItem(description, catalogue, aliases = {}) {
  const label = normalize(description);
  if (!label) return {sku: '', confidence: 'Low', reason: 'No drawing description', candidates: []};
  const usable = catalogue.filter(item => !list(item.exclusion_notes).some(note => normalize(note) === label));
  const exact = usable.filter(item =>
    [item.sku, item.description, ...list(item.drawing_aliases), ...list(item.competitor_equivalents)]
      .some(value => normalize(value) === label) || aliases[label] === item.sku
  );
  if (exact.length === 1) return {sku: exact[0].sku, confidence: 'High', reason: 'Exact catalogue or alias match', candidates: []};
  const words = label.split(' ').filter(word => word.length > 2);
  const candidates = exact.length ? exact : usable.map(item => ({
    sku: item.sku,
    score: words.filter(word => normalize(item.description).split(' ').includes(word)).length
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return {sku: '', confidence: candidates.length ? 'Medium' : 'Low',
    reason: exact.length ? 'Multiple catalogue items share this label' :
      candidates.length ? 'Check product type and defining specifications' : 'No clear active SKU match',
    candidates: candidates.slice(0, 3).map(item => item.sku)};
}

export function extractRows(lines) {
  return lines.flatMap(({text, ...location}) => {
    const match = text.match(/^(?:(schedule|callout)\s*[:–-]\s*)?(.+?)\s+(?:qty\s*[:=]?\s*|length\s*[:=]?\s*)(\d+(?:\.\d+)?|as required|TBA)(?:\s*(mm|m|ea|each)\b)?(?:\s*x\s*(\d+))?\s*$/i);
    if (!match) return [];
    const [, source, description, rawQuantity, rawUnit, multiplier] = match;
    if (/^(?:trenching|labou?r|excavation|installation|concrete)$/i.test(description.trim())) return [];
    const unit = rawUnit?.toLowerCase();
    const quantity = Number(rawQuantity);
    return [{...location, text, description, source: Number.isFinite(quantity) ? (source?.toLowerCase() || 'callout') : 'unspecified',
      quantity: Number.isFinite(quantity) ? quantity * Number(multiplier || 1) / (unit === 'mm' ? 1000 : 1) : null,
      unit: unit === 'mm' || unit === 'm' ? 'm' : 'ea'}];
  });
}

export function flagDuplicates(rows) {
  const groups = Map.groupBy(rows, row => (row.sku || normalize(row.description)) + '|' + row.unit);
  for (const group of groups.values()) {
    const schedules = group.filter(row => row.source === 'schedule');
    for (const row of group) {
      const others = group.filter(other => other !== row && other.pageId !== row.pageId);
      if (others.length === 0) continue;
      const conflict = others.some(other => other.quantity !== null && row.quantity !== null && other.quantity !== row.quantity);
      if (row.source !== 'schedule' && schedules.some(schedule => schedule.pageId !== row.pageId)) {
        row.excluded = true;
        row.reason += ' · Potential duplicate of schedule';
      } else {
        row.reason += ' · Check overlap across sheets';
      }
      if (conflict) {
        row.confidence = 'Low';
        row.reason += ' · Conflicting drawing quantities: ' + [...new Set(group.map(item => item.quantity).filter(value => value !== null))].join(', ');
      }
    }
  }
  return rows;
}

export function quoteCsv(rows) {
  return rows.map(record => record.map(value => {
    const text = String(value ?? '');
    const safe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}
