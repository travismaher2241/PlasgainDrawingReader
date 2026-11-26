// Shared library for the estimating team: the active Item List, saved drawing
// aliases, exclusion rules and the log of SKU corrections. Stored as one JSON
// file so it survives restarts and is the same for every user.

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

const EMPTY = () => ({itemList: {fileName: '', uploadedAt: '', items: []}, aliases: {}, exclusions: [], corrections: []});

export function createStore(dir) {
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

  return {load, update};
}
