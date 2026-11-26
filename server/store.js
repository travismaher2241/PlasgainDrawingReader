// Shared library for the estimating team: the active Item List, saved drawing
// aliases, exclusion rules and the log of SKU corrections.
// In production it lives in Firestore so it is the same for everyone and
// survives redeploys. Locally (no Firebase credentials) it is a JSON file.

import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

const EMPTY = () => ({itemList: {fileName: '', uploadedAt: '', items: []}, aliases: {}, exclusions: [], corrections: []});
export const MAX_CORRECTIONS = 5000;

export function createStore(dir) {
  return firebaseConfigured() ? createFirestoreStore() : createFileStore(dir);
}

export const firebaseConfigured = () => Boolean(process.env.FIREBASE_SERVICE_ACCOUNT ||
  (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY));

/* ------------------------------------------------------------ local file */

export function createFileStore(dir) {
  const file = path.join(dir, 'library.json');
  let cache;
  let queue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      cache = {...EMPTY(), ...JSON.parse(await readFile(file, 'utf8'))};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cache = EMPTY();
    }
    return cache;
  }

  // Writes go through one queue and an atomic rename, so concurrent saves
  // cannot corrupt the file.
  function update(change) {
    const run = queue.then(async () => {
      const data = await load();
      change(data);
      await mkdir(dir, {recursive: true});
      const temp = file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify(data, null, 2));
      await rename(temp, file);
      return data;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    kind: 'file',
    load,
    setItemList: (fileName, items) => update(data => { data.itemList = {fileName, uploadedAt: new Date().toISOString(), items}; }),
    setAliases: aliases => update(data => { data.aliases = aliases; }),
    setExclusions: exclusions => update(data => { data.exclusions = exclusions; }),
    addCorrection: (correction, alias) => update(data => {
      data.corrections.push({...correction, at: new Date().toISOString()});
      if (data.corrections.length > MAX_CORRECTIONS) data.corrections.splice(0, data.corrections.length - MAX_CORRECTIONS);
      if (alias) data.aliases[alias.label] = alias.sku;
    }),
  };
}

/* ------------------------------------------------------------- Firestore */

// Credentials come from FIREBASE_SERVICE_ACCOUNT (the whole service-account
// JSON) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
async function firestoreFromEnv() {
  const {cert, getApps, initializeApp} = await import('firebase-admin/app');
  const {getFirestore} = await import('firebase-admin/firestore');
  const name = 'plasgain-takeoff';
  let app = getApps().find(existing => existing.name === name);
  if (!app) {
    const account = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    app = initializeApp({credential: cert(account)}, name);
  }
  return getFirestore(app);
}

const CHUNK = 400; // Item List rows per document, well under Firestore's 1 MB document limit
const aliasId = label => createHash('sha1').update(label).digest('hex');

// Layout (collection names start with FIRESTORE_PREFIX, default "takeoff"):
//   takeoff_library/settings   {itemList: {fileName, uploadedAt, version, chunks, count}, exclusions}
//   takeoff_item_chunks/{version}_{n}  {items: [...]}
//   takeoff_aliases/{sha1(label)}      {label, sku}
//   takeoff_corrections/{auto id}      {..., at}
export function createFirestoreStore({db: given, prefix = process.env.FIRESTORE_PREFIX || 'takeoff'} = {}) {
  let dbPromise;
  const db = () => (dbPromise ||= given ? Promise.resolve(given) : firestoreFromEnv());
  const col = async name => (await db()).collection(prefix + '_' + name);
  const settingsRef = async () => (await col('library')).doc('settings');

  async function commitInBatches(ops) {
    const database = await db();
    for (let i = 0; i < ops.length; i += 450) {
      const batch = database.batch();
      for (const op of ops.slice(i, i + 450)) op(batch);
      await batch.commit();
    }
  }

  async function load() {
    const [settingsSnap, aliasSnap, correctionSnap] = await Promise.all([
      (await settingsRef()).get(),
      (await col('aliases')).get(),
      (await col('corrections')).orderBy('at', 'desc').limit(MAX_CORRECTIONS).get(),
    ]);
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const meta = settings.itemList || {};
    let items = [];
    if (meta.version && meta.chunks) {
      const chunks = await col('item_chunks');
      const snaps = await Promise.all(Array.from({length: meta.chunks}, (_, n) => chunks.doc(meta.version + '_' + n).get()));
      items = snaps.flatMap(snap => (snap.exists ? snap.data().items : []) || []);
    }
    return {
      itemList: {fileName: meta.fileName || '', uploadedAt: meta.uploadedAt || '', items},
      aliases: Object.fromEntries(aliasSnap.docs.map(doc => [doc.data().label, doc.data().sku])),
      exclusions: settings.exclusions || [],
      corrections: correctionSnap.docs.map(doc => doc.data()).reverse(),
    };
  }

  async function setItemList(fileName, items) {
    const settings = await settingsRef();
    const previous = (await settings.get()).data()?.itemList;
    const version = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const chunks = await col('item_chunks');
    const count = Math.ceil(items.length / CHUNK);
    // Write the new chunks first, then point the settings at them, so readers
    // never see half an Item List; then remove the old version.
    await commitInBatches(Array.from({length: count}, (_, n) => batch =>
      batch.set(chunks.doc(version + '_' + n), {items: items.slice(n * CHUNK, (n + 1) * CHUNK)})));
    await settings.set({itemList: {fileName, uploadedAt: new Date().toISOString(), version, chunks: count, count: items.length}}, {merge: true});
    if (previous?.version && previous.chunks) {
      await commitInBatches(Array.from({length: previous.chunks}, (_, n) => batch => batch.delete(chunks.doc(previous.version + '_' + n))));
    }
    return load();
  }

  async function setAliases(aliases) {
    const collection = await col('aliases');
    const existing = await collection.get();
    const keep = new Set(Object.keys(aliases).map(aliasId));
    await commitInBatches([
      ...existing.docs.filter(doc => !keep.has(doc.id)).map(doc => batch => batch.delete(doc.ref)),
      ...Object.entries(aliases).map(([label, sku]) => batch => batch.set(collection.doc(aliasId(label)), {label, sku})),
    ]);
    return load();
  }

  async function setExclusions(exclusions) {
    await (await settingsRef()).set({exclusions}, {merge: true});
    return load();
  }

  async function addCorrection(correction, alias) {
    await (await col('corrections')).add({...correction, at: new Date().toISOString()});
    if (alias) await (await col('aliases')).doc(aliasId(alias.label)).set({label: alias.label, sku: alias.sku});
    return load();
  }

  return {kind: 'firestore', load, setItemList, setAliases, setExclusions, addCorrection};
}
