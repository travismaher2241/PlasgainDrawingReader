// Counts copies of a symbol on a sheet image (for scanned or image-only
// drawings, where there are no vector shapes to match). The estimator boxes
// one symbol; every copy at any rotation or mirror image is found by
// normalised cross-correlation of the ink, first on a coarse image to find
// candidates and then at finer detail to score them. Pure functions working on
// a greyscale image {width, height, data: Uint8Array (0 black .. 255 white)}.

const COARSE_SIZE = 14; // template size, in pixels, for the candidate search
const FINE_SIZE = 32; // and for scoring
const ANGLE_STEP = 15;
const GUESSES = 3; // angle and position guesses checked in detail for each candidate
const CLUTTER_WEIGHT = 2; // clear space around the strokes matters more than ink on them

// Ink image shrunk by an integer factor: a block is inked (1) when any pixel
// in it is darker than `threshold`, so thin lines survive shrinking and pale
// background linework (grey roads, lot lines) drops out.
const INK = 150;
function inkImage(image, factor, threshold = INK) {
  const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dark = 0;
      for (let dy = 0; dy < factor && !dark; dy++) {
        const row = (y * factor + dy) * image.width + x * factor;
        for (let dx = 0; dx < factor; dx++) if (image.data[row + dx] < threshold) { dark = 1; break; }
      }
      data[y * width + x] = dark;
    }
  }
  return {width, height, data};
}

// A 3x3 blur, so a copy that sits a pixel off the grid still lines up with
// the template's thin lines.
function blur(ink) {
  const {width, height, data} = ink;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) { sum += data[ny * width + nx] * (dx || dy ? 1 : 2); n += dx || dy ? 1 : 2; }
      }
      out[y * width + x] = sum / n;
    }
  }
  return {width, height, data: out};
}

// The box shrunk to the ink inside it, so a loose box doesn't matter.
export function trimBox(image, box, threshold = INK) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const left = Math.max(0, Math.floor(box.x)), top = Math.max(0, Math.floor(box.y));
  const right = Math.min(image.width, Math.ceil(box.x + box.w)), bottom = Math.min(image.height, Math.ceil(box.y + box.h));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (image.data[y * image.width + x] < threshold) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
  }
  if (x1 < x0) return null;
  const pad = 2;
  return {x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: Math.min(image.width, x1 + pad + 1) - Math.max(0, x0 - pad),
    h: Math.min(image.height, y1 + pad + 1) - Math.max(0, y0 - pad)};
}

// The template cut from an ink image, turned and mirrored, in a square of
// side `size` centred on the box centre. Bilinear sampling.
function turned(ink, cx, cy, w, h, size, angle, mirror) {
  const out = new Float32Array(size * size);
  const cos = Math.cos(angle), sin = Math.sin(angle), half = (size - 1) / 2;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      // Output pixel (u, v) → template offset, undoing the turn and mirror.
      const ox = u - half, oy = v - half;
      let tx = ox * cos + oy * sin, ty = -ox * sin + oy * cos;
      tx *= mirror;
      if (Math.abs(tx) > w / 2 || Math.abs(ty) > h / 2) continue;
      out[v * size + u] = sample(ink, cx + tx, cy + ty);
    }
  }
  return out;
}

function sample(ink, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= ink.width || y0 + 1 >= ink.height) return 0;
  const fx = x - x0, fy = y - y0, i = y0 * ink.width + x0;
  return ink.data[i] * (1 - fx) * (1 - fy) + ink.data[i + 1] * fx * (1 - fy) + ink.data[i + ink.width] * (1 - fx) * fy + ink.data[i + ink.width + 1] * fx * fy;
}

function stats(values) {
  let sum = 0, squares = 0;
  for (const v of values) { sum += v; squares += v * v; }
  const mean = sum / values.length;
  return {sum, mean, norm: Math.sqrt(Math.max(1e-9, squares - sum * mean))};
}

// Correlation of a template against the image under its mask, with the
// template's top left at (x, y).
function correlate(ink, template, x, y) {
  const {offsets, values} = template;
  let dot = 0, sum = 0, squares = 0;
  for (let k = 0; k < offsets.length; k++) {
    const o = offsets[k], v = ink.data[(y + Math.floor(o / 1e6)) * ink.width + x + o % 1e6];
    dot += values[k] * v; sum += v; squares += v * v;
  }
  const norm = Math.sqrt(Math.max(1e-9, squares - sum * sum / offsets.length));
  if (norm < 0.05 * Math.sqrt(offsets.length)) return -1; // flat: blank paper or solid fill
  return (dot - template.stats.mean * sum) / (template.stats.norm * norm);
}

function integrals(ink) {
  const w = ink.width + 1, sum = new Float64Array(w * (ink.height + 1)), squares = new Float64Array(w * (ink.height + 1));
  for (let y = 0; y < ink.height; y++) {
    let rowSum = 0, rowSquares = 0;
    for (let x = 0; x < ink.width; x++) {
      const v = ink.data[y * ink.width + x];
      rowSum += v; rowSquares += v * v;
      sum[(y + 1) * w + x + 1] = sum[y * w + x + 1] + rowSum;
      squares[(y + 1) * w + x + 1] = squares[y * w + x + 1] + rowSquares;
    }
  }
  const box = (table, x, y, size) => table[(y + size) * w + x + size] - table[y * w + x + size] - table[(y + size) * w + x] + table[y * w + x];
  return {
    window(x, y, size) {
      const s = box(sum, x, y, size), q = box(squares, x, y, size);
      return {sum: s, norm: Math.sqrt(Math.max(1e-9, q - s * s / (size * size)))};
    },
  };
}

// Each template keeps only the pixels on or next to the symbol's ink (its
// mask), so lines and text around the picked symbol don't count against a
// copy drawn somewhere else.
function templates(ink, box, factor, size, angles) {
  const cx = (box.x + box.w / 2) / factor - 0.5, cy = (box.y + box.h / 2) / factor - 0.5;
  const list = [];
  for (const mirror of [1, -1]) {
    for (const angle of angles) {
      const full = turned(ink, cx, cy, box.w / factor, box.h / factor, size, angle, mirror);
      const near = new Uint8Array(size * size);
      for (let v = 0; v < size; v++) for (let u = 0; u < size; u++) {
        if (full[v * size + u] < 0.2) continue;
        for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
          const nu = u + du, nv = v + dv;
          if (nu >= 0 && nv >= 0 && nu < size && nv < size) near[nv * size + nu] = 1;
        }
      }
      const offsets = [], values = [];
      for (let i = 0; i < near.length; i++) if (near[i]) { offsets.push(i); values.push(full[i]); }
      const v = Float32Array.from(values);
      list.push({offsets: Int32Array.from(offsets.map(i => Math.floor(i / size) * 1e6 + i % size)), values: v, stats: stats(v), angle, mirror});
    }
  }
  return list;
}

// The symbol's stroke pixels and the clear pixels near them (one to three
// pixels away, inside the box), turned and mirrored, as [u, v] offsets in a
// square of side `size`.
function strokesAndGaps(raw, box, factor, size, angle, mirror) {
  const cx = (box.x + box.w / 2) / factor - 0.5, cy = (box.y + box.h / 2) / factor - 0.5;
  const picture = turned(raw, cx, cy, box.w / factor, box.h / factor, size, angle, mirror);
  const inside = turned({...raw, data: new Float32Array(raw.data.length).fill(1)}, cx, cy, box.w / factor, box.h / factor, size, angle, mirror);
  const strokes = [], gaps = [];
  for (let v = 0; v < size; v++) for (let u = 0; u < size; u++) {
    const i = v * size + u;
    if (picture[i] >= 0.5) { strokes.push([u, v]); continue; }
    if (inside[i] < 0.99) continue;
    let nearest = 9;
    for (let dv = -3; dv <= 3; dv++) for (let du = -3; du <= 3; du++) {
      const nu = u + du, nv = v + dv;
      if (nu >= 0 && nv >= 0 && nu < size && nv < size && picture[nv * size + nu] >= 0.5) nearest = Math.min(nearest, Math.max(Math.abs(du), Math.abs(dv)));
    }
    if (nearest >= 2 && nearest <= 3) gaps.push([u, v]);
  }
  return {strokes, gaps};
}

// Finds copies of the symbol in `box` (pixels {x, y, w, h}). Returns
// {matches: [{x, y, score, angle, mirror}], box} with centres in pixels,
// best first; matches scoring below `minScore` are left out.
export function countSymbol(image, box, {minScore = 0.4} = {}) {
  const tight = trimBox(image, box);
  if (!tight || tight.w < 4 || tight.h < 4) return {matches: [], box: tight};
  const longest = Math.max(tight.w, tight.h);
  const diagonal = Math.hypot(tight.w, tight.h);

  // 1. Candidates on a coarse image, every 15 degrees and mirrored.
  const coarse = Math.max(1, Math.round(longest / COARSE_SIZE));
  const ink = blur(inkImage(image, coarse));
  const size = Math.ceil(diagonal / coarse) | 1;
  const angles = Array.from({length: 360 / ANGLE_STEP}, (_, i) => i * ANGLE_STEP * Math.PI / 180);
  const list = templates(ink, tight, coarse, size, angles);
  const inkSum = list[0].stats.sum;
  const table = integrals(ink);
  const pickX = Math.round((tight.x + tight.w / 2) / coarse - size / 2), pickY = Math.round((tight.y + tight.h / 2) / coarse - size / 2);
  const around = Math.max(inkSum, table.window(Math.max(0, Math.min(ink.width - size, pickX)), Math.max(0, Math.min(ink.height - size, pickY)), size).sum);
  const best = new Float32Array(ink.width * ink.height).fill(-1);
  const which = new Int16Array(ink.width * ink.height);
  for (let y = 0; y + size <= ink.height; y++) {
    for (let x = 0; x + size <= ink.width; x++) {
      const win = table.window(x, y, size);
      // Windows with much less ink than the symbol, or far more than the
      // picked one has around it, can't match.
      if (win.sum < inkSum * 0.6 || win.sum > around * 3) continue;
      let top = -1, index = 0;
      for (let t = 0; t < list.length; t++) {
        const score = correlate(ink, list[t], x, y);
        if (score > top) { top = score; index = t; }
      }
      best[y * ink.width + x] = top;
      which[y * ink.width + x] = index;
    }
  }
  // Local peaks.
  const radius = Math.max(1, Math.floor(size / 4));
  const peaks = [];
  for (let y = 0; y + size <= ink.height; y++) {
    for (let x = 0; x + size <= ink.width; x++) {
      const score = best[y * ink.width + x];
      if (score < minScore * 0.85) continue;
      let peak = true;
      for (let dy = -radius; dy <= radius && peak; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < ink.width && ny < ink.height && best[ny * ink.width + nx] > score) { peak = false; break; }
        }
      }
      if (peak) peaks.push({x, y, score, t: which[y * ink.width + x]});
    }
  }

  // 2. Check each candidate at finer detail, nudging position and angle:
  // every stroke of the symbol must be there (other linework crossing it is
  // fine), and the open spaces in and around it should be mostly clear.
  const fineFactor = Math.max(1, Math.round(longest / FINE_SIZE));
  const raw = inkImage(image, fineFactor);
  const soft = blur(raw);
  const fineSize = Math.ceil(diagonal / fineFactor) | 1;
  const cache = new Map();
  const shape = (angle, mirror) => {
    const key = angle.toFixed(4) + mirror;
    if (!cache.has(key)) cache.set(key, strokesAndGaps(raw, tight, fineFactor, fineSize, angle, mirror));
    return cache.get(key);
  };
  const reach = Math.ceil(coarse / fineFactor) + 1;
  // The coarse image is too rough to be sure of the angle or the exact spot,
  // so each peak is checked from its few best angle and position guesses.
  const guesses = [];
  for (const peak of peaks) {
    const scored = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = peak.x + dx, y = peak.y + dy;
      if (x < 0 || y < 0 || x + size > ink.width || y + size > ink.height) continue;
      for (let t = 0; t < list.length; t++) scored.push({x, y, t, score: correlate(ink, list[t], x, y)});
    }
    scored.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const guess of scored) {
      if (kept.some(other => other.t === guess.t)) continue;
      kept.push(guess);
      if (kept.length === GUESSES) break;
    }
    guesses.push(...kept);
  }
  const found = [];
  for (const peak of guesses) {
    const start = list[peak.t];
    const centreX = (peak.x + size / 2) * coarse, centreY = (peak.y + size / 2) * coarse;
    const fx = Math.round(centreX / fineFactor - fineSize / 2), fy = Math.round(centreY / fineFactor - fineSize / 2);
    let top = {score: -1};
    for (const turn of [-10, -5, 0, 5, 10]) {
      const angle = start.angle + turn * Math.PI / 180;
      const {strokes, gaps} = shape(angle, start.mirror);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const x = fx + dx, y = fy + dy;
          if (x < 0 || y < 0 || x + fineSize > raw.width || y + fineSize > raw.height) continue;
          let covered = 0, cluttered = 0;
          for (const o of strokes) if (soft.data[(y + o[1]) * raw.width + x + o[0]] >= 0.2) covered++;
          for (const o of gaps) if (raw.data[(y + o[1]) * raw.width + x + o[0]]) cluttered++;
          const cover = covered / strokes.length, clutter = gaps.length ? cluttered / gaps.length : 0;
          const score = cover - CLUTTER_WEIGHT * clutter;
          if (score > top.score) top = {score, x, y, angle, mirror: start.mirror};
        }
      }
    }
    if (top.score >= minScore) {
      found.push({x: (top.x + fineSize / 2) * fineFactor, y: (top.y + fineSize / 2) * fineFactor, score: top.score,
        angle: ((top.angle * 180 / Math.PI) % 360 + 360) % 360, mirror: top.mirror === -1});
    }
  }
  // One match per symbol.
  found.sort((a, b) => b.score - a.score);
  const apart = longest * 0.6;
  const matches = [];
  for (const match of found) if (!matches.some(other => Math.hypot(other.x - match.x, other.y - match.y) < apart)) matches.push(match);
  return {matches, box: tight};
}
