import assert from 'node:assert/strict';
import test from 'node:test';
import {findSymbol, labelSchedule, legendEntries, legendTemplates, pairLabels, pathPrimitives, poleLabels} from '../src/symbols.js';

const OPS = {save: 1, restore: 2, transform: 3, constructPath: 4};
const K = 0.5523; // Bezier circle constant

// A lantern symbol: a body line, an arm line and a small circle (the pole) at
// the end, drawn at (x, y) turned by `angle` and optionally mirrored.
function lantern(x, y, angle, mirror = 1) {
  const at = (dx, dy) => {
    const my = dy * mirror;
    return [x + dx * Math.cos(angle) - my * Math.sin(angle), y + dx * Math.sin(angle) + my * Math.cos(angle)];
  };
  const line = (a, b) => [0, ...at(...a), 1, ...at(...b)];
  const circle = (cx, cy, r) => [0, ...at(cx + r, cy),
    2, ...at(cx + r, cy + K * r), ...at(cx + K * r, cy + r), ...at(cx, cy + r),
    2, ...at(cx - K * r, cy + r), ...at(cx - r, cy + K * r), ...at(cx - r, cy),
    2, ...at(cx - r, cy - K * r), ...at(cx - K * r, cy - r), ...at(cx, cy - r),
    2, ...at(cx + K * r, cy - r), ...at(cx + r, cy - K * r), ...at(cx + r, cy)];
  return [line([-10, -3], [4, -3]), line([-10, 3], [0, 6]), line([4, -3], [8, 0]), circle(10.5, 0, 2.5)]
    .map(data => [OPS.constructPath, [20, [Float32Array.from(data)], null]]);
}

function operatorList(drawings) {
  const entries = drawings.flat();
  return {fnArray: entries.map(entry => entry[0]), argsArray: entries.map(entry => entry[1])};
}

const text = (str, x, y, size = 12) => ({str, transform: [size, 0, 0, size, x, y]});
const LEGEND = [
  text('LIGHTING :', 100, 420),
  text('14W LED SCO SYLVANIA STREETLED LANTERN', 180, 400),
  text('ON A 5.5m MOUNTING HEIGHT GALVANIZED URD POLE', 180, 387),
  text('13. STANDARD PUBLIC LIGHTING SHALL BE INSTALLED.', 100, 360),
];

test('legend lines pair the lantern with its pole and skip numbered notes', () => {
  const entries = legendEntries(LEGEND);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, '14W LED SCO SYLVANIA STREETLED LANTERN');
  assert.equal(entries[0].pole, 'ON A 5.5m MOUNTING HEIGHT GALVANIZED URD POLE');
});

test('every rotated or mirrored copy of the legend symbol is counted, and nothing else', () => {
  const primitives = pathPrimitives(operatorList([
    lantern(160, 404, 0), // the legend's own symbol
    lantern(500, 500, Math.PI / 2),
    lantern(700, 300, 0.65),
    lantern(900, 650, 2.4, -1),
    // decoys: a lone circle and a symbol drawn at twice the size
    lantern(1200, 200, 0).slice(3),
    [[OPS.save, null], [OPS.transform, [2, 0, 0, 2, -1000, -500]], ...lantern(800, 400, 0), [OPS.restore, null]],
  ]), OPS);
  const [legend] = legendTemplates(LEGEND, primitives);
  assert.ok(legend?.template, 'legend symbol found');
  assert.equal(legend.template.parts.length, 4);
  const found = findSymbol(legend.template, primitives).map(hit => [Math.round(hit.x), Math.round(hit.y)]);
  assert.equal(found.length, 3);
  for (const [x, y] of [[500, 500], [700, 300], [900, 650]]) {
    assert.ok(found.some(([fx, fy]) => Math.hypot(fx - x, fy - y) < 15), 'found the copy at ' + x + ',' + y);
  }
});

test('label schedule counts P/L pole rows and finds labels missing from the plan', () => {
  const row = (y, asset, label) => [text(asset, 880, y), text(label, 973, y), text('12', 1070, y)];
  const items = [
    text('LABEL SCHEDULE', 934, 436), text('ASSET', 887, 412), text('LABEL', 998, 412), text('TYPE', 1071, 412),
    ...row(390, 'P/L POLE', 'PO 2602515854'), ...row(368, 'P/L POLE', 'PO 2602515856'), ...row(345, 'P/L POLE', 'PO 2602516195'),
    ...row(323, 'PP OS LOT 227', 'PP 1234'),
    text('LABEL TYPE DETAILS AS PER', 900, 200),
    // labels beside the poles on the plan (rotated text), and a note that mentions another pole
    {str: 'BID PO 2602515854', transform: [0, 13, -13, 0, 1500, 900]},
    {str: 'BID PO 2602515856', transform: [13, 0, 0, 13, 1700, 600]},
    text('23. REMOVE (E) PL BID PO 2602516195', 100, 1000),
  ];
  assert.deepEqual(labelSchedule(items), {poles: 3, labels: ['PO 2602515854', 'PO 2602515856', 'PO 2602516195'], missing: ['PO 2602516195']});
  assert.equal(labelSchedule([text('LIGHTING :', 100, 420)]), null);
});

test('pole labels on the plan are found in any rotation and paired one-to-one with lights', () => {
  const labels = poleLabels([
    {str: 'BID PO 2602515854', width: 100, transform: [0, 10, -10, 0, 500, 500]},
    {str: 'BID PO 2602515856', width: 100, transform: [10, 0, 0, 10, 900, 300]},
    {str: 'BID PO 2602515999', width: 100, transform: [10, 0, 0, 10, 3000, 3000]},
    text('23. REMOVE (E) PL BID PO 2602089257', 100, 1000),
    text('PO 2602515854', 973, 390),
  ]);
  assert.deepEqual(labels.map(label => [label.label, Math.round(label.x), Math.round(label.y)]),
    [['BID PO 2602515854', 495, 550], ['BID PO 2602515856', 950, 305], ['BID PO 2602515999', 3050, 3005]]);
  const paired = pairLabels(labels, [[560, 540], [1000, 250], [520, 560]]);
  assert.deepEqual(paired.map(label => label.point), [[520, 560], [1000, 250], null]);
});
