// Tells a CAD sheet (drawn with vector lines the app can measure) from a
// scanned or image-only sheet (one picture of the drawing, which only the AI
// reader or the estimator can read), from the page's pdf.js operator list.

const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

// A real drawing has thousands of path segments; a scan has a few (borders,
// a stamp) at most.
const MANY_SEGMENTS = 300;

// Returns {kind: 'cad' | 'scanned' | 'mixed' | 'blank', segments, imageCover}.
// `segments` counts drawn path segments; `imageCover` is the share of the page
// covered by pictures (0..1). `view` is the page box [x0, y0, x1, y1].
export function pageKind(operatorList, OPS, view, textItems = 0) {
  const {fnArray, argsArray} = operatorList;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let segments = 0, imageArea = 0;
  const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter(op => op !== undefined));
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = multiply(ctm, Array.from(args[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (images.has(fn)) imageArea += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]); // the unit square, mapped to the page
    else if (fn === OPS.constructPath) segments += pathSegments(args);
  }
  const pageArea = Math.abs((view[2] - view[0]) * (view[3] - view[1])) || 1;
  const imageCover = Math.min(1, imageArea / pageArea);
  let kind = 'cad';
  if (imageCover >= 0.4) kind = segments >= MANY_SEGMENTS ? 'mixed' : 'scanned';
  else if (segments < MANY_SEGMENTS) kind = textItems > 0 || segments > 0 ? 'cad' : 'blank';
  return {kind, segments, imageCover};
}

// Segments in one constructPath: pdf.js packs path commands as numbers
// (0 move, 1 line, 2 cubic, 3 quadratic, 4 close) followed by coordinates.
function pathSegments(args) {
  const data = args?.[1]?.[0];
  if (data && typeof data.length === 'number') {
    let count = 0;
    for (let j = 0; j < data.length;) {
      const op = data[j++];
      if (op === 0 || op === 1) { j += 2; if (op === 1) count++; }
      else if (op === 2) { j += 6; count++; }
      else if (op === 3) { j += 4; count++; }
      else if (op === 4) continue;
      else break;
    }
    return count;
  }
  // Older pdf.js: [ops, coordinates]. Count the drawing commands.
  return Array.isArray(args?.[0]) ? args[0].length : 0;
}

export const KIND_LABELS = {
  cad: {badge: 'CAD', note: 'Vector drawing: symbols counted and trench measured from the linework.'},
  mixed: {badge: 'CAD + image', note: 'Vector drawing with a large picture on it: anything inside the picture is read by the AI only.'},
  scanned: {badge: 'Scanned', note: 'Image only: nothing can be measured from linework. The AI reads it; check its counts, or use Count a symbol in the viewer.'},
  blank: {badge: 'Blank', note: 'No drawing or text found on this page.'},
};
