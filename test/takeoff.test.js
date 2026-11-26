import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareRevision, extractRows, extractScheduleRows, matchItem, packs, parseQuantity, parseSpecs, parseTitleBlock,
  quoteCsv, quoteLines, readCatalogue, reconcile,
} from '../src/takeoff.js';

const CATALOGUE = readCatalogue([
  'Part Number,Description,Status,Category,Pack Size,Pack Unit,Drawing Aliases,Competitor Equivalents,Required Accessories,Exclusion Notes',
  'P1,"Steel pole, 6500mm",Active,Pole,,,LP1,,,',
  'P2,Steel pole,Discontinued,Pole,,,LP2,,,',
  'P3,Steel pole 5500 mm,Active,Pole,,,,,,',
  'B1,Bollard 1000mm aluminium 150W,Active,Bollard,,,,ACME-BL1,P-BASE,',
  'C25,Conduit 25mm PVC,Active,Conduit,4,m,,,,',
  'S10,Cable tie 300mm,Active,Accessory,100,ea,,,,',
  'P-BASE,Bollard base plate,Active,Accessory,,,,,,',
  'PIT1,Pit 300 x 300 polymer Class B,Active,Pit,,,,,,existing pits to remain',
].join('\r\n'));

test('Item List: heading synonyms, active only, no duplicates', () => {
  assert.deepEqual(CATALOGUE.map(item => item.sku), ['P1', 'P3', 'B1', 'C25', 'S10', 'P-BASE', 'PIT1']);
  // No status column: every row is taken as active.
  assert.deepEqual(readCatalogue('Item Code,Description,ITEMCATEGORY,ITEMSUBCATEGORY\r\nA,B,LIGHTING,LANTERNS').map(item => [item.sku, item.status, item.category, item.subcategory]),
    [['A', 'Active', 'LIGHTING', 'LANTERNS']]);
  assert.throws(() => readCatalogue('code\r\nA'), /Missing Item List column: description/);
  assert.throws(() => readCatalogue('sku,description,status\r\nA,x,Active\r\na,y,Active'), /duplicate active SKUs/);
});

test('matching: exact description, aliases, discontinued codes never returned', () => {
  assert.equal(matchItem('Steel pole, 6.5 m', CATALOGUE).sku, 'P1');
  assert.equal(matchItem('LP1', CATALOGUE).sku, 'P1');
  assert.equal(matchItem('Light pole type LP1', CATALOGUE).sku, 'P1');
  assert.equal(matchItem('LP2', CATALOGUE).sku, '');
  assert.equal(matchItem('ACME-BL1', CATALOGUE).confidence, 'High');
  assert.equal(matchItem('street light', CATALOGUE, {'street light': 'P3'}).sku, 'P3');
});

test('matching: missing spec leaves SKU blank and names the deciding detail', () => {
  const result = matchItem('Steel pole', CATALOGUE);
  assert.equal(result.sku, '');
  assert.deepEqual(result.candidates.sort(), ['P1', 'P3']);
  assert.match(result.reason, /Missing size/);
});

test('matching: conflicting spec is never matched', () => {
  const result = matchItem('Steel pole 8m', CATALOGUE);
  assert.equal(result.sku, '');
  assert.equal(result.confidence, 'Low');
  assert.match(result.reason, /conflicting specs/);
  assert.equal(matchItem('Bollard 1000mm aluminium 100W', CATALOGUE).sku, '');
});

test('matching: type and specs align, typo and abbreviation tolerance, or-equivalent flagged', () => {
  const match = matchItem('Bollard alum 1.0m 150W', CATALOGUE);
  assert.equal(match.sku, 'B1');
  assert.equal(match.confidence, 'High');
  const equivalent = matchItem('Bollard 1000mm aluminium 150W or equivalent', CATALOGUE);
  assert.equal(equivalent.sku, 'B1');
  assert.equal(equivalent.confidence, 'Medium');
  assert.equal(matchItem('Condiut 25mm PVC', CATALOGUE).sku, 'C25');
  assert.equal(matchItem('pit', CATALOGUE).sku, '');
});

test('matching: prefers the entry whose own words are on the drawing; loose matches only as candidates', () => {
  const items = readCatalogue('sku,description,status\r\nPIT,Pit polymer 300 x 300 Class B,Active\r\nLID,Pit lid polymer 300 x 300 Class B,Active\r\nPOLE,Steel pole 6500mm,Active\r\nBASE,Pole base plate kit,Active');
  assert.equal(matchItem('Pit 300 x 300 polymer Class B', items).sku, 'PIT');
  const pole = matchItem('Steel pole 6.5m', items);
  assert.equal(pole.sku, 'POLE');
  assert.deepEqual(pole.candidates, []);
  const loose = matchItem('Street light pole', items);
  assert.equal(loose.sku, '');
  assert.ok(loose.candidates.includes('POLE'));
});

test('matching: non-supply work and exclusion notes are excluded', () => {
  assert.equal(matchItem('Trenching', CATALOGUE).excluded, true);
  assert.equal(matchItem('Concrete footing to pole', CATALOGUE).excluded, true);
  assert.equal(matchItem('Existing pits to remain', CATALOGUE).excluded, true);
});

test('quantities: multipliers, lengths, unspecified', () => {
  assert.deepEqual([parseQuantity('3x').quantity, parseQuantity('x4').quantity, parseQuantity('3 x 2').quantity], [3, 4, 6]);
  assert.equal(parseQuantity('6500 mm').quantity, 6.5);
  assert.equal(parseQuantity('6.5m').unit, 'm');
  assert.equal(parseQuantity('As required').unspecified, true);
  assert.equal(parseQuantity('TBA').quantity, null);
  assert.equal(parseQuantity('1,200mm').quantity, 1.2);
});

test('specs: metric normalisation and ratings', () => {
  assert.deepEqual(parseSpecs('6.5m pole').size, [6500]);
  assert.deepEqual(parseSpecs('Light 150W IP66 4000K').power, [150]);
  assert.deepEqual(parseSpecs('IP66')['ip rating'], ['66'].map(Number));
});

test('text extraction reads explicit quantities', () => {
  const rows = extractRows([
    {text: 'Schedule: Steel pole Qty 4', pageId: 0, point: [10, 20]},
    {text: 'Steel pole Qty 3 x 2', pageId: 1},
    {text: 'Conduit length 6500 mm', pageId: 1},
    {text: 'Conduit length TBA', pageId: 2},
    {text: '4 off Bollard 1000mm', pageId: 2},
  ]);
  assert.deepEqual(rows.map(row => row.quantity), [4, 6, 6.5, null, 4]);
  assert.deepEqual(rows[0].point, [10, 20]);
  assert.equal(rows[0].source, 'schedule');
  assert.equal(rows[2].unit, 'm');
  assert.equal(rows[3].source, 'unspecified');
});

test('schedule tables are read by column position', () => {
  const cells = (y, ...texts) => ({pageId: 0, point: [0, y], text: texts.map(t => t[1]).join(' '), cells: texts.map(([x, text]) => ({x, text, end: x + text.length * 5}))});
  const rows = extractScheduleRows([
    {...cells(500, [10, 'TYPE'], [60, 'DESCRIPTION'], [300, 'QTY']), cells: [{x: 10, end: 30, text: 'TYPE'}, {x: 120, end: 190, text: 'DESCRIPTION'}, {x: 296, end: 312, text: 'QTY'}]},
    cells(490, [10, 'L1'], [60, 'Steel pole 6.5m'], [302, '4']),
    cells(480, [10, 'L2'], [60, 'Bollard 1000mm'], [301, '12']),
    cells(380, [60, 'PROJECT: Smith St']),
  ]);
  assert.deepEqual(rows.map(row => [row.description, row.quantity, row.source]),
    [['L1 Steel pole 6.5m', 4, 'schedule'], ['L2 Bollard 1000mm', 12, 'schedule']]);
});

function rowsFor(entries, pages) {
  const rows = entries.map(entry => {
    const match = matchItem(entry.description, CATALOGUE);
    return {unit: 'ea', ...entry, sku: match.sku, matchConfidence: match.confidence, reason: match.reason, matchExcluded: !!match.excluded};
  });
  return reconcile(rows, pages);
}

const PAGES = [
  {id: 0, file: 'set.pdf', number: 1, meta: {drawingNumber: 'E-101', revision: 'A'}},
  {id: 1, file: 'set.pdf', number: 2, meta: {drawingNumber: 'E-102', revision: '1'}},
  {id: 2, file: 'set.pdf', number: 3, meta: {drawingNumber: 'E-103', revision: '1'}},
  {id: 3, file: 'set.pdf', number: 4, meta: {drawingNumber: 'E-103', revision: '2'}},
];

test('schedule takes priority over plan view and conflicts are not averaged', () => {
  const rows = rowsFor([
    {description: 'Steel pole 6.5m', quantity: 4, source: 'schedule', pageId: 0},
    {description: 'Steel pole 6.5m', quantity: 6, source: 'counted', pageId: 1},
  ], PAGES);
  assert.equal(rows[0].excluded, false);
  assert.equal(rows[1].excluded, true);
  assert.match(rows[1].flags.join(), /Potential Duplicate \(Excluded from Total\)/);
  assert.equal(rows[0].confidence, 'Low');
  assert.match(rows[0].flags.join(), /shows 6 vs 4/);
});

test('callout beats counted, repeated schedules count once, multi-sheet plans flagged', () => {
  const rows = rowsFor([
    {description: 'Bollard 1000mm aluminium 150W', quantity: 3, source: 'callout', pageId: 1},
    {description: 'Bollard 1000mm aluminium 150W', quantity: 3, source: 'counted', pageId: 1},
    {description: 'Steel pole 6.5m', quantity: 4, source: 'schedule', pageId: 0},
    {description: 'Steel pole 6.5m', quantity: 4, source: 'schedule', pageId: 1},
    {description: 'Steel pole 5500mm', quantity: 2, source: 'counted', pageId: 0},
    {description: 'Steel pole 5500mm', quantity: 5, source: 'counted', pageId: 1},
  ], PAGES);
  assert.deepEqual(rows.map(row => row.excluded), [false, true, false, true, false, false]);
  assert.match(rows[4].flags.join(), /overlapping key plans/);
  assert.equal(rows[4].confidence, 'Medium');
});

test('superseded revisions and typical details are excluded; linear runs listed and summed', () => {
  const rows = rowsFor([
    {description: 'Conduit 25mm PVC', quantity: 6.5, unit: 'm', source: 'callout', pageId: 2},
    {description: 'Conduit 25mm PVC', quantity: 12, unit: 'm', source: 'callout', pageId: 3},
    {description: 'Conduit 25mm PVC', quantity: 3, unit: 'm', source: 'callout', pageId: 1},
    {description: 'Bollard 1000mm aluminium 150W', quantity: 1, source: 'callout', pageId: 1, typical: true},
    {description: 'Steel pole 6.5m', quantity: null, source: 'unspecified', pageId: 1},
    {description: 'Conduit 25mm PVC', quantity: null, unit: 'm', source: 'unspecified', pageId: 3},
  ], PAGES);
  assert.equal(rows[5].excluded, false);
  assert.match(rows[5].flags.join(), /Length unspecified/);
  assert.equal(rows[0].excluded, true);
  assert.match(rows[0].flags.join(), /Superseded revision 1 of E-103, latest in this upload is 2/);
  assert.match(rows[1].flags.join(), /total 15 m/);
  assert.equal(rows[3].excluded, true);
  assert.match(rows[3].flags.join(), /typical detail/);
  assert.equal(rows[4].confidence, 'Low');
  assert.equal(compareRevision('1', 'C'), 1);
  assert.equal(compareRevision('P2', 'A') < 0, true);
});

test('user choice overrides automatic exclusion', () => {
  const rows = rowsFor([
    {description: 'Steel pole 6.5m', quantity: 4, source: 'schedule', pageId: 0},
    {description: 'Steel pole 6.5m', quantity: 4, source: 'counted', pageId: 1, userExcluded: false},
  ], PAGES);
  assert.equal(rows[1].autoExcluded, true);
  assert.equal(rows[1].excluded, false);
});

test('packs, quote lines and accessories', () => {
  const tie = CATALOGUE.find(item => item.sku === 'S10');
  assert.equal(packs(tie, {quantity: 250, unit: 'ea'}), 3);
  assert.equal(packs(CATALOGUE.find(item => item.sku === 'C25'), {quantity: 15, unit: 'm'}), 4);
  assert.equal(packs(tie, {quantity: 15, unit: 'm'}), '');
  const rows = [
    {sku: 'B1', quantity: 3, unit: 'ea', source: 'schedule', pageId: 0, verified: true, excluded: false, text: 'L2 Bollard'},
    {sku: 'B1', quantity: 2, unit: 'ea', source: 'callout', pageId: 1, verified: true, excluded: false, text: 'Bollard'},
    {sku: 'P1', quantity: 2, unit: 'ea', source: 'callout', pageId: 1, verified: false, excluded: false},
  ];
  const [line] = quoteLines(rows, CATALOGUE, PAGES);
  assert.equal(line.quantity, 5);
  assert.match(line.references, /E-101 rev A, set.pdf p1 \(schedule: 3\)/);
  assert.match(line.accessories, /P-BASE Bollard base plate/);
});

test('title block details', () => {
  const block = parseTitleBlock('PROJECT: Smith St Upgrade\nDRAWING No. E-101\nREV B\nISSUED FOR CONSTRUCTION');
  assert.deepEqual(block, {project: 'Smith St Upgrade', drawingNumber: 'E-101', revision: 'B', status: 'FOR CONSTRUCTION'});
  assert.equal(parseTitleBlock('NOT FOR CONSTRUCTION').status, 'NOT FOR CONSTRUCTION');
});

test('CSV export preserves quoted source wording and escapes spreadsheet formulas', () => {
  assert.equal(quoteCsv([['=1+2', 'Schedule "A"', 4]]), '"\'=1+2","Schedule ""A""","4"\r\n');
});

test('matching: drawing wording links to Item List wording', () => {
  const list = readCatalogue([
    'Item Code,Description,ITEMSUBCATEGORY,ITEMCATEGORY',
    'L13,StreetLED3 13.7w LED SCO with PE Cell,LANTERNS,PUBLIC LIGHTING',
    'L17,StreetLED3 17w LED SCO with PE Cell,LANTERNS,PUBLIC LIGHTING',
    'L13A,StreetLED3 13.7w LED Aeroscreen with PE Cell,LANTERNS,PUBLIC LIGHTING',
    'C9,Standard URD 9.0m MH (10.8/1Kn-5mm Base) Octagonal column c/w 1500mm curve Gal,COLUMN MINOR ROAD,PUBLIC LIGHTING',
    'C9D,Standard URD 9.0m MH (10.8/1Kn-5mm Base) Octagonal column c/w 1500mm curve Reversed Panel Door Gal,COLUMN MINOR ROAD,PUBLIC LIGHTING',
    'C5P,Powercor URD 5.5m MH (7.0/1Kn-5mm Base) Octagonal column c/w 500mm curve Gal,COLUMN MINOR ROAD,PUBLIC LIGHTING',
    'C5A,SP Ausnet URD 5.5m MH (7.0/1Kn-5mm Base) Octagonal column c/w 500mm curve Gal,COLUMN MINOR ROAD,PUBLIC LIGHTING',
  ].join('\r\n'));
  // 14W is the nominal rating of a 13.7 W lantern; the maker's name is not in the list.
  const lantern = matchItem('14W LED SCO SYLVANIA STREETLED LANTERN', list);
  assert.equal(lantern.sku, 'L13');
  assert.match(lantern.reason, /ignored: sylvania/);
  // Pole = column, mounting height = MH, galvanized = Gal; the plain column beats the one with extras.
  assert.equal(matchItem('9.0m MOUNTING HEIGHT GALVANIZED URD POLE', list).sku, 'C9');
  // Two network versions fit equally, so the choice is left to the estimator.
  const pole = matchItem('5.5m MOUNTING HEIGHT GALVANIZED URD POLE', list);
  assert.equal(pole.sku, '');
  assert.deepEqual(pole.candidates.sort(), ['C5A', 'C5P']);
});
