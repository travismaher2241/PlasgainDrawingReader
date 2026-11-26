// Checks AI extraction output against the drawing before it becomes takeoff rows.
// The AI is never asked for part numbers; anything it returns is treated as a
// claim about the drawing that must cite wording we can check.

import {normalize, parseQuantity} from './takeoff.js';

export const COUNT_METHODS = ['schedule', 'callout', 'counted', 'unspecified'];
export const LOCATIONS = ['schedule', 'callout', 'plan_view', 'legend', 'typical_detail', 'section', 'notes', 'title_block', 'other'];

// JSON schema the AI must answer with (stage 1: extraction only).
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title_block: {
      type: 'object',
      properties: {
        project: {type: 'string', description: 'Project name exactly as printed, or empty if not visible'},
        drawing_number: {type: 'string', description: 'Drawing number exactly as printed, or empty'},
        drawing_title: {type: 'string', description: 'Drawing title, or empty'},
        revision: {type: 'string', description: 'Current revision letter or number, or empty'},
        status: {type: 'string', description: 'Issue status such as TENDER or FOR CONSTRUCTION, or empty'},
      },
      required: ['project', 'drawing_number', 'drawing_title', 'revision', 'status'],
    },
    page_kind: {type: 'string', enum: ['plan', 'schedule', 'detail', 'notes', 'cover', 'mixed', 'other']},
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: {type: 'string', description: 'Product description from the drawing, with every stated size, rating, material and finish'},
          source_quote: {type: 'string', description: 'The exact wording or label seen on the drawing for this item, copied character for character'},
          location: {type: 'string', enum: LOCATIONS},
          location_note: {type: 'string', description: 'Where on the sheet, e.g. "Luminaire schedule, top right" or "plan view near grid C4"'},
          count_method: {type: 'string', enum: COUNT_METHODS},
          quantity_text: {type: 'string', description: 'Quantity or length exactly as written, e.g. "4", "3x", "6.5m", "as required". For counted symbols, the number counted'},
          quantity: {type: ['number', 'null'], description: 'Total count, or total length in metres. Null when not stated'},
          unit: {type: 'string', enum: ['ea', 'm']},
          multiplier_note: {type: 'string', description: 'Multiplier note such as "x4" if one applies, otherwise empty'},
          or_equivalent: {type: 'boolean', description: 'True if the drawing says "or similar", "or equivalent" or gives a range'},
          uncertainty: {type: 'string', description: 'Exact reason for any doubt (overlapping symbols, near crop, hard to read, conflicts with another view). Empty if none'},
          box: {
            type: ['object', 'null'],
            description: 'Approximate location as fractions of the full page (0 to 1, origin top left), or null',
            properties: {x0: {type: 'number'}, y0: {type: 'number'}, x1: {type: 'number'}, y1: {type: 'number'}},
            required: ['x0', 'y0', 'x1', 'y1'],
          },
        },
        required: ['description', 'source_quote', 'location', 'location_note', 'count_method', 'quantity_text', 'quantity',
          'unit', 'multiplier_note', 'or_equivalent', 'uncertainty', 'box'],
      },
    },
  },
  required: ['title_block', 'page_kind', 'items'],
};

const tokens = text => normalize(text).split(' ').filter(Boolean);

// Find the text-layer line(s) holding the quoted wording. Returns the best line
// and the share of the quote's words found there.
export function locateQuote(quote, lines) {
  const wanted = tokens(quote);
  if (!wanted.length || !lines?.length) return {score: 0, line: null};
  const scoreOf = group => {
    const have = new Set(group.flatMap(line => tokens(line.text)));
    return wanted.filter(word => have.has(word)).length / wanted.length;
  };
  let best = {score: 0, line: null};
  // Prefer a single line; fall back to short windows for quotes that wrap.
  for (const size of [1, 3]) {
    for (let i = 0; i < lines.length; i++) {
      const score = scoreOf(lines.slice(i, i + size));
      if (score > best.score + 1e-9) best = {score, line: lines[i]};
      if (score === 1) return best;
    }
    if (best.score >= 0.75) return best;
  }
  return best;
}

// Turn one page of AI output into takeoff rows, checking each claim.
export function groundExtraction(output, {pageId, lines = [], width = 1, height = 1} = {}) {
  const rows = [];
  const dropped = [];
  const hasTextLayer = lines.some(line => line.text?.trim());
  for (const item of Array.isArray(output?.items) ? output.items : []) {
    const quote = String(item.source_quote || '').trim();
    const description = String(item.description || '').trim();
    if (!quote || !description) { dropped.push(description || quote || '(blank item)'); continue; }

    const notes = [];
    let confidence = 'High';
    const lower = level => { if (level === 'Low' || confidence === 'High') confidence = level; };

    const method = COUNT_METHODS.includes(item.count_method) ? item.count_method : 'unspecified';
    const unit = item.unit === 'm' ? 'm' : 'ea';
    let quantity = Number.isFinite(item.quantity) && item.quantity >= 0 ? item.quantity : null;

    // Cross-check the AI's number against the wording it quoted.
    const written = parseQuantity(String(item.quantity_text || '') + (item.multiplier_note ? ' ' + item.multiplier_note : ''));
    if (method !== 'counted' && !written.unspecified && written.quantity != null && quantity != null &&
        written.unit === unit && Math.abs(written.quantity - quantity) > 0.001) {
      notes.push('AI total ' + quantity + ' differs from written "' + item.quantity_text + '"');
      lower('Low');
    }
    // "As required" / "TBA" stays unspecified rather than a guessed number.
    if (method === 'unspecified' || (method !== 'counted' && written.unspecified && /\S/.test(item.quantity_text || ''))) quantity = null;
    if (method === 'counted') { notes.push('Counted from symbols on the sheet, check count'); lower('Medium'); }
    if (unit === 'm' && method === 'counted') { notes.push('Length measured from the drawing, not stated. Measure manually'); quantity = null; lower('Low'); }

    let point = null;
    const found = locateQuote(quote, lines);
    if (found.score >= 0.75) {
      point = found.line.point;
    } else if (hasTextLayer && method !== 'counted') {
      notes.push('Quoted wording not found in the PDF text, check it on the sheet');
      lower('Low');
    } else if (!hasTextLayer) {
      notes.push('No text layer on this page, read from the image');
      lower('Medium');
    }
    const box = item.box && [item.box.x0, item.box.y0, item.box.x1, item.box.y1].every(Number.isFinite) ? item.box : null;
    if (!point && box) point = [((box.x0 + box.x1) / 2) * width, (1 - (box.y0 + box.y1) / 2) * height];

    if (item.uncertainty?.trim()) { notes.push(item.uncertainty.trim()); lower('Medium'); }
    if (item.or_equivalent) notes.push('"Or equivalent" wording');

    rows.push({
      pageId, point, approximate: !found.line || found.score < 0.75,
      text: quote, description, source: method,
      location: LOCATIONS.includes(item.location) ? item.location : 'other', locationNote: String(item.location_note || ''),
      quantity, unit, baseNote: item.multiplier_note ? (item.quantity_text + ' ' + item.multiplier_note).trim() : '',
      typical: item.location === 'typical_detail' || item.location === 'section',
      extractConfidence: confidence, extractNote: notes.join(' · '),
    });
  }
  const block = output?.title_block || {};
  return {
    rows, dropped,
    titleBlock: {project: block.project || '', drawingNumber: block.drawing_number || '', drawingTitle: block.drawing_title || '',
      revision: block.revision || '', status: (block.status || '').toUpperCase()},
    pageKind: output?.page_kind || 'other',
  };
}
