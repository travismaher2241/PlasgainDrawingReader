import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {crc32, zipFiles} from '../src/zip.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip archive opens with the standard unzip tool', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zip-'));
  const blob = zipFiles([{name: 'a-p1-marked.png', data: new Uint8Array([1, 2, 3])}, {name: 'b.txt', data: new TextEncoder().encode('hello')}]);
  writeFileSync(path.join(dir, 'out.zip'), Buffer.from(await blob.arrayBuffer()));
  let listing;
  try { listing = execFileSync('unzip', ['-o', 'out.zip'], {cwd: dir}).toString(); } catch (error) {
    if (error.code === 'ENOENT') return; // no unzip on this machine
    throw error;
  }
  assert.match(listing, /a-p1-marked\.png/);
  assert.equal(readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'hello');
});
