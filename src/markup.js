// Draws the takeoff markup onto a rendered drawing page: a numbered marker for
// each counted light, one colour and shape per light type, a tag on each pole
// label ("BID PO ...") ticked off against its light, and a key. Used for the
// on-screen viewer and for the downloadable marked-up PNG.

export const MARK_STYLES = [
  {colour: '#d1241f', shape: 'circle'},
  {colour: '#1f4fd1', shape: 'square'},
  {colour: '#0f8a3c', shape: 'diamond'},
  {colour: '#b5179e', shape: 'triangle'},
  {colour: '#c25e00', shape: 'circle'},
  {colour: '#00838f', shape: 'square'},
];
const LABEL_OK = '#0f8a3c';
const LABEL_MISSING = '#d1241f';

function shapePath(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.2, y); ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r * 1.2, y); ctx.closePath(); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.15, y + r * 0.8); ctx.lineTo(x - r * 1.15, y + r * 0.8); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

export function drawSymbol(ctx, style, x, y, r) {
  shapePath(ctx, style.shape, x, y, r);
  ctx.fillStyle = style.colour + '33';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 4);
  ctx.strokeStyle = style.colour;
  ctx.stroke();
}

function tag(ctx, text, x, y, size, colour) {
  ctx.font = '700 ' + size + 'px system-ui, sans-serif';
  const w = ctx.measureText(text).width + size * 0.6, h = size * 1.35;
  ctx.fillStyle = colour;
  ctx.fillRect(x, y - h / 2, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + size * 0.3, y + size * 0.05);
}

// groups: [{style, name, pole, points: [[x, y]] in PDF units}]
// labels: [{label, x, y, size, point}] from pairLabels
export function drawMarkup(ctx, viewport, {groups = [], labels = []}) {
  const r = 7 + 7 * viewport.scale;
  const font = Math.round(r * 1.05);
  const at = ([x, y]) => viewport.convertToViewportPoint(x, y);
  // Pole labels first, under the light markers.
  for (const label of labels) {
    const [x, y] = at([label.x, label.y]);
    const half = Math.max(r * 1.6, (label.size || 10) * viewport.scale * 1.4);
    ctx.lineWidth = Math.max(2, r / 4);
    ctx.strokeStyle = label.point ? LABEL_OK : LABEL_MISSING;
    ctx.setLineDash(label.point ? [] : [r * 0.6, r * 0.4]);
    ctx.beginPath();
    ctx.arc(x, y, half, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label.point) {
      const [px, py] = at(label.point);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(px, py);
      ctx.lineWidth = Math.max(1.5, r / 6);
      ctx.stroke();
      tag(ctx, '✓', x + half * 0.7, y - half * 0.7, font * 0.9, LABEL_OK);
    } else {
      tag(ctx, '?', x + half * 0.7, y - half * 0.7, font * 0.9, LABEL_MISSING);
    }
  }
  for (const group of groups) {
    const placed = group.points.map(at).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    placed.forEach(([x, y], index) => {
      drawSymbol(ctx, group.style, x, y, r);
      tag(ctx, String(index + 1), x + r * 1.1, y - r * 1.1, font, group.style.colour);
    });
  }
}

function keyLines({groups = [], labels = [], schedule}) {
  const lines = [];
  for (const group of groups) {
    lines.push({style: group.style, text: group.points.length + ' × ' + group.name + (group.pole ? ' on ' + group.pole : '')});
  }
  if (labels.length) {
    const paired = labels.filter(label => label.point).length;
    lines.push({label: LABEL_OK, text: 'Pole labels (BID PO): ' + labels.length + ', ' + paired + ' ticked off against a light'});
    if (paired < labels.length) lines.push({label: LABEL_MISSING, dashed: true, text: (labels.length - paired) + ' pole label' + (labels.length - paired > 1 ? 's have' : ' has') + ' no light symbol nearby'});
  }
  if (schedule?.poles) {
    const counted = groups.reduce((sum, group) => sum + group.points.length, 0);
    lines.push({text: 'Label schedule: ' + schedule.poles + ' P/L poles listed, ' + counted + ' light symbols counted' +
      (schedule.poles === counted ? ' (agree)' : ' (DIFFERENT, check)'), warn: schedule.poles !== counted});
    if (schedule.missing?.length) lines.push({text: 'In schedule but not on plan: ' + schedule.missing.join(', '), warn: true});
  }
  if (!lines.length) lines.push({text: 'No counted lights on this sheet'});
  return lines;
}

// Size of the key box in pixels, so a band can be left for it.
export function keySize(ctx, markup, scale = 1) {
  const size = Math.round(15 * scale);
  const lines = keyLines(markup);
  ctx.font = '700 ' + Math.round(size * 1.15) + 'px system-ui, sans-serif';
  const titleWidth = ctx.measureText(markup.title).width;
  ctx.font = size + 'px system-ui, sans-serif';
  return {width: Math.ceil(Math.max(titleWidth, ...lines.map(line => ctx.measureText(line.text).width)) + size * 4),
    height: Math.ceil(size * 1.7 * (lines.length + 1) + size), margin: size};
}

// The key: a white box with one line per light type, the pole label tally
// and the label schedule check, drawn with its top left corner at (x0, y0).
export function drawKey(ctx, markup, scale = 1, x0 = Math.round(15 * scale), y0 = Math.round(15 * scale)) {
  const {title} = markup;
  const size = Math.round(15 * scale);
  const lines = keyLines(markup);
  const {width, height} = keySize(ctx, markup, scale);
  const rowHeight = size * 1.7;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fillRect(x0, y0, width, height);
  ctx.strokeStyle = '#14263b';
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(x0, y0, width, height);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#14263b';
  ctx.font = '700 ' + Math.round(size * 1.15) + 'px system-ui, sans-serif';
  ctx.fillText(title, x0 + size * 0.8, y0 + rowHeight * 0.6);
  lines.forEach((line, index) => {
    const y = y0 + rowHeight * (index + 1.6);
    const iconX = x0 + size * 1.5;
    if (line.style) drawSymbol(ctx, line.style, iconX, y, size * 0.45);
    else if (line.label) {
      ctx.beginPath();
      ctx.setLineDash(line.dashed ? [size * 0.25, size * 0.2] : []);
      ctx.arc(iconX, y, size * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = line.label;
      ctx.lineWidth = Math.max(1.5, scale * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = size + 'px system-ui, sans-serif';
    ctx.fillStyle = line.warn ? LABEL_MISSING : '#14263b';
    ctx.fillText(line.text, x0 + size * 2.6, y);
  });
}
