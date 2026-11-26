import assert from 'node:assert/strict';
import test from 'node:test';
import {conduitLegend, conduitRuns, sheetScale} from '../src/conduit.js';

const text = (str, x, y, size = 10, width = str.length * size * 0.5) => ({str, width, transform: [size, 0, 0, size, x, y]});

test('scale bar gives PDF units per metre; a written ratio is the fallback', () => {
  const bar = [text('10', 170, 258, 10, 9), text('0', 228, 258, 10, 4), text('10', 282, 258, 10, 9), text('50', 504, 258, 10, 9),
    text('SCALE OF METRES 1:500 @ SHEET B1', 270, 225, 10, 148)];
  const scale = sheetScale(bar);
  assert.ok(Math.abs(scale.unitsPerMetre - (508.5 - 230) / 50) < 1e-9);
  assert.match(scale.source, /scale bar/);
  assert.match(sheetScale([text('SCALE 1:500', 100, 100)]).source, /1:500/);
  assert.equal(sheetScale([text('NOTES', 100, 100)]), null);
});

// A dashed run: 2 m dashes with 1 m gaps, `lines` side-by-side conduits 0.35 m apart.
function dashedRun(x0, y0, metres, lines, ppm, angle = 0) {
  const out = [];
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  for (let k = 0; k < lines; k++) {
    const ox = -dy * k * 0.35 * ppm, oy = dx * k * 0.35 * ppm;
    for (let t = 0; t < metres; t += 3) {
      const a = t * ppm, b = Math.min(t + 2, metres) * ppm;
      out.push({colour: '#00ffff', width: 0.72, x1: x0 + ox + dx * a, y1: y0 + oy + dy * a, x2: x0 + ox + dx * b, y2: y0 + oy + dy * b});
    }
  }
  return out;
}

test('conduit runs: dashes joined, side-by-side conduits counted once, other line styles ignored', () => {
  const ppm = 5.56;
  const segments = [
    ...dashedRun(100, 100, 120, 4, ppm),                 // 120 m trench with 4 conduits
    ...dashedRun(1000, 100, 50, 2, ppm, Math.PI / 2),     // 50 m branch elsewhere
    {colour: '#ff0000', width: 0.72, x1: 100, y1: 300, x2: 900, y2: 300}, // a cable, not conduit
  ];
  const {metres} = conduitRuns(segments, {colour: '#00ffff', width: 0.72}, ppm);
  assert.ok(Math.abs(metres - 170) < 4, 'measured ' + metres);
});

test('conduit legend reads the sample line style beside the wording', () => {
  const items = [text('CABLE CONDUIT (125NB = 125mm INSIDE Dia.)', 170, 139, 7.8)];
  const segments = [
    {colour: '#00ffff', width: 0.72, x1: 132, y1: 140, x2: 135, y2: 140}, {colour: '#00ffff', width: 0.72, x1: 137, y1: 140, x2: 159, y2: 140},
    {colour: '#000000', width: 0.72, x1: 150, y1: 141, x2: 152, y2: 141},
  ];
  const [legend] = conduitLegend(items, segments);
  assert.equal(legend.colour, '#00ffff');
  assert.equal(legend.width, 0.72);
});
