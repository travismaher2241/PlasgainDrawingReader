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

## Hosting on Vercel

The repo deploys to Vercel as is. `vercel.json` builds the Vite app into
`dist/`, and `api/index.js` serves every `/api/*` route as one function, with
up to 300 seconds per page read. Under **Settings → Environment Variables**,
add `GEMINI_API_KEY`, `APP_PASSCODE` and the Firebase variables above, then
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
3. **Grounding check.** The server checks each AI item against the page.
   Items with no source wording are dropped. Wording that isn't in the PDF
   text, or a total that differs from the written quantity, lowers the
   confidence and says why. Located wording gives the exact marker position.
4. **Matching.** Code, not the AI, matches each item against the **active**
   Item List using part numbers, drawing aliases, competitor codes, saved
   correction aliases, descriptions and normalised specifications (sizes in
   mm, W, A, V, kN, K, IP rating, load class, material). A SKU is assigned only
   when type and specs line up with one entry. A spec that conflicts with an
   entry rules it out. When a missing spec leaves several options, the SKU
   stays blank and the candidates are listed with the deciding detail. "Or
   equivalent" wording is matched but flagged. Non-supply work (trenching,
   concrete, labour and so on) and exclusion rules are excluded.
5. **Quantity rules.**
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
6. **Review.** Rows are colour-coded High, Medium or Low/Unmatched. Clicking a
   row's page reference shows the sheet with a marker (dashed when the location
   is approximate). You can edit the description, quantity and unit, pick a
   SKU by typeahead or candidate chip, add or remove rows, override an
   automatic exclusion, and tick Verified.
7. **Learning loop.** Choosing a different SKU logs the correction and saves
   the drawing wording as an alias for future matching. Aliases, exclusion rules
   and the correction log are under *Item List, aliases & exclusion rules* and
   are shared by everyone using the server.
8. **Export.** *Export quote CSV* combines verified rows into one line per SKU,
   with the project, drawing numbers, revisions and status at the top, plus
   page references, source wording, pack quantities and add-ons. *Export full
   takeoff CSV* gives every row with its status, reasons and flags.

## Item List format

Upload CSV or Excel (`.xlsx`). Title rows above the headings are skipped.
Headings are case-insensitive, and common alternatives are accepted (for example
`Part Number` or `Item Code` for `sku`). See `ITEM_LIST_COLUMNS` in
`src/takeoff.js`.

| Column | Required | Notes |
| --- | --- | --- |
| `sku` | yes | Plasgain part number |
| `description` | yes | Include sizes, ratings and material, which matching relies on |
| `status` | yes | Only `Active` rows are used |
| `category`, `specifications` | | Extra words and specs for matching |
| `unit`, `pack_size`, `pack_unit` | | Pack quantity is calculated when `pack_size` > 1 |
| `drawing_aliases` | | Drawing shorthand and DNSP codes, separated by `|` or `;` |
| `competitor_equivalents` | | Third-party and legacy codes |
| `required_accessories` | | SKUs shown as optional add-ons |
| `exclusion_notes` | | Phrases that mark a drawing item as excluded |

## Code map

- `src/takeoff.js`: matching, quantity, duplicate, revision, pack and export rules (pure functions)
- `src/grounding.js`: AI output schema and the checks applied to it
- `src/app.js`: browser app (pdf.js viewer, page picker, review workspace)
- `server/index.js`: API and static server; `server/gemini.js` is the AI reader; `server/store.js` is the shared library (Firestore or a local file)
- `api/index.js` and `vercel.json`: Vercel entry point and build settings
- `scripts/make-sample-drawings.mjs`: regenerates the sample PDF (needs Playwright)
