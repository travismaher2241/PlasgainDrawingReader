import test from 'node:test';
import assert from 'node:assert/strict';
import {countSymbol, trimBox} from '../src/rastercount.js';

// A white sheet with copies of a small symbol (a ring on a stalk ending in a
// bar) at various angles and one mirrored, plus some unrelated marks.
function sheet() {
  const width = 900, height = 600, data = new Uint8Array(width * height).fill(255);
  const ink = (x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = 0; };
  const symbol = (cx, cy, angle, mirror = 1) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const put = (u, v) => { u *= mirror; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) ink(cx + u * c - v * s + dx, cy + u * s + v * c + dy); };
    for (let a = 0; a < 360; a += 2) put(9 * Math.cos(a * Math.PI / 180), -14 + 9 * Math.sin(a * Math.PI / 180)); // ring
    for (let v = -5; v <= 16; v++) put(0, v); // stalk
    for (let u = 0; u <= 12; u++) put(u, 16); // bar to one side
  };
  symbol(100, 100, 0);
  symbol(300, 120, Math.PI / 2);
  symbol(520, 380, Math.PI);
  symbol(760, 200, 0, -1);
  symbol(200, 450, 0.3);
  for (let x = 380; x < 460; x++) for (let t = 0; t < 2; t++) ink(x, 250 + t); // a plain line
  for (let a = 0; a < 360; a += 1) ink(650 + 20 * Math.cos(a * Math.PI / 180), 480 + 20 * Math.sin(a * Math.PI / 180)); // a large circle
  return {width, height, data};
}

test('trimBox shrinks a loose box to the ink', () => {
  const box = trimBox(sheet(), {x: 60, y: 60, w: 80, h: 80});
  assert.ok(box.w < 30 && box.h < 50, JSON.stringify(box));
});

test('countSymbol finds every copy, turned or mirrored, and nothing else', () => {
  const {matches} = countSymbol(sheet(), {x: 85, y: 76, w: 32, h: 46}, {minScore: 0.6});
  const strong = matches.filter(match => match.score >= 0.75);
  const near = (x, y) => strong.some(match => Math.hypot(match.x - x, match.y - y) < 15);
  for (const [x, y] of [[100, 100], [300, 120], [520, 380], [760, 200], [200, 450]]) assert.ok(near(x, y), 'missed copy at ' + x + ',' + y + ': ' + JSON.stringify(strong));
  assert.equal(strong.length, 5, JSON.stringify(strong));
});
