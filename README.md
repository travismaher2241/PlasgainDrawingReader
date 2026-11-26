# Plasgain Drawing Takeoff

Internal drawing-to-quote takeoff tool for Plasgain's sales and estimating team.
Upload a PDF drawing set, choose the sheets to read, check every line against
the drawing in a split-screen workspace, and export a quote-ready list with page
references.

## Running it

Use Node.js 22 or later.

```sh
npm ci
cp .env.example .env      # then add your Gemini API key
npm start                 # builds the app and serves it on http://127.0.0.1:8787
```

For development, run `npm run server` and `npm run dev` in two terminals. Vite
forwards `/api` to the server. Run `npm test` for the rule, grounding and server
tests.

To use the AI reader, set `GEMINI_API_KEY` in `.env`. The key stays on the
server and is never sent to the browser. Without a key the app still works in
**text-only mode**. It reads written quantities and schedule tables from
searchable PDFs, but it cannot count symbols or read scanned sheets.

Set `APP_PASSCODE` to require a shared passcode for everything except the
health check. The browser asks for it once and remembers it.

## Shared storage (Firestore)

The Item List, saved aliases, exclusion rules and correction log are shared by
the whole team in Firestore. Give the server a Firebase service account in
one of two ways:

- `FIREBASE_SERVICE_ACCOUNT`: the whole service-account JSON on one line, or
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.

The collections are `takeoff_library`, `takeoff_item_chunks`,
`takeoff_aliases` and `takeoff_corrections`. Change the `takeoff` prefix with
`FIRESTORE_PREFIX`. Large Item Lists are split into 400-row documents to stay
under Firestore's 1 MB document limit. Without Firebase credentials, the server
stores the library in `data/library.json`, which is fine for local use.

## Item List from Ostendo

The uploaded Item List is the main source. Replacing it from Ostendo is off
by default: the library panel shows **Sync from Ostendo** only when the server
has `OSTENDO_ITEM_SYNC=on` as well as `OSTENDO_API_URL` and `OSTENDO_API_KEY`
(the same values as WeeklyFollowUp).
The sync follows the Ostendo handover guide: server only, read-only
`GET /tabledata`, `https` to `plasgain.southeastit.com.au:8843` only, a
45-second timeout, no redirects, and the key scrubbed from every message.

- It reads `ITEMMASTER` (change with `OSTENDO_ITEM_TABLE`). Set
  `OSTENDO_ITEM_CONDITION`, for example `ITEMSTATUS='Active'`, to read fewer rows.
- Columns are mapped as `ITEMCODE` → sku, `ITEMDESCRIPTION` → description,
  `ITEMSTATUS` → status, `ITEMCATEGORY`/`ITEMSUBCATEGORY` → category and
  `STOCKUNIT` → unit (see `OSTENDO_COLUMNS` in `server/ostendo.js`). Override a
  field with `OSTENDO_COLUMN_<FIELD>`, for example `OSTENDO_COLUMN_UNIT=SELLUNIT`.
  With no status column, an `INACTIVE` or `OBSOLETE` flag is used instead.
- Only Active items are kept. Drawing aliases, competitor codes, accessories,
  exclusion notes and pack sizes are not in Ostendo, so they carry over by SKU
  from the previous Item List.
- `GET /api/ostendo/item-columns` lists the table's column names, how full each
  is, and the status values, without returning any item rows. Use it to check
  the mapping.

## Hosting on Vercel

The repo deploys to Vercel as is. `vercel.json` builds the Vite app into
`dist/`, and `api/index.js` serves every `/api/*` route as one function, with
up to 300 seconds per page read. Under **Settings → Environment Variables**,
add `GEMINI_API_KEY`, `APP_PASSCODE`, the Firebase variables and the Ostendo variables above, then
redeploy. You can also set `GEMINI_MODEL`.

Vercel limits a request body to about 4.5 MB, so the browser lowers the image
resolution step by step until each page fits.

## How a takeoff works

1. **Upload drawings.** Each PDF page becomes a sheet card. The title block's
   project, drawing number, revision and status are filled in where visible,
   and you can edit them. Cover, register and general-notes sheets are
   deselected automatically, and you can tick them back on.
2. **Read selected pages.** With the AI reader on, each page is sent to Gemini
   as the whole sheet plus four enlarged quarters, along with the PDF's own
   text. Gemini only *extracts*: description, exact source wording, location,
   count method (`schedule`, `callout`, `counted`, `unspecified`), quantity or
   length, and any uncertainty. It is never asked for Plasgain part numbers.
3. **Legend symbol counts.** On vector (CAD) PDFs, the app finds lighting
   legend lines such as *14W LED ... LANTERN / ON A 5.5m ... POLE*, takes the
   symbol drawn beside each one, and counts every copy of that shape on the
   plan, in any rotation or mirror image (`src/symbols.js`). Each legend line
   gives a luminaire row and a pole row with the count, and clicking the row
   marks every symbol found on the sheet. A sheet without its own legend uses
   the legend from another sheet of the same PDF. These counts replace the
   reader's own guesses at lights and poles on that sheet, though a written
   schedule still wins. Scanned sheets have no vector paths, so they still rely
   on the AI reader.
4. **Grounding check.** The server checks each AI item against the page.
   Items with no source wording are dropped. Wording that isn't in the PDF
   text, or a total that differs from the written quantity, lowers the
   confidence and says why. Located wording gives the exact marker position.
5. **Matching.** Code, not the AI, matches each item against the **active**
   Item List using part numbers, drawing aliases, competitor codes, saved
   correction aliases, descriptions and normalised specifications (sizes in
   mm, W, A, V, kN, K, IP rating, load class, material). A SKU is assigned only
   when type and specs line up with one entry. A spec that conflicts with an
   entry rules it out. When a missing spec leaves several options, the SKU
   stays blank and the candidates are listed with the deciding detail. "Or
   equivalent" wording is matched but flagged. Drawing and Item List wording
   are linked by built-in synonyms (pole = column, mounting height = MH,
   galvanized = Gal, aero = Aeroscreen, luminaire = lantern, StreetLED3 =
   StreetLED), lamp wattage agrees within 10% (a 14W lantern is a 13.7 W
   item), and words the Item List never uses, such as a maker's name, are
   ignored and named in the reason. Non-supply work (trenching,
   concrete, labour and so on) and exclusion rules are excluded.
6. **Quantity rules.**
   - Counts take the most reliable source: `schedule > callout > counted > unspecified`.
     Lower-ranked entries for the same item are marked *Potential Duplicate
     (Excluded from Total)*.
   - Differing counts are never averaged. Both are shown, flagged and set to Low.
   - Multipliers (`3x`, `x4`, `3 x 2`) keep the note and the total.
   - Linear runs are compared in metres and listed separately. They are summed
     only when the SKU and unit match. `As required` and `TBA` lengths stay
     unspecified, and runs are never measured from the drawing scale.
   - The same item on several plan sheets is flagged to confirm separate areas
     or overlapping key plans. Items in typical details or sections are flagged
     and kept out of totals. Older revisions of the same drawing number in the
     upload are flagged as superseded and excluded.
   - Pack SKUs show both the drawing count and the packs to quote. Linked
     accessories show as optional add-ons to check.
7. **Review.** Rows are colour-coded High, Medium or Low/Unmatched. Clicking a
   row's page reference shows the sheet with a marker (dashed when the location
   is approximate). You can edit the description, quantity and unit, pick a
   SKU by typeahead or candidate chip, add or remove rows, override an
   automatic exclusion, and tick Verified.
8. **Learning loop.** Choosing a different SKU logs the correction and saves
   the drawing wording as an alias for future matching. Aliases, exclusion rules
   and the correction log are under *Item List, aliases & exclusion rules* and
   are shared by everyone using the server.
9. **Export.** *Export quote CSV* combines verified rows into one line per SKU,
   with the project, drawing numbers, revisions and status at the top, plus
   page references, source wording, pack quantities and add-ons. *Export full
   takeoff CSV* gives every row with its status, reasons and flags.

## Label schedule cross-check

AusNet-style sheets have a LABEL SCHEDULE table (ASSET | LABEL | TYPE) with a
row for each public lighting pole (`P/L POLE`). After counting legend symbols,
the reader counts those rows on the same sheet:

- When they agree, the light rows say so.
- When they differ, every light and pole row on that sheet gets a *Count
  conflict with label schedule* flag giving both numbers, and any schedule
  label (for example `PO 2602516195`) that isn't written on the plan. A small
  gap is usually a drawing error; a large one usually means missed symbols.
- When no symbols are counted but the schedule lists poles, a low-confidence
  `P/L POLE` row is added with the schedule's count so the poles aren't lost.

## Marked-up drawings

After a reading, the source drawing viewer marks every counted light with a
numbered marker, one colour and shape per light type (the same on every
sheet). Each `BID PO` pole label is circled and paired one-to-one with the
nearest light: green with a tick when paired, dashed red with a question mark
when no light is near it. A key above the drawing gives the count of each
light and its pole, the pole label tally and the label schedule check.
**Download marked-up PNG** saves the current sheet at full size with the key
in a band above it.

## Item List format

Upload CSV or Excel (`.xlsx`). Title rows above the headings are skipped.
Headings are case-insensitive, and common alternatives are accepted (for example
`Part Number` or `Item Code` for `sku`). See `ITEM_LIST_COLUMNS` in
`src/takeoff.js`.

| Column | Required | Notes |
| --- | --- | --- |
| `sku` | yes | Plasgain part number |
| `description` | yes | Include sizes, ratings and material, which matching relies on |
| `status` | | Only `Active` rows are used. With no status column every row counts as active |
| `category`, `subcategory`, `specifications` | | Extra words and specs for matching (`ITEMCATEGORY` and `ITEMSUBCATEGORY` are accepted) |
| `unit`, `pack_size`, `pack_unit` | | Pack quantity is calculated when `pack_size` > 1 |
| `drawing_aliases` | | Drawing wording, shorthand and DNSP codes for this item, separated by `|` or `;` (for example `70W AERO STREETLED`) |
| `competitor_equivalents` | | Third-party and legacy codes |
| `required_accessories` | | SKUs shown as optional add-ons |
| `exclusion_notes` | | Phrases that mark a drawing item as excluded |

## Code map

- `src/takeoff.js`: matching, quantity, duplicate, revision, pack and export rules (pure functions)
- `src/symbols.js`: legend symbol extraction and counting from PDF vector paths
- `src/grounding.js`: AI output schema and the checks applied to it
- `src/app.js`: browser app (pdf.js viewer, page picker, review workspace)
- `server/ostendo.js`: read-only Ostendo client and Item List mapping
- `server/index.js`: API and static server; `server/gemini.js` is the AI reader; `server/store.js` is the shared library (Firestore or a local file)
- `api/index.js` and `vercel.json`: Vercel entry point and build settings
- `scripts/make-sample-drawings.mjs`: regenerates the sample PDF (needs Playwright)
