import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createServer} from '../server/index.js';
import {describeColumns, itemsFromOstendo, readTable, sanitize, tableUrl} from '../server/ostendo.js';

const withEnv = async (env, run) => {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
};
const SETTINGS = {OSTENDO_API_URL: 'https://plasgain.southeastit.com.au:8843/api', OSTENDO_API_KEY: 'secret-key'};

const ROWS = [
  {ITEMCODE: 'PG-POLE-6', ITEMDESCRIPTION: 'Street light pole 6m galvanised', ITEMSTATUS: 'Active', ITEMCATEGORY: 'Poles', STOCKUNIT: 'EA', COST: 12},
  {ITEMCODE: 'PG-PIT-600', ITEMDESCRIPTION: 'Pit 600 x 600 Class B', ITEMSTATUS: 'Active', ITEMCATEGORY: 'Pits', STOCKUNIT: 'EA'},
  {ITEMCODE: 'PG-OLD', ITEMDESCRIPTION: 'Old conduit', ITEMSTATUS: 'Inactive', ITEMCATEGORY: 'Conduit', STOCKUNIT: 'M'},
  {ITEMCODE: '', ITEMDESCRIPTION: 'No code', ITEMSTATUS: 'Active'},
];

test('the Ostendo URL is guarded and the key never leaks', () => withEnv(SETTINGS, () => {
  const url = tableUrl('ITEMMASTER', "ITEMSTATUS = 'Active'");
  assert.match(url, /^https:\/\/plasgain\.southeastit\.com\.au:8843\/api\/tabledata\?configuration=0&tablename=ITEMMASTER&apikey=secret-key&format=json&condition=ITEMSTATUS%3D%27Active%27$/);
  assert.equal(sanitize('failed ' + url).includes('secret-key'), false);
  return withEnv({OSTENDO_API_URL: 'https://evil.example.com:8843/api'}, () => assert.throws(() => tableUrl('ITEMMASTER'), /host must be/));
}));

test('Ostendo errors sent with HTTP 200 are caught', () => withEnv(SETTINGS, async () => {
  const fake = body => async () => new Response(body, {status: 200});
  await assert.rejects(readTable('ITEMMASTER', '', {fetchImpl: fake('Invalid API key')}), /Ostendo error/);
  await assert.rejects(readTable('ITEMMASTER', '', {fetchImpl: fake('<html>oops</html>')}), /Ostendo error: +oops/);
  assert.deepEqual(await readTable('ITEMMASTER', '', {fetchImpl: fake(JSON.stringify({ITEMMASTER: [{ITEMCODE: 'A'}]}))}), [{ITEMCODE: 'A'}]);
}));

test('Ostendo items map to the active Item List and keep drawing extras by SKU', () => {
  const previous = [{sku: 'pg-pole-6', description: 'old', status: 'Active', drawing_aliases: 'SL1|P6', pack_size: '1', required_accessories: 'PG-BASE'}];
  const {items, inactive, statusRule} = itemsFromOstendo(ROWS, previous);
  assert.deepEqual(items.map(item => item.sku), ['PG-POLE-6', 'PG-PIT-600']);
  assert.equal(inactive, 1);
  assert.equal(statusRule, 'ITEMSTATUS = Active');
  assert.equal(items[0].unit, 'EA');
  assert.equal(items[0].category, 'Poles');
  assert.equal(items[0].drawing_aliases, 'SL1|P6');
  assert.equal(items[0].required_accessories, 'PG-BASE');
  assert.equal(items[1].drawing_aliases, undefined);
});

test('an obsolete flag is used when there is no status column', () => {
  const {items, statusRule} = itemsFromOstendo([
    {ITEMCODE: 'A', ITEMDESCRIPTION: 'Pit lid', OBSOLETE: 'False'},
    {ITEMCODE: 'B', ITEMDESCRIPTION: 'Old lid', OBSOLETE: 'True'},
  ]);
  assert.deepEqual(items.map(item => item.sku), ['A']);
  assert.match(statusRule, /OBSOLETE/);
  assert.throws(() => itemsFromOstendo([{FOO: 1}]), /no sku or description column/);
});

test('the column check reports structure only', () => {
  const report = describeColumns(ROWS);
  assert.equal(report.rows, 4);
  assert.equal(report.mapping.sku, 'ITEMCODE');
  assert.deepEqual(report.statusValues, {Active: 3, Inactive: 1});
  assert.equal(JSON.stringify(report).includes('Street light'), false);
});

test('the server syncs the Item List from Ostendo', async () => {
  let asked;
  const server = createServer({dataDir: await mkdtemp(path.join(tmpdir(), 'ostendo-')), ai: {configured: () => false},
    ostendo: {configured: () => true, read: async (table, condition) => { asked = [table, condition]; return ROWS; }}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await (await fetch(base + '/api/health')).json()).ostendo, true);
    const response = await fetch(base + '/api/library/item-list/ostendo', {method: 'POST'});
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(asked, ['ITEMMASTER', '']);
    assert.equal(result.sync.count, 2);
    assert.equal(result.itemList.fileName, 'Ostendo ITEMMASTER');
    assert.equal((await (await fetch(base + '/api/library')).json()).itemList.items.length, 2);
  } finally {
    server.close();
  }
});

test('sync explains when Ostendo is not connected', async () => {
  const server = createServer({dataDir: await mkdtemp(path.join(tmpdir(), 'ostendo-')), ai: {configured: () => false},
    ostendo: {configured: () => false, read: async () => []}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/library/item-list/ostendo', {method: 'POST'});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /OSTENDO_API_URL/);
  } finally {
    server.close();
  }
});
