import assert from 'node:assert/strict';
import test from 'node:test';
import {groundExtraction, locateQuote} from '../src/grounding.js';
import {catalogueFromRows} from '../src/takeoff.js';

const LINES = [
  {text: 'LUMINAIRE SCHEDULE', point: [600, 700]},
  {text: 'L1 LED street light 150W IP66 12', point: [600, 680]},
  {text: '25mm PVC conduit 6.5m', point: [100, 300]},
];

const item = overrides => ({description: 'LED street light 150W IP66', source_quote: 'L1 LED street light 150W IP66',
  location: 'schedule', location_note: 'top right', count_method: 'schedule', quantity_text: '12', quantity: 12, unit: 'ea',
  multiplier_note: '', or_equivalent: false, uncertainty: '', box: null, ...overrides});

test('quotes are located in the text layer', () => {
  assert.equal(locateQuote('L1 LED street light', LINES).line.point[1], 680);
  assert.equal(locateQuote('Bollard', LINES).score, 0);
});

test('grounded items keep their citation; unsupported claims are flagged or dropped', () => {
  const {rows, dropped, titleBlock} = groundExtraction({
    title_block: {project: 'Smith St', drawing_number: 'E-101', drawing_title: '', revision: 'B', status: 'tender'},
    page_kind: 'plan',
    items: [
      item(),
      item({source_quote: 'Bollard B2', description: 'Bollard', quantity: 4, quantity_text: '4'}),
      item({source_quote: '', description: 'Invented pole'}),
      item({source_quote: '25mm PVC conduit 6.5m', description: '25mm PVC conduit', count_method: 'callout', quantity_text: '6.5m', quantity: 6.5, unit: 'm'}),
      item({source_quote: 'L1 LED street light', quantity: 14, quantity_text: '12'}),
      item({source_quote: 'L1 LED street light', count_method: 'unspecified', quantity_text: 'as required', quantity: 3}),
      item({location: 'typical_detail'}),
    ],
  }, {pageId: 2, lines: LINES, width: 800, height: 800});
  assert.deepEqual(dropped, ['Invented pole']);
  assert.equal(rows[0].extractConfidence, 'High');
  assert.deepEqual(rows[0].point, [600, 680]);
  assert.equal(rows[1].extractConfidence, 'Low');
  assert.match(rows[1].extractNote, /not found in the PDF text/);
  assert.equal(rows[2].quantity, 6.5);
  assert.equal(rows[3].extractConfidence, 'Low');
  assert.match(rows[3].extractNote, /differs from written/);
  assert.equal(rows[4].quantity, null);
  assert.equal(rows[5].typical, true);
  assert.equal(titleBlock.status, 'TENDER');
  assert.ok(rows.every(row => !('sku' in row)));
});

test('image-only pages are read but marked for checking', () => {
  const {rows} = groundExtraction({items: [item({box: {x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2}})]}, {pageId: 0, lines: [], width: 1000, height: 500});
  assert.equal(rows[0].extractConfidence, 'Medium');
  assert.deepEqual(rows[0].point.map(Math.round), [150, 425]);
  assert.equal(rows[0].approximate, true);
});

test('spreadsheet title rows above the headings are skipped', () => {
  const items = catalogueFromRows([['Plasgain Item List', null], ['Exported 2026'], ['Item Code', 'Item Description', 'Status'], ['A1', 'Pit lid', 'Active'], ['A2', 'Old lid', 'Inactive']]);
  assert.deepEqual(items.map(entry => entry.sku), ['A1']);
});

test('Gemini fallback prefers the newest stable Pro model', async () => {
  const {rankModels} = await import('../server/gemini.js');
  assert.deepEqual(rankModels(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash-image', 'text-embedding-004', 'gemini-2.5-flash-lite']),
    ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']);
});

test('Gemini quota errors become one plain sentence', async () => {
  const {friendlyError} = await import('../server/gemini.js');
  const raw = new Error('{"error":{"code":429,"message":"You exceeded your current quota... Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro, description: ... Free Tier. Please retry in 6h48m53.9s.","status":"RESOURCE_EXHAUSTED"}}');
  assert.match(friendlyError(raw).message, /^Gemini quota: this API key is on the free tier/);
  assert.match(friendlyError(new Error('{"error":{"code":429,"message":"Please retry in 41.5s.","status":"RESOURCE_EXHAUSTED"}}')).message, /^Gemini quota exceeded, try again in about 41s/);
  const other = new Error('boom');
  assert.equal(friendlyError(other), other);
});
