import test from 'node:test';
import assert from 'node:assert/strict';
import {pageKind} from '../src/pagekind.js';

const OPS = {save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, constructPath: 91};
const view = [0, 0, 1000, 700];
const line = () => [OPS.constructPath, [0, [Float32Array.from([0, 0, 0, 1, 10, 10])], null]];
const list = ops => ({fnArray: ops.map(op => op[0]), argsArray: ops.map(op => op[1])});

test('a sheet of linework is CAD', () => {
  const result = pageKind(list(Array.from({length: 400}, line)), OPS, view, 50);
  assert.equal(result.kind, 'cad');
  assert.equal(result.segments, 400);
  assert.equal(result.imageCover, 0);
});

test('a page-size picture with no linework is scanned', () => {
  const result = pageKind(list([[OPS.save], [OPS.transform, [1000, 0, 0, 700, 0, 0]], [OPS.paintImageXObject, ['img1', 4000, 2800]], [OPS.restore], line()]), OPS, view);
  assert.equal(result.kind, 'scanned');
  assert.ok(result.imageCover > 0.99);
});

test('a picture inside a form is measured with the form matrix', () => {
  const result = pageKind(list([[OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], [0, 0, 1, 1]]], [OPS.transform, [500, 0, 0, 350, 0, 0]],
    [OPS.paintImageXObject, ['img1']], [OPS.paintFormXObjectEnd]]), OPS, view);
  assert.equal(result.kind, 'scanned');
});

test('linework drawn over a large picture is mixed; a small logo stays CAD', () => {
  const lines = Array.from({length: 400}, line);
  assert.equal(pageKind(list([[OPS.transform, [1000, 0, 0, 700, 0, 0]], [OPS.paintImageXObject, ['img']], ...lines]), OPS, view).kind, 'mixed');
  assert.equal(pageKind(list([[OPS.save], [OPS.transform, [100, 0, 0, 40, 0, 0]], [OPS.paintImageXObject, ['logo']], [OPS.restore], ...lines]), OPS, view).kind, 'cad');
});

test('an empty page is blank', () => {
  assert.equal(pageKind(list([]), OPS, view, 0).kind, 'blank');
});
