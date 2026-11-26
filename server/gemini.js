// Stage 1 reader: asks Google Gemini to list what is on one drawing page.
// It is only asked to read the drawing. Part numbers are matched afterwards by
// code against the active Item List, so the AI cannot invent a Plasgain SKU.

import {GoogleGenAI} from '@google/genai';
import {EXTRACTION_SCHEMA} from '../src/grounding.js';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
// Model actually used: MODEL, or the best available Pro model if MODEL is not offered to this key.
let activeModel = MODEL;
export const currentModel = () => activeModel;

export const INSTRUCTIONS = `You read engineering drawing sheets (lighting, civil and electrical) for Plasgain's estimating team.
List every potentially supplyable product or material shown on this ONE page: luminaires, poles, brackets, bollards, pits and lids, conduits, cables, pillars, switchboards, fittings, fixings and similar.

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
export async function extractPage({images, lines, page}) {
  const textLayer = (lines || []).map(line => line.text).filter(Boolean).join('\n').slice(0, 60000);
  const parts = [];
  for (const image of images) {
    parts.push({text: image.label});
    parts.push({inlineData: {mimeType: image.mimeType, data: image.data}, mediaResolution: {level: 'MEDIA_RESOLUTION_HIGH'}});
  }
  parts.push({text: `Page ${page.number} of "${page.file}". The first image is the whole sheet; the others are enlarged quarters of the same sheet for reading fine print.` +
    (textLayer ? `\n\nText found in the PDF's text layer (use it to read fine print exactly; it has no layout):\n${textLayer}` :
      '\n\nThis page has no PDF text layer, so read everything from the images.') +
    '\n\nList the supplyable items on this page following the rules.'});

  const request = model => genai().models.generateContent({
    model,
    contents: [{role: 'user', parts}],
    config: {
      systemInstruction: INSTRUCTIONS,
      responseMimeType: 'application/json',
      responseJsonSchema: EXTRACTION_SCHEMA,
      thinkingConfig: {thinkingLevel: 'HIGH'},
    },
  });
  let response;
  try {
    response = await request(activeModel);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const fallback = await bestAvailableModel(activeModel);
    if (!fallback) throw error;
    console.warn('Gemini model ' + activeModel + ' is not available to this key; using ' + fallback);
    activeModel = fallback;
    response = await request(activeModel);
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

async function bestAvailableModel(missing) {
  const names = [];
  const pager = await genai().models.list({config: {pageSize: 100}});
  for await (const model of pager) {
    if (!model.supportedActions || model.supportedActions.includes('generateContent')) names.push(String(model.name).replace(/^models\//, ''));
  }
  return rankModels(names).find(name => name !== missing) || null;
}
