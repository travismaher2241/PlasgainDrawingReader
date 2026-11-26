// Small HTTP server: holds the Gemini key, runs page extraction, stores the
// shared Item List library, and serves the built app from dist/.

import {createServer as createHttpServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {groundExtraction} from '../src/grounding.js';
import {createStore} from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 40 * 1024 * 1024;
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json'};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

const send = (response, status, data) => {
  response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
  response.end(JSON.stringify(data));
};

export function createServer({dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'),
  staticDir = path.join(here, '..', 'dist'), ai} = {}) {
  const store = createStore(dataDir);
  const reader = ai ?? null;

  const routes = {
    'GET /api/health': async () => {
      const engine = reader ?? await import('./gemini.js');
      return {ok: true, ai: engine.configured(), model: engine.configured() ? engine.MODEL : ''};
    },
    'POST /api/extract': async request => {
      const engine = reader ?? await import('./gemini.js');
      if (!engine.configured()) throw new HttpError(503, 'AI reader not configured. Set GEMINI_API_KEY on the server.');
      const {page, images, lines} = await body(request);
      if (!page || !Array.isArray(images) || !images.length) throw new HttpError(400, 'page and images are required');
      for (const image of images) {
        if (!/^image\/(png|jpeg|webp)$/.test(image.mimeType) || typeof image.data !== 'string') throw new HttpError(400, 'Images must be PNG, JPEG or WebP base64');
      }
      const output = await engine.extractPage({page, images, lines: Array.isArray(lines) ? lines : []});
      return groundExtraction(output, {pageId: page.id, lines: Array.isArray(lines) ? lines : [], width: page.width, height: page.height});
    },
    'GET /api/library': async () => store.load(),
    'PUT /api/library/item-list': async request => {
      const {fileName, items} = await body(request);
      if (!Array.isArray(items) || !items.every(item => item?.sku && item?.description)) throw new HttpError(400, 'items must list sku and description');
      return store.update(data => { data.itemList = {fileName: String(fileName || ''), uploadedAt: new Date().toISOString(), items}; });
    },
    'PUT /api/library/aliases': async request => {
      const {aliases} = await body(request);
      if (!aliases || typeof aliases !== 'object') throw new HttpError(400, 'aliases must be an object');
      return store.update(data => { data.aliases = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [String(k), String(v)])); });
    },
    'PUT /api/library/exclusions': async request => {
      const {exclusions} = await body(request);
      if (!Array.isArray(exclusions)) throw new HttpError(400, 'exclusions must be a list');
      return store.update(data => { data.exclusions = exclusions.map(String).filter(Boolean); });
    },
    'POST /api/library/corrections': async request => {
      const {correction, alias} = await body(request);
      if (!correction?.toSku) throw new HttpError(400, 'correction.toSku is required');
      return store.update(data => {
        data.corrections.push({...correction, at: new Date().toISOString()});
        if (data.corrections.length > 5000) data.corrections.splice(0, data.corrections.length - 5000);
        if (alias?.label && alias?.sku) data.aliases[String(alias.label)] = String(alias.sku);
      });
    },
  };

  async function serveStatic(request, response) {
    const url = new URL(request.url, 'http://local');
    const target = path.normalize(path.join(staticDir, decodeURIComponent(url.pathname)));
    if (target !== staticDir && !target.startsWith(staticDir + path.sep)) throw new HttpError(404, 'Not found');
    let file = target;
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(staticDir, 'index.html');
    }
    try {
      const content = await readFile(file);
      response.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream'});
      response.end(content);
    } catch {
      throw new HttpError(404, 'Build the app first with npm run build');
    }
  }

  return createHttpServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://local').pathname;
      const route = routes[request.method + ' ' + pathname];
      if (route) return send(response, 200, await route(request));
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown API route');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      await serveStatic(request, response);
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) send(response, status, {error: status === 500 ? 'Server error: ' + error.message : error.message});
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log('Plasgain takeoff server on http://' + host + ':' + port));
}
