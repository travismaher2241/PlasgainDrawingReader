import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createServer} from '../server/index.js';

async function start(ai, passcode) {
  const server = createServer({dataDir: await mkdtemp(path.join(tmpdir(), 'plasgain-')), ai, passcode});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {method, headers: {'content-type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
    return {status: response.status, json: await response.json()};
  };
  return {server, call};
}

const fakeAi = {
  MODEL: 'test-model',
  configured: () => true,
  extractPage: async () => ({title_block: {project: '', drawing_number: 'E-1', drawing_title: '', revision: 'A', status: ''}, page_kind: 'plan',
    items: [{description: 'Pole', source_quote: 'P1 Pole', location: 'schedule', location_note: '', count_method: 'schedule', quantity_text: '2',
      quantity: 2, unit: 'ea', multiplier_note: '', or_equivalent: false, uncertainty: '', box: null, sku: 'MADE-UP'}]}),
};

test('extraction is grounded and never passes through an AI part number', async () => {
  const {server, call} = await start(fakeAi);
  try {
    const health = await call('GET', '/api/health');
    assert.deepEqual(health.json, {ok: true, ai: true, model: 'test-model', passcode: false, storage: 'file'});
    const result = await call('POST', '/api/extract', {page: {id: 0, file: 'a.pdf', number: 1, width: 100, height: 100},
      images: [{label: 'Whole sheet', mimeType: 'image/jpeg', data: 'AAAA'}], lines: [{text: 'P1 Pole 2', point: [1, 2]}]});
    assert.equal(result.status, 200);
    assert.equal(result.json.rows[0].quantity, 2);
    assert.equal(JSON.stringify(result.json).includes('MADE-UP'), false);
    assert.equal(result.json.titleBlock.drawingNumber, 'E-1');
    const bad = await call('POST', '/api/extract', {page: {id: 0}, images: [{mimeType: 'text/html', data: 'x'}]});
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('extraction reports a missing key clearly', async () => {
  const {server, call} = await start({...fakeAi, configured: () => false});
  try {
    const result = await call('POST', '/api/extract', {page: {id: 0}, images: [{mimeType: 'image/png', data: 'x'}]});
    assert.equal(result.status, 503);
    assert.match(result.json.error, /GEMINI_API_KEY/);
  } finally { server.close(); }
});

test('shared library keeps the Item List, aliases, exclusions and corrections', async () => {
  const {server, call} = await start(fakeAi);
  try {
    await call('PUT', '/api/library/item-list', {fileName: 'items.csv', items: [{sku: 'P1', description: 'Pole', status: 'Active'}]});
    await call('PUT', '/api/library/exclusions', {exclusions: ['by others']});
    await call('POST', '/api/library/corrections', {correction: {toSku: 'P1', fromSku: '', text: 'LP'}, alias: {label: 'lp', sku: 'P1'}});
    const {json} = await call('GET', '/api/library');
    assert.equal(json.itemList.items.length, 1);
    assert.deepEqual(json.exclusions, ['by others']);
    assert.equal(json.aliases.lp, 'P1');
    assert.equal(json.corrections[0].toSku, 'P1');
    assert.equal((await call('PUT', '/api/library/item-list', {items: [{}]})).status, 400);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  } finally { server.close(); }
});

test('a passcode protects every route except health, and Vercel-style routes work', async () => {
  const {server, call} = await start(fakeAi, 'open sesame');
  try {
    assert.equal((await call('GET', '/api/health')).json.passcode, true);
    assert.equal((await call('GET', '/api/library')).status, 401);
    assert.equal((await call('GET', '/api/library', undefined, {'x-app-passcode': 'wrong'})).status, 401);
    assert.equal((await call('GET', '/api/library', undefined, {'x-app-passcode': 'open sesame'})).status, 200);
    assert.equal((await call('GET', '/api?route=library', undefined, {'x-app-passcode': 'open sesame'})).status, 200);
  } finally { server.close(); }
});
