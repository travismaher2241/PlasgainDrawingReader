// Stage 1 reader: asks Google Gemini to list what is on one drawing page.
// It is only asked to read the drawing. Part numbers are matched afterwards by
// code against the active Item List, so the AI cannot invent a Plasgain SKU.

import {GoogleGenAI} from '@google/genai';
import {EXTRACTION_SCHEMA} from '../src/grounding.js';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
// Model actually used: MODEL, or the best available Pro model if MODEL is not offered to this key.
let activeModel = MODEL;
let switchedAt = 0;
const RECHECK_MS = 60 * 60 * 1000;
export const currentModel = () => activeModel;

export const INSTRUCTIONS = `You read engineering drawing sheets (lighting, civil and electrical) for Plasgain's estimating team.
List every potentially supplyable product or material shown on this ONE page: luminaires, poles, outreaches, brackets, pits and lids, fittings, fixings and similar.

Rules:
- Ground strictly in the drawing. Only list items, specifications and quantities that are visibly written or drawn on this page. Never invent items, sizes or quantities. Never output a supplier part number unless it is printed on the drawing, and then only inside source_quote/description as printed.
- source_quote must be the exact wording or label on the sheet for that item (schedule row text, callout text or legend label), copied character for character.
- description: the product with every stated size, rating, material and finish. Keep metric values as written (e.g. "6.5m", "6500mm").
- count_method: "schedule" when the quantity comes from a schedule or table; "callout" when a note or leader states it (e.g. "4 off", "x3", "25m"); "counted" when you counted symbols in plan view yourself; "unspecified" when no quantity or length is stated, or it says "as required", "TBA" or similar.
- Multipliers: for notes such as "3x" or "x4", set quantity to the total and put the multiplier wording in multiplier_note.
- Lengths: unit "m" and quantity in metres for linear runs (conduit, cable, kerb). Only use stated lengths. Never measure a run from the drawing scale: use count_method "unspecified" and quantity null instead.
- Counted symbols: count only symbols that the legend ties to a product, list one item per symbol type, quote the legend label, and state any doubt.
- If the same product appears in a schedule and in plan view on this page, list both entries separately with their own count_method. Do not merge or average counts.
- Items drawn inside a "typical" detail or section: location "typical_detail" or "section".
- Ignore civil and installation work (trenching, excavation, concrete, backfill, labour, survey, traffic control) and anything marked existing to remain or by others.
- Ignore high-voltage and substation network equipment: transformers, kiosks, HV switches, HV fusegear, elbow connectors, insulated caps, isolator and feeder strips, and any schedule for a substation asset ("BID SS").
- Plasgain does not supply these, so do not list them: pillars, service pits, temporary pits, bollards and protective posts, bores, conduit, cables, marker tape and cover slabs.
- Do not list rows from a LABEL SCHEDULE (ASSET | LABEL | TYPE) table: it labels assets, it is not a supply list.
- uncertainty: state the exact reason whenever symbols overlap, sit near the page edge or crop, are hard to read, or conflict with another view on the page. Leave empty if none.
- box: approximate position as fractions of the full page width and height (origin top left), or null if unsure.
- title_block: copy the project name, drawing number, title, revision and status (e.g. TENDER, FOR CONSTRUCTION) only if visible; otherwise use empty strings.
- If the page has no supplyable items (cover sheet, general notes, terms), return an empty items list.`;

let client;
export const configured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

function genai() {
  // Preview models and per-image media resolution are only served on v1beta;
  // the SDK's own default is v1.
  client ||= new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    apiVersion: process.env.GEMINI_API_VERSION || 'v1beta'});
  return client;
}

// images: [{label, mimeType, data(base64)}]; lines: text layer lines [{text}]
// `fast` asks for a quicker read (less thinking), used when a busy sheet timed out.
export async function extractPage({images, lines, page, fast = false}) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const textLayer = (lines || []).map(line => line.text).filter(Boolean).join('\n').slice(0, 60000);
  // Gemini 3 takes a per-image resolution and a thinking level; older models don't.
  const gemini3 = model => /^gemini-([3-9]|\d{2})/.test(model);
  const request = model => {
    const parts = [];
    for (const image of images) {
      parts.push({text: image.label});
      parts.push({inlineData: {mimeType: image.mimeType, data: image.data},
        ...(gemini3(model) ? {mediaResolution: {level: 'MEDIA_RESOLUTION_HIGH'}} : {})});
    }
    parts.push({text: `Page ${page.number} of "${page.file}". The first image is the whole sheet; the others are enlarged quarters of the same sheet for reading fine print.` +
      (textLayer ? `\n\nText found in the PDF's text layer (use it to read fine print exactly; it has no layout):\n${textLayer}` :
        '\n\nThis page has no PDF text layer, so read everything from the images.') +
      '\n\nList the supplyable items on this page following the rules.'});
    return genai().models.generateContent({
      model,
      contents: [{role: 'user', parts}],
      config: {
        systemInstruction: INSTRUCTIONS,
        responseMimeType: 'application/json',
        responseJsonSchema: EXTRACTION_SCHEMA,
        // Flash at HIGH thinking took over 5 minutes on a busy sheet, so Flash
        // thinks at MEDIUM. Pro keeps HIGH.
        // A quick retry thinks at LOW.
        ...(gemini3(model) ? {thinkingConfig: {thinkingLevel: fast ? 'LOW' : /-flash/.test(model) ? 'MEDIUM' : 'HIGH'}} : {}),
        // Stop before the 300 s server limit so the page gets a clear message.
        abortSignal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      },
    });
  };

  // A free-tier key gets no Pro quota, so it uses the best Flash model instead.
  // MODEL is tried again every hour, so turning on billing brings Pro back.
  if (activeModel !== MODEL && Date.now() - switchedAt > RECHECK_MS) activeModel = MODEL;
  const tried = new Set();
  let response;
  // "High demand" (503) and server errors are usually brief: wait and try
  // again, and after two of them try another Flash model for this page.
  let model = activeModel, busy = 0;
  for (;;) {
    tried.add(model);
    try {
      response = await request(model);
      break;
    } catch (error) {
      if (isBusy(error)) {
        busy++;
        const wait = BUSY_WAITS_MS[busy - 1];
        if (wait === undefined || Date.now() + wait + 20000 > deadline) throw friendlyError(error);
        console.warn('Gemini ' + model + ' is busy (attempt ' + busy + '); retrying in ' + wait / 1000 + ' s');
        await new Promise(resolve => setTimeout(resolve, wait));
        if (busy >= 2) {
          const other = (await availableModels().catch(() => [])).find(name => !tried.has(name) && /-flash/.test(name));
          if (other) model = other;
        }
        continue;
      }
      if (model !== activeModel) throw friendlyError(error);
      const freeTier = isFreeTierBlocked(error);
      if (!isNotFound(error) && !freeTier) throw friendlyError(error);
      if (tried.size >= 4) throw friendlyError(error);
      const fallback = (await availableModels()).find(name => !tried.has(name) && (!freeTier || /-flash/.test(name)));
      if (!fallback) throw friendlyError(error);
      console.warn('Gemini model ' + activeModel + (freeTier ? ' has no free-tier quota' : ' is not available to this key') + '; using ' + fallback);
      activeModel = fallback;
      model = fallback;
      switchedAt = Date.now();
    }
  }
  const text = response.text;
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason || 'no answer';
    throw new Error('The AI returned no result (' + reason + ')');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI answer was not valid JSON');
  }
}

const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 270000;

const BUSY_WAITS_MS = (process.env.GEMINI_BUSY_WAITS_MS || '3000,8000,15000').split(',').map(Number);

// Gemini overloaded or briefly failing: 503 UNAVAILABLE, 500 INTERNAL, 504.
export const isBusy = error => {
  const text = String(error?.message || '');
  const code = error?.status || Number(text.match(/"code"\s*:\s*(\d{3})/)?.[1]) || 0;
  return [500, 503, 504].includes(code) || /UNAVAILABLE|high demand|overloaded|INTERNAL/i.test(text);
};

const isNotFound = error => error?.status === 404 || /NOT_FOUND|is not found/i.test(String(error?.message));

// Ranks the key's models: newest Gemini version first, Pro before Flash, stable before preview.
export function rankModels(names) {
  const score = name => {
    const version = Number(name.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
    return version * 100 + (/-pro/.test(name) ? 20 : /-flash(?!-lite)/.test(name) ? 10 : 0) + (/preview|exp/.test(name) ? 0 : 1);
  };
  return names.filter(name => /^gemini-\d/.test(name) && !/(tts|image|audio|live|embedding|lite|computer)/.test(name))
    .sort((a, b) => score(b) - score(a));
}

let modelList;
async function availableModels() {
  if (modelList) return modelList;
  const names = [];
  const pager = await genai().models.list({config: {pageSize: 100}});
  for await (const model of pager) {
    if (!model.supportedActions || model.supportedActions.includes('generateContent')) names.push(String(model.name).replace(/^models\//, ''));
  }
  return (modelList = rankModels(names));
}

// A 429 whose free-tier limit is 0 means this model is never available on the free tier.
export const isFreeTierBlocked = error => /RESOURCE_EXHAUSTED|"code"\s*:\s*429/.test(String(error?.message)) &&
  /free_tier|Free Tier/.test(String(error?.message)) && /limit: 0\b/.test(String(error?.message));

// Gemini's errors are long JSON dumps; turn the common ones into one plain sentence.
export function friendlyError(error) {
  const text = String(error?.message || error);
  const code = error?.status || Number(text.match(/"code"\s*:\s*(\d{3})/)?.[1]) || 0;
  let message = '';
  if (code === 429 || /RESOURCE_EXHAUSTED/.test(text)) {
    const parts = text.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)(?:\.\d+)?s)?/i);
    const retry = parts && (parts[1] || parts[2] ? (parts[1] ? parts[1] + 'h ' : '') + (parts[2] || 0) + 'm' : parts[3] ? parts[3] + 's' : '');
    message = /free_tier|Free Tier/.test(text) && /limit: 0\b/.test(text) ?
      'Gemini quota: this API key is on the free tier, which does not include ' + activeModel + '. Turn on billing for the key in Google AI Studio.' :
      'Gemini quota exceeded' + (retry ? ', try again in about ' + retry : '') + '.';
  } else if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /aborted|timed? ?out/i.test(text)) {
    message = 'The AI took too long on this page (over ' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' s). Try the page again, or split a very busy sheet.';
  } else if (isBusy(error)) {
    message = 'Gemini is busy right now (high demand) and did not answer after several tries.';
  } else if (code === 400 && /API key not valid|API_KEY_INVALID/.test(text)) {
    message = 'Gemini key rejected: check GEMINI_API_KEY in Vercel.';
  } else if (code === 403) {
    message = 'Gemini access denied for this key (' + (text.match(/"message"\s*:\s*"([^"]{0,160})/)?.[1] || 'permission denied') + ').';
  }
  if (!message) return error;
  const friendly = new Error(message);
  friendly.status = 502;
  return friendly;
}
