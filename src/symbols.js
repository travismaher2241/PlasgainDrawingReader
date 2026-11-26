// Legend symbol counting for vector (CAD) drawings.
//
// A lighting legend draws each symbol beside its wording, for example an oval
// lantern symbol beside "14W LED ... LANTERN / ON A 5.5m ... POLE". This module
// reads the symbol's vector paths from the legend, then finds every copy of the
// same shape on the plan (any rotation or mirror image, same scale) and counts
// them. Pure functions: the caller supplies pdf.js operator lists and text.

const LEGEND_WORDS = /\b(LANTERN|LUMINAIRE|LIGHT|STREETLED|FLOODLIGHT|BOLLARD|LED)\b/i;
const POLE_WORDS = /\bPOLE|COLUMN|OUTREACH|BRACKET|MOUNTING HEIGHT\b/i;

/* ----------------------------------------------------------- vector paths */

const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

// Turns a pdf.js operator list into simple path primitives in PDF page units
// (origin bottom left): {key, length, cx, cy, box}. `key` describes the shape
// (number of curve and line segments), `length` its control-polygon length;
// both stay the same when the path is rotated or mirrored.
export function pathPrimitives(operatorList, OPS) {
  const {fnArray, argsArray} = operatorList;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.constructPath) {
      const data = args?.[1]?.[0];
      if (data && typeof data.length === 'number') addSubpaths(data, ctm, out);
    }
  }
  return out;
}

// pdf.js path data: 0 moveTo x y, 1 lineTo x y, 2 curveTo x1 y1 x2 y2 x y, 3 quadraticCurveTo, 4 closePath.
function addSubpaths(data, ctm, out) {
  let points = [];
  let lines = 0, curves = 0, closed = false;
  const flush = () => {
    if (points.length > 1 && lines + curves > 0) out.push(primitive(points, lines, curves, closed));
    points = []; lines = 0; curves = 0; closed = false;
  };
  const at = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  for (let j = 0; j < data.length;) {
    const op = data[j++];
    if (op === 0) { flush(); points.push(at(data[j], data[j + 1])); j += 2; }
    else if (op === 1) { points.push(at(data[j], data[j + 1])); lines++; j += 2; }
    else if (op === 2) { points.push(at(data[j], data[j + 1]), at(data[j + 2], data[j + 3]), at(data[j + 4], data[j + 5])); curves++; j += 6; }
    else if (op === 3) { points.push(at(data[j], data[j + 1]), at(data[j + 2], data[j + 3])); curves++; j += 4; }
    else if (op === 4) { closed = true; }
    else break; // unknown command: stop reading this path
  }
  flush();
}

function primitive(points, lines, curves, closed) {
  let length = 0;
  for (let k = 1; k < points.length; k++) length += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
  if (closed) length += Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return {key: curves + 'C' + lines + 'L' + (closed ? 'Z' : ''), length, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, box};
}

/* ---------------------------------------------------------------- legend */

// Finds legend entries: a light or luminaire line, optionally followed by a pole
// line, with room on the left for a symbol. `items` are pdf.js text items
// ({str, transform}) in PDF units. Returns [{label, pole, x, y, height}].
export function legendEntries(items) {
  const lines = items.filter(item => item.str?.trim() && Math.abs(item.transform[1]) < 0.01 && Math.abs(item.transform[2]) < 0.01)
    .map(item => ({text: item.str.trim(), x: item.transform[4], y: item.transform[5], height: Math.abs(item.transform[3]) || 10}));
  const entries = [];
  for (const line of lines) {
    if (!LEGEND_WORDS.test(line.text) || !/\d+\s*W\b|LANTERN|LUMINAIRE/i.test(line.text) || line.text.length > 90) continue;
    if (/^\d+\.\s/.test(line.text)) continue; // a numbered note, not a legend line
    // The pole wording is usually the next line down, starting at the same x.
    const next = lines.filter(other => Math.abs(other.x - line.x) < 2 && other.y < line.y && line.y - other.y < line.height * 2)
      .sort((a, b) => b.y - a.y)[0];
    const pole = next && POLE_WORDS.test(next.text) && !LEGEND_WORDS.test(next.text.replace(/MOUNTING HEIGHT/i, '')) ? next.text : '';
    entries.push({label: line.text, pole, x: line.x, y: line.y, height: line.height});
  }
  return entries;
}

// The symbol drawn just left of a legend entry: paths whose box lies inside a
// band left of the wording. Returns the template, or null when nothing is there.
export function legendSymbol(entry, primitives) {
  const left = entry.x - entry.height * 7, right = entry.x - entry.height * 0.2;
  const bottom = entry.y - entry.height * 0.6, top = entry.y + entry.height * 1.6;
  const parts = primitives.filter(p => p.length > 0.5 && p.box[0] >= left && p.box[2] <= right && p.box[1] >= bottom && p.box[3] <= top);
  if (parts.length < 2) return null;
  // Keep the cluster nearest the wording, so another column's symbols don't join in.
  parts.sort((a, b) => b.box[2] - a.box[2]);
  const cluster = [parts[0]];
  for (const part of parts.slice(1)) {
    if (cluster.some(c => part.box[2] >= c.box[0] - entry.height * 0.5 && part.box[0] <= c.box[2] + entry.height * 0.5)) cluster.push(part);
  }
  if (cluster.length < 2) return null;
  const box = [Math.min(...cluster.map(p => p.box[0])), Math.min(...cluster.map(p => p.box[1])),
    Math.max(...cluster.map(p => p.box[2])), Math.max(...cluster.map(p => p.box[3]))];
  return {parts: cluster, box, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2};
}

/* -------------------------------------------------------------- matching */

const sameShape = (a, b) => a.key === b.key && Math.abs(a.length - b.length) <= 0.5 + 0.2 * b.length;

function grid(primitives, size) {
  const cells = new Map();
  for (const p of primitives) {
    const key = Math.floor(p.cx / size) + ',' + Math.floor(p.cy / size);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  return (x, y, radius) => {
    const found = [];
    for (let gx = Math.floor((x - radius) / size); gx <= Math.floor((x + radius) / size); gx++) {
      for (let gy = Math.floor((y - radius) / size); gy <= Math.floor((y + radius) / size); gy++) {
        for (const p of cells.get(gx + ',' + gy) || []) if (Math.hypot(p.cx - x, p.cy - y) <= radius) found.push(p);
      }
    }
    return found;
  };
}

// Finds every copy of a legend symbol: same parts at the same distances, in any
// rotation or mirror image, at the legend's scale. Returns [{x, y}] centres in
// PDF units, leaving out the legend symbol itself.
export function findSymbol(template, primitives) {
  const parts = template.parts.filter(p => p.length > 0.5);
  if (parts.length < 2) return [];
  const span = Math.max(template.box[2] - template.box[0], template.box[3] - template.box[1]);
  const near = grid(primitives, Math.max(span, 4));
  // Anchor on the rarest part, and orient with the part farthest from it.
  const candidates = part => primitives.filter(p => sameShape(p, part));
  const ranked = parts.map(part => ({part, count: candidates(part).length})).sort((a, b) => a.count - b.count);
  const anchor = ranked[0].part;
  const partner = parts.filter(p => p !== anchor).sort((a, b) =>
    Math.hypot(b.cx - anchor.cx, b.cy - anchor.cy) - Math.hypot(a.cx - anchor.cx, a.cy - anchor.cy))[0];
  const reach = Math.hypot(partner.cx - anchor.cx, partner.cy - anchor.cy);
  if (reach < 1) return [];
  const baseAngle = Math.atan2(partner.cy - anchor.cy, partner.cx - anchor.cx);
  const tolerance = d => 1.2 + 0.08 * d;
  const found = [];
  for (const a of candidates(anchor)) {
    for (const b of near(a.cx, a.cy, reach + tolerance(reach))) {
      if (b === a || !sameShape(b, partner)) continue;
      const distance = Math.hypot(b.cx - a.cx, b.cy - a.cy);
      if (Math.abs(distance - reach) > tolerance(reach)) continue;
      const turn = Math.atan2(b.cy - a.cy, b.cx - a.cx);
      for (const mirror of [1, -1]) {
        const rotation = turn - mirror * baseAngle;
        const place = part => {
          const dx = part.cx - anchor.cx, dy = mirror * (part.cy - anchor.cy);
          return [a.cx + dx * Math.cos(rotation) - dy * Math.sin(rotation), a.cy + dx * Math.sin(rotation) + dy * Math.cos(rotation)];
        };
        const used = new Set([a, b]);
        const ok = parts.every(part => {
          if (part === anchor || part === partner) return true;
          const [x, y] = place(part);
          const d = Math.hypot(part.cx - anchor.cx, part.cy - anchor.cy);
          const hit = near(x, y, tolerance(d)).find(p => !used.has(p) && sameShape(p, part));
          if (hit) used.add(hit);
          return Boolean(hit);
        });
        if (!ok) continue;
        const [x, y] = place({cx: template.cx, cy: template.cy});
        if (Math.hypot(x - template.cx, y - template.cy) < span) break; // the legend symbol itself
        if (!found.some(f => Math.hypot(f.x - x, f.y - y) < span * 0.6)) found.push({x, y});
        break;
      }
    }
  }
  return found;
}

// Legend entries with a symbol template, for one page.
export function legendTemplates(items, primitives) {
  return legendEntries(items).map(entry => ({...entry, template: legendSymbol(entry, primitives)})).filter(entry => entry.template);
}

/* --------------------------------------------------------- label schedule */

const LIGHT_POLE_ASSET = /^(P\/?L|PUBLIC LIGHTING|LIGHT(ING)?)\s*(POLE|COLUMN)$/i;

// Reads a "LABEL SCHEDULE" table (ASSET | LABEL | TYPE) from a page's text
// items. Returns {poles, labels, missing} where `poles` counts the
// public lighting pole rows, `labels` are their PO labels, and `missing` are
// labels not written anywhere else on the sheet. Returns null when the page
// has no label schedule.
export function labelSchedule(items) {
  const lines = items.filter(item => item.str?.trim() && Math.abs(item.transform[1]) < 0.01 && Math.abs(item.transform[2]) < 0.01)
    .map(item => ({text: item.str.trim(), x: item.transform[4], y: item.transform[5], height: Math.abs(item.transform[3]) || 10}));
  const title = lines.find(line => /^LABEL SCHEDULE$/i.test(line.text));
  if (!title) return null;
  const h = title.height;
  const header = lines.filter(line => /^ASSET$/i.test(line.text) && title.y - line.y > 0 && title.y - line.y < h * 4 && Math.abs(line.x - title.x) < h * 12)
    .sort((a, b) => b.y - a.y)[0];
  if (!header) return null;
  const left = header.x - h * 3, right = title.x + (title.x - header.x) + h * 12;
  // Rows below the header, until a gap of more than three row heights.
  const body = lines.filter(line => line.y < header.y - h * 0.5 && line.x >= left && line.x <= right).sort((a, b) => b.y - a.y);
  const rows = [];
  let lastY = header.y;
  for (const line of body) {
    if (lastY - line.y > h * 3.5) break;
    lastY = line.y;
    let row = rows.find(other => Math.abs(other.y - line.y) < h * 0.4);
    if (!row) rows.push(row = {y: line.y, cells: []});
    row.cells.push(line);
  }
  const assetX = header.x;
  const entries = rows.map(row => {
    const cells = row.cells.sort((a, b) => a.x - b.x);
    const asset = cells.find(cell => Math.abs(cell.x - assetX) < h * 3)?.text || cells[0].text;
    const label = cells.map(cell => cell.text).find(text => /^PO\s*\d+/i.test(text)) || '';
    return {asset, label};
  });
  const poleRows = entries.filter(entry => LIGHT_POLE_ASSET.test(entry.asset.replace(/\s+/g, ' ')));
  const labels = poleRows.map(entry => entry.label).filter(Boolean);
  // A schedule label should also be written beside its pole on the plan.
  const inTable = new Set(rows.flatMap(row => row.cells.map(cell => cell.text)));
  const elsewhere = items.map(item => item.str || '').filter(text => !inTable.has(text.trim()) && !/^\s*\d+\.\s/.test(text)).join(' ');
  const digits = label => label.replace(/\D/g, '');
  const missing = labels.filter(label => !new RegExp('\\bPO\\s*' + digits(label) + '\\b').test(elsewhere));
  return {poles: poleRows.length, labels, missing};
}

/* ------------------------------------------------------------ pole labels */

// Pole labels written on the plan, such as "BID PO 2602515854" beside each
// pole. Text in any rotation; numbered notes ("23. REMOVE (E) PL BID PO ...")
// are left out. Returns [{label, x, y}] with the label's centre in PDF units.
export function poleLabels(items) {
  return items.filter(item => /^\s*BID\s+PO\s*\d{6,}\s*$/i.test(item.str || ''))
    .map(item => {
      const [a, b, c, d, e, f] = item.transform;
      const along = Math.hypot(a, b) || 1, across = Math.hypot(c, d) || 1;
      return {label: item.str.trim().replace(/\s+/g, ' '), x: e + a / along * (item.width || 0) / 2 + c / 2, y: f + b / along * (item.width || 0) / 2 + d / 2,
        size: across};
    });
}

// Pairs pole labels with light symbols one-to-one, pairing as many as
// possible within maxDistance and then keeping the total distance smallest
// (so two labels near the same light don't both lose out). Returns the labels
// with `point` set to the paired symbol, or null.
export function pairLabels(labels, points, maxDistance = 300) {
  const n = Math.max(labels.length, points.length);
  const FAR = 1e6;
  const cost = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => {
    if (i >= labels.length || j >= points.length) return FAR;
    const d = Math.hypot(points[j][0] - labels[i].x, points[j][1] - labels[i].y);
    return d <= maxDistance ? d : FAR;
  }));
  const match = hungarian(cost);
  return labels.map((label, i) => ({...label, point: cost[i][match[i]] < FAR ? points[match[i]] : null}));
}

// Minimum-cost assignment of rows to columns of a square matrix. Returns the
// column for each row.
function hungarian(cost) {
  const n = cost.length;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = new Array(n);
  for (let j = 1; j <= n; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}
