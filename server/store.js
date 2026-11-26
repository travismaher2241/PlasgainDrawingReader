// Shared library for the estimating team: the active Item List, saved drawing
// aliases, exclusion rules and the log of SKU corrections.
// On Vercel it lives in a private Vercel Blob store (one JSON file, updated
// with an ETag check so two people saving at once can't overwrite each other).
// Locally it is a JSON file in DATA_DIR.

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

const EMPTY = () => ({itemList: {fileName: '', uploadedAt: '', items: []}, aliases: {}, exclusions: [], corrections: []});
const withDefaults = data => ({...EMPTY(), ...data});

export function createStore(dir) {
  return process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? createBlobStore() : createFileStore(dir);
}

export function createFileStore(dir) {
  const file = path.join(dir, 'library.json');
  let cache;
  let queue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      cache = withDefaults(JSON.parse(await readFile(file, 'utf8')));
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

  return {load, update, kind: 'file'};
}

export function createBlobStore(pathname = 'plasgain/library.json') {
  const blob = import('@vercel/blob');

  async function read() {
    const {get} = await blob;
    const result = await get(pathname, {access: 'private', useCache: false});
    if (!result || result.statusCode !== 200) return {data: EMPTY(), etag: null};
    return {data: withDefaults(JSON.parse(await new Response(result.stream).text())), etag: result.blob.etag};
  }

  async function load() {
    return (await read()).data;
  }

  async function update(change) {
    const {put, BlobPreconditionFailedError} = await blob;
    for (let attempt = 0; attempt < 5; attempt++) {
      const {data, etag} = await read();
      change(data);
      try {
        await put(pathname, JSON.stringify(data), {
          access: 'private', contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 60,
          ...(etag ? {ifMatch: etag} : {allowOverwrite: false}),
        });
        return data;
      } catch (error) {
        // Someone else saved first: re-read and apply this change again.
        const conflict = error instanceof BlobPreconditionFailedError || (!etag && /exist/i.test(error.message));
        if (!conflict) throw error;
      }
    }
    throw new Error('The shared library is busy, please try again');
  }

  return {load, update, kind: 'blob'};
}
