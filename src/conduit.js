// Trench length from conduit runs on vector (CAD) drawings.
//
// The legend shows each line type beside its wording, for example a dashed
// cyan double line beside "CABLE CONDUIT (125NB ...)". This module reads the
// colour and weight of that sample line, collects every line drawn the same
// way on the plan, joins the dashes into runs, counts side-by-side conduits in
// the same trench once, and converts the length to metres with the sheet's
// scale bar. Pure functions: the caller supplies pdf.js operator lists and text.

// A legend entry starts with the words; notes that mention conduits do not.
const CONDUIT_WORDS = /^\W*CABLE\s+CONDUITS?\b/i;

const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

const colourKey = value => typeof value === 'string' ? value.toLowerCase()
  : '#' + Array.from(value || []).slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// Stroked straight pieces of every path, in PDF units: {colour, width, x1, y1, x2, y2}.
// Curves are kept as their chord, which is close enough for run lengths.
export function strokedSegments(operatorList, OPS) {
  const {fnArray, argsArray} = operatorList;
  let state = {ctm: [1, 0, 0, 1, 0, 0], colour: '#000000', width: 1};
  const stack = [];
  const out = [];
  const FILL_ONLY = new Set([OPS.fill, OPS.eoFill, OPS.endPath].filter(op => op !== undefined));
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push({...state});
    else if (fn === OPS.restore) state = stack.pop() || state;
    else if (fn === OPS.transform) state.ctm = multiply(state.ctm, args);
    else if (fn === OPS.setStrokeRGBColor) state.colour = colourKey(args[0] ?? args);
    else if (fn === OPS.setLineWidth) state.width = args[0];
    else if (fn === OPS.constructPath) {
      if (FILL_ONLY.has(args?.[0])) continue;
      const data = args?.[1]?.[0];
      if (!data || typeof data.length !== 'number') continue;
      const m = state.ctm;
      const at = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const width = state.width * Math.hypot(m[0], m[1]);
      let start = null, last = null;
      const add = (a, b) => { if (a && b && (a[0] !== b[0] || a[1] !== b[1])) out.push({colour: state.colour, width, x1: a[0], y1: a[1], x2: b[0], y2: b[1]}); };
      for (let j = 0; j < data.length;) {
        const op = data[j++];
        const n = op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : op === 0 || op === 1 ? 2 : -1;
        if (n < 0) break;
        if (op === 4) { add(last, start); last = start; continue; }
        const point = at(data[j + n - 2], data[j + n - 1]);
        if (op === 0) start = point; else add(last, point);
        last = point;
        j += n;
      }
    }
  }
  return out;
}

const lineText = items => items.filter(item => item.str?.trim() && Math.abs(item.transform[1]) < 0.01 && Math.abs(item.transform[2]) < 0.01)
  .map(item => ({text: item.str.trim(), x: item.transform[4], y: item.transform[5], width: item.width || 0, height: Math.abs(item.transform[3]) || 10}));

// The line style drawn just left of each "CABLE CONDUIT" legend entry:
// [{label, colour, width, box}]. Entries with no sample line are left out.
export function conduitLegend(items, segments) {
  const found = [];
  for (const line of lineText(items)) {
    if (!CONDUIT_WORDS.test(line.text) || line.text.length > 90 || /^\d+[.)]\s/.test(line.text)) continue;
    const h = line.height;
    const box = [line.x - h * 12, line.y - h * 0.6, line.x - h * 0.2, line.y + h * 1.4];
    const inside = segments.filter(s => Math.min(s.x1, s.x2) >= box[0] && Math.max(s.x1, s.x2) <= box[2] &&
      Math.min(s.y1, s.y2) >= box[1] && Math.max(s.y1, s.y2) <= box[3]);
    if (!inside.length) continue;
    // The style with the most length in the sample is the conduit line.
    const totals = new Map();
    for (const s of inside) {
      const key = s.colour + '|' + s.width.toFixed(2);
      totals.set(key, (totals.get(key) || 0) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    }
    const [key] = [...totals].sort((a, b) => b[1] - a[1])[0];
    const [colour, width] = key.split('|');
    found.push({label: line.text, colour, width: Number(width), box});
  }
  return found;
}

// AusNet sheets draw conduit as a cyan dashed line. When the legend wording is
// drawn as linework (so it can't be read as text), fall back to that style:
// the cyan line weight with the most length on the sheet.
export const STANDARD_CONDUIT_COLOUR = '#00ffff';
export function standardConduit(segments) {
  const totals = new Map();
  for (const s of segments) {
    if (s.colour !== STANDARD_CONDUIT_COLOUR) continue;
    const key = s.width.toFixed(2);
    totals.set(key, (totals.get(key) || 0) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
  }
  const best = [...totals].sort((a, b) => b[1] - a[1])[0];
  return best ? [{label: 'cyan conduit line (AusNet standard; the legend wording is not readable as text)', colour: STANDARD_CONDUIT_COLOUR, width: Number(best[0]), box: null, standard: true}] : [];
}

// PDF units per metre, from a scale bar ("SCALE OF METRES" with numbers
// 0 ... 50 above it), or else from a written ratio such as "1:500" assuming
// the PDF is at true size. Returns {unitsPerMetre, source} or null.
export function sheetScale(items) {
  const lines = lineText(items);
  const title = lines.find(line => /SCALE\s+OF\s+MET(RE|ER)S|^SCALE\b.*1\s*:\s*\d+/i.test(line.text));
  if (title) {
    const h = title.height;
    const numbers = lines.filter(line => /^\d+$/.test(line.text) && line.y > title.y && line.y - title.y < h * 6 &&
      line.x > title.x - h * 30 && line.x < title.x + title.width + h * 30);
    // The bar's numbers share one row; take the row holding a 0.
    const zero = numbers.filter(n => n.text === '0').sort((a, b) => Math.abs(a.y - title.y) - Math.abs(b.y - title.y))[0];
    if (zero) {
      const row = numbers.filter(n => Math.abs(n.y - zero.y) < h * 0.3 && n.x > zero.x).sort((a, b) => a.x - b.x);
      const centre = n => n.x + n.width / 2;
      const end = row.filter(n => Number(n.text) > 0).at(-1);
      if (end && centre(end) > centre(zero)) {
        return {unitsPerMetre: (centre(end) - centre(zero)) / Number(end.text), source: 'scale bar (0 to ' + end.text + ' m)'};
      }
    }
  }
  const ratio = lines.map(line => line.text.match(/\b1\s*:\s*(\d{2,5})\b/)).find(Boolean);
  if (ratio) return {unitsPerMetre: 72 / 25.4 * 1000 / Number(ratio[1]), source: 'written scale 1:' + ratio[1] + ' (assumes the PDF is full size)'};
  return null;
}

// Joins dashes into runs and measures them once, however many conduits are
// drawn side by side. `style` is {colour, width}; `exclude` is a list of
// boxes [x1, y1, x2, y2] to ignore (the legend). Returns {metres, runs} where
// runs are polylines [[x, y], ...] in PDF units.
export function conduitRuns(segments, style, unitsPerMetre, {exclude = [], trenchWidth = 2.5, gap = 1.6, minRun = 2, area = null} = {}) {
  const inBox = (x, y) => exclude.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  const pieces = segments.filter(s => s.colour === style.colour && Math.abs(s.width - style.width) <= Math.max(0.05, style.width * 0.15) &&
    !inBox(s.x1, s.y1) && !inBox(s.x2, s.y2))
    .map(s => ({a: [s.x1, s.y1], b: [s.x2, s.y2], length: Math.hypot(s.x2 - s.x1, s.y2 - s.y1)}))
    .filter(p => p.length > 0);
  const gapUnits = gap * unitsPerMetre;
  // Link each piece end to the next piece in line with it, so dashes form runs.
  const ends = new Map();
  const cell = gapUnits || 1;
  const keyOf = ([x, y]) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  pieces.forEach((piece, index) => {
    for (const side of ['a', 'b']) {
      const key = keyOf(piece[side]);
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push({index, side});
    }
  });
  const direction = p => [(p.b[0] - p.a[0]) / p.length, (p.b[1] - p.a[1]) / p.length];
  const links = pieces.map(() => ({a: null, b: null}));
  const candidates = [];
  pieces.forEach((piece, index) => {
    const d = direction(piece);
    for (const side of ['a', 'b']) {
      const [x, y] = piece[side];
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
        for (const other of ends.get(i + ',' + j) || []) {
          if (other.index <= index) continue;
          const o = pieces[other.index];
          const [ox, oy] = o[other.side];
          const distance = Math.hypot(ox - x, oy - y);
          if (distance > gapUnits) continue;
          const od = direction(o);
          if (Math.abs(d[0] * od[0] + d[1] * od[1]) < 0.94) continue; // not in line
          // The gap must run along the line, not across to a neighbouring conduit.
          if (distance > 1e-6 && Math.abs(((ox - x) * d[0] + (oy - y) * d[1]) / distance) < 0.9) continue;
          candidates.push({index, side, other: other.index, otherSide: other.side, distance});
        }
      }
    }
  });
  candidates.sort((p, q) => p.distance - q.distance);
  for (const c of candidates) {
    if (links[c.index][c.side] || links[c.other][c.otherSide]) continue;
    links[c.index][c.side] = {index: c.other, side: c.otherSide};
    links[c.other][c.otherSide] = {index: c.index, side: c.side};
  }
  // Walk the chains into polylines.
  const seen = new Set();
  const runs = [];
  const walk = (index, entrySide) => {
    const points = [];
    let current = index, from = entrySide;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const piece = pieces[current];
      const to = from === 'a' ? 'b' : 'a';
      points.push(piece[from], piece[to]);
      const next = links[current][to];
      if (!next) break;
      current = next.index;
      from = next.side;
    }
    return points;
  };
  pieces.forEach((piece, index) => {
    if (seen.has(index)) return;
    if (links[index].a && links[index].b) return; // start from chain ends
    runs.push(walk(index, links[index].a ? 'b' : 'a'));
  });
  pieces.forEach((piece, index) => { if (!seen.has(index)) runs.push(walk(index, 'a')); }); // closed loops
  const runLength = points => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
  if (area) runs.splice(0, runs.length, ...mainPlan(runs, unitsPerMetre, area));
  runs.sort((p, q) => runLength(q) - runLength(p));

  // Measure: sample each run every `step`; a sample counts only when no run
  // already measured lies beside it (within the trench width, across the line).
  const step = 0.25 * unitsPerMetre;
  const reach = trenchWidth * unitsPerMetre;
  const counted = new Map();
  const ckey = (x, y) => Math.floor(x / reach) + ',' + Math.floor(y / reach);
  let total = 0;
  const kept = [], trench = [];
  for (const points of runs) {
    if (runLength(points) < minRun * unitsPerMetre * 0.25) continue; // stray marks
    const samples = [];
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (!length) continue;
      const dx = (x2 - x1) / length, dy = (y2 - y1) / length;
      for (let t = 0; t < length; t += step) samples.push({x: x1 + dx * t, y: y1 + dy * t, dx, dy, w: Math.min(step, length - t)});
    }
    let added = 0;
    const fresh = new Set();
    for (const s of samples) {
      let beside = false;
      const gx = Math.floor(s.x / reach), gy = Math.floor(s.y / reach);
      for (let i = gx - 1; i <= gx + 1 && !beside; i++) for (let j = gy - 1; j <= gy + 1 && !beside; j++) {
        for (const q of counted.get(i + ',' + j) || []) {
          const ex = s.x - q.x, ey = s.y - q.y;
          if (Math.hypot(ex, ey) <= reach && Math.abs(ex * s.dx + ey * s.dy) <= step) { beside = true; break; }
        }
      }
      if (!beside) { added += s.w; fresh.add(s); }
    }
    for (const s of fresh) {
      const key = ckey(s.x, s.y);
      if (!counted.has(key)) counted.set(key, []);
      counted.get(key).push(s);
    }
    if (added > 0) { total += added; kept.push(points); }
    // The counted stretches, joined, for drawing the trench once on the sheet.
    let stretch = null;
    for (const sample of samples) {
      if (fresh.has(sample)) {
        const end = [sample.x + sample.dx * sample.w, sample.y + sample.dy * sample.w];
        if (stretch && Math.hypot(stretch.at(-1)[0] - sample.x, stretch.at(-1)[1] - sample.y) < step * 0.01 + 1e-6) stretch.push(end);
        else { stretch = [[sample.x, sample.y], end]; trench.push(stretch); }
      } else stretch = null;
    }
  }
  return {metres: total / unitsPerMetre, runs: kept, trench};
}

// Keeps the runs on the main plan and drops those in details drawn elsewhere
// on the sheet (sections, enlargements, joint details), which are often at
// another scale. Runs within `link` metres of each other form a group, and
// the plan is every group reaching into `area` (the box holding the plan's
// pole labels).
function mainPlan(runs, unitsPerMetre, area, link = 8) {
  if (runs.length < 2) return runs;
  const reach = link * unitsPerMetre;
  const parent = runs.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cells = new Map();
  runs.forEach((points, index) => {
    for (let k = 0; k < points.length; k++) {
      // Sample along each piece so long straight runs link along their length.
      const [x1, y1] = points[k], [x2, y2] = points[k + 1] || points[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / reach));
      for (let t = 0; t < steps; t++) {
        const x = x1 + (x2 - x1) * t / steps, y = y1 + (y2 - y1) * t / steps;
        const key = Math.floor(x / reach) + ',' + Math.floor(y / reach);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({index, x, y});
      }
    }
  });
  for (const [key, list] of cells) {
    const [gx, gy] = key.split(',').map(Number);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
      for (const other of cells.get(i + ',' + j) || []) {
        for (const point of list) {
          if (find(point.index) !== find(other.index) && Math.hypot(point.x - other.x, point.y - other.y) <= reach) parent[find(point.index)] = find(other.index);
        }
      }
    }
  }
  const groups = new Map();
  runs.forEach((points, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, {runs: [], box: [Infinity, Infinity, -Infinity, -Infinity]});
    const group = groups.get(root);
    group.runs.push(points);
    for (const [x, y] of points) group.box = [Math.min(group.box[0], x), Math.min(group.box[1], y), Math.max(group.box[2], x), Math.max(group.box[3], y)];
  });
  const list = [...groups.values()];
  const overlapsArea = box => box[0] <= area[2] && area[0] <= box[2] && box[1] <= area[3] && area[1] <= box[3];
  const kept = list.filter(group => overlapsArea(group.box));
  return kept.length ? kept.flatMap(group => group.runs) : runs;
}
