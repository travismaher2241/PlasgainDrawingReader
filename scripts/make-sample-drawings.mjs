// Builds samples/sample-drawing-set.pdf: a small searchable drawing set for
// trying the app and for the end-to-end check. Run: node scripts/make-sample-drawings.mjs
import {chromium} from 'playwright';

const titleBlock = (number, revision, status, title) => `
  <div class="tb"><div>PROJECT: Smith Street Lighting Upgrade</div><div>${title}</div>
  <div>DRAWING No. ${number}</div><div>REV ${revision}</div><div class="status">${status}</div></div>`;

const sheet = body => `<section class="sheet">${body}</section>`;
const schedule = rows => `<table class="schedule"><caption>LUMINAIRE SCHEDULE</caption>
  <tr><th class="c1">TYPE</th><th class="c2">DESCRIPTION</th><th class="c3">QTY</th></tr>
  ${rows.map(([type, description, qty]) => `<tr><td class="c1">${type}</td><td class="c2">${description}</td><td class="c3">${qty}</td></tr>`).join('')}</table>`;

const html = `<!doctype html><html><head><style>
  @page { size: A3 landscape; margin: 0; }
  body { margin: 0; font: 11px Arial, sans-serif; }
  .sheet { position: relative; width: 420mm; height: 297mm; page-break-after: always; overflow: hidden; }
  .sheet::before { content: ''; position: absolute; inset: 8mm; border: 1.5px solid #000; }
  .tb { position: absolute; right: 12mm; bottom: 12mm; width: 95mm; border: 1px solid #000; padding: 3mm; line-height: 1.7; }
  .status { font-weight: bold; }
  .schedule { position: absolute; right: 14mm; top: 14mm; border-collapse: collapse; }
  .schedule td, .schedule th { border: 1px solid #000; padding: 2px 8px; }
  .c1 { width: 14mm; } .c2 { width: 80mm; } .c3 { width: 14mm; }
  .note { position: absolute; }
  .cover h1 { position: absolute; left: 40mm; top: 60mm; font-size: 30px; }
  .lum { position: absolute; width: 5mm; height: 5mm; border-radius: 50%; border: 1px solid #000; }
</style></head><body>
${sheet(`<div class="cover"><h1>COVER SHEET</h1><p class="note" style="left:40mm;top:90mm">DRAWING REGISTER: E-101 Lighting Plan, E-102 Pits and Conduits. GENERAL NOTES apply to all sheets.</p></div>` +
  titleBlock('E-000', '1', 'FOR CONSTRUCTION', 'COVER SHEET'))}
${sheet(schedule([['L1', 'Steel pole 6.5m galvanised', '4'], ['L2', 'Bollard 1000mm aluminium 150W', '12']]) +
  `<p class="note" style="left:40mm;top:80mm">Steel pole 6.5m Qty 6</p>
   <p class="note" style="left:40mm;top:100mm">Conduit 25mm PVC length 6500 mm</p>
   <p class="note" style="left:40mm;top:120mm">Trenching Qty 25</p>
   <p class="note" style="left:150mm;top:200mm">TYPICAL DETAIL: Bollard 1000mm aluminium 150W Qty 1</p>` +
  titleBlock('E-101', 'A', 'TENDER', 'LIGHTING PLAN'))}
${sheet(`<p class="note" style="left:40mm;top:60mm">4 off Pit 300 x 300 polymer Class B</p>
   <p class="note" style="left:40mm;top:80mm">Conduit 25mm PVC length 12 m</p>
   <p class="note" style="left:40mm;top:100mm">Conduit 25mm PVC length TBA</p>
   <p class="note" style="left:40mm;top:120mm">Cable tie 300mm Qty 250</p>
   <p class="note" style="left:40mm;top:140mm">Street light pole Qty 2</p>` +
  titleBlock('E-102', '1', 'FOR CONSTRUCTION', 'PITS AND CONDUITS'))}
${sheet(schedule([['L1', 'Steel pole 6.5m galvanised', '5'], ['L2', 'Bollard 1000mm aluminium 150W', '12']]) +
  titleBlock('E-101', 'B', 'FOR CONSTRUCTION', 'LIGHTING PLAN'))}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
await page.pdf({path: new URL('../samples/sample-drawing-set.pdf', import.meta.url).pathname, preferCSSPageSize: true, printBackground: true});
await browser.close();
console.log('Wrote samples/sample-drawing-set.pdf');
