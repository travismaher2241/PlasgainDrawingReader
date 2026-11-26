import assert from 'node:assert/strict';
import test from 'node:test';
import {createFirestoreStore} from '../server/store.js';

// Minimal in-memory stand-in for the parts of the Firestore Admin API the store uses.
function fakeFirestore() {
  const data = new Map();
  let auto = 0;
  const snap = (path, id) => ({id, exists: data.has(path), data: () => structuredClone(data.get(path)), ref: docRef(path, id)});
  function docRef(path, id) {
    return {
      id, path,
      get: async () => snap(path, id),
      set: async (value, options) => { data.set(path, options?.merge ? {...(data.get(path) || {}), ...structuredClone(value)} : structuredClone(value)); },
      delete: async () => { data.delete(path); },
    };
  }
  function collection(name) {
    const docs = () => [...data.keys()].filter(key => key.startsWith(name + '/')).map(key => snap(key, key.slice(name.length + 1)));
    const query = (sorted = docs()) => ({
      get: async () => ({docs: sorted}),
      orderBy: (field, direction) => query([...sorted].sort((a, b) => (a.data()[field] > b.data()[field] ? 1 : a.data()[field] < b.data()[field] ? -1 : 0) * (direction === 'desc' ? -1 : 1))),
      limit: n => query(sorted.slice(0, n)),
    });
    return {...query(), doc: id => docRef(name + '/' + id, id), add: async value => docRef(name + '/' + (++auto), String(auto)).set(value)};
  }
  return {
    data,
    collection,
    batch() {
      const ops = [];
      return {set: (ref, value) => ops.push(() => ref.set(value)), delete: ref => ops.push(() => ref.delete()), commit: async () => { for (const op of ops) await op(); }};
    },
  };
}

test('Firestore store splits large Item Lists, swaps versions and keeps aliases and corrections', async () => {
  const db = fakeFirestore();
  const store = createFirestoreStore({db, prefix: 't'});
  assert.deepEqual(await store.load(), {itemList: {fileName: '', uploadedAt: '', items: []}, aliases: {}, exclusions: [], corrections: []});

  const items = Array.from({length: 1000}, (_, i) => ({sku: 'S' + i, description: 'Item ' + i, status: 'Active'}));
  let library = await store.setItemList('big.xlsx', items);
  assert.equal(library.itemList.items.length, 1000);
  assert.equal(library.itemList.items[999].sku, 'S999');
  assert.equal([...db.data.keys()].filter(key => key.startsWith('t_item_chunks/')).length, 3);

  library = await store.setItemList('small.csv', items.slice(0, 10));
  assert.equal(library.itemList.fileName, 'small.csv');
  assert.equal([...db.data.keys()].filter(key => key.startsWith('t_item_chunks/')).length, 1);

  await store.setExclusions(['by others']);
  await store.addCorrection({text: 'LP/1', toSku: 'S1'}, {label: 'lp/1', sku: 'S1'});
  await store.addCorrection({text: 'X', toSku: 'S2'}, null);
  library = await store.setAliases({'lp/1': 'S1', pit: 'S3'});
  assert.deepEqual(library.aliases, {'lp/1': 'S1', pit: 'S3'});
  library = await store.setAliases({pit: 'S4'});
  assert.deepEqual(library.aliases, {pit: 'S4'});
  assert.deepEqual(library.exclusions, ['by others']);
  assert.deepEqual(library.corrections.map(entry => entry.toSku).sort(), ['S1', 'S2']);
  assert.equal(library.itemList.items.length, 10);
});
