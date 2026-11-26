# Plasgain Drawing Takeoff

Use Node.js 24. From the existing checkout, run:

```sh
npm ci --cache /tmp/plasgain-npm-cache
npm test
npm run dev
```

Run `npm run build` to produce the static site in `dist/`.

Upload searchable PDFs, select the sheets to scan, and upload an Item List CSV.
The required headers are `sku`, `description`, and `status`. Only `Active`
records are used. Optional headers are `drawing_aliases`, `competitor_equivalents`,
`exclusion_notes`, `pack_size`, `pack_unit`, and `required_accessories`.
Separate aliases, equivalents, and exact exclusion terms with pipes or semicolons.
Pack units default to `ea`.

This first version reads explicit text lines such as `Schedule: Steel pole Qty 4`
and `Conduit length 6500 mm`. Verify against the source, add missing rows manually,
and export checked rows with active SKUs and positive quantities. Saved aliases
are stored in the current browser. Drawings and Item Lists are processed locally.

Image-only OCR, visual symbol counting, general schedule-table parsing, title-block
metadata, revision handling, and shared alias storage still need implementation.
