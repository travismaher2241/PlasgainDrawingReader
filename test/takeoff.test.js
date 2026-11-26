import assert from 'node:assert/strict';
import test from 'node:test';
import {extractRows, flagDuplicates, matchItem, quoteCsv, readCatalogue} from '../src/takeoff.js';

test('catalogue matching filters inactive codes and keeps ambiguous candidates unassigned', () => {
  const items = readCatalogue('sku,description,status,drawing_aliases\r\nP1,"Steel pole, 6500mm",Active,LP1\r\nP2,Steel pole,Discontinued,LP2\r\nP3,Steel pole 5500 mm,Active,');
  assert.equal(matchItem('Steel pole, 6.5 m', items).sku, 'P1');
  assert.equal(matchItem('LP1', items).sku, 'P1');
  assert.equal(matchItem('LP2', items).sku, '');
  assert.deepEqual(matchItem('Steel pole', items).candidates, ['P1', 'P3']);
});

test('extracts explicit quantities and flags a conflicting cross-sheet schedule overlap', () => {
  const rows = extractRows([
    {text: 'Schedule: Steel pole Qty 4', pageId: 0, point: [10, 20]},
    {text: 'Steel pole Qty 3 x 2', pageId: 1},
    {text: 'Conduit length 6500 mm', pageId: 1},
    {text: 'Conduit length TBA', pageId: 2},
    {text: 'Trenching Qty 25', pageId: 2},
  ]);
  assert.deepEqual(rows.map(row => row.quantity), [4, 6, 6.5, null]);
  assert.deepEqual(rows[0].point, [10, 20]);
  assert.equal(rows[2].unit, 'm');
  assert.equal(rows[3].source, 'unspecified');
  rows.forEach(row => Object.assign(row, {reason: '', confidence: 'High'}));
  flagDuplicates(rows);
  assert.equal(rows[1].excluded, true);
  assert.equal(rows[0].excluded, undefined);
  assert.equal(rows[0].confidence, 'Low');
  assert.match(rows[1].reason, /4, 6/);
});

test('CSV export preserves quoted source wording and escapes spreadsheet formulas', () => {
  assert.equal(quoteCsv([['=1+2', 'Schedule "A"', 4]]), '"\'=1+2","Schedule ""A""","4"\r\n');
});
