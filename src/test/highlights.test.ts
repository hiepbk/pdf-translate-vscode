import * as assert from 'assert';
import { applyHighlights, Highlight } from '../annotate/highlights';

/*
 * These build a real PDF, highlight it, and read the result back the way any
 * other reader would. The structure is what matters: a highlight with the
 * quads in the wrong order renders as a bow tie, and one that replaces a
 * page's existing annotations silently destroys the document's links.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');
/* eslint-enable @typescript-eslint/no-var-requires */

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([595, 842]);
  }
  return doc.save();
}

async function annotationsOf(
  bytes: Uint8Array,
  pageIndex = 0
): Promise<Array<Record<string, string>>> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    return [];
  }

  const result: Array<Record<string, string>> = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookup(i);
    const entry: Record<string, string> = {};
    ['Subtype', 'Rect', 'QuadPoints', 'C', 'F'].forEach((key) => {
      const value = dict.get(PDFName.of(key));
      if (value) {
        entry[key] = value.toString();
      }
    });
    result.push(entry);
  }
  return result;
}

const oneLine: Highlight = {
  page: 0,
  rects: [[72, 697, 340, 715]],
  color: '#ffd400',
  text: 'a highlighted phrase',
};

describe('applyHighlights', () => {
  it('returns the document untouched when there is nothing to add', async () => {
    const original = await blankPdf();
    const result = await applyHighlights(original, []);
    // Identity, not merely equality: nothing should be re-serialised.
    assert.strictEqual(result, original);
  });

  it('writes a Highlight annotation', async () => {
    const result = await applyHighlights(await blankPdf(), [oneLine]);
    const annots = await annotationsOf(result);
    assert.strictEqual(annots.length, 1);
    assert.strictEqual(annots[0].Subtype, '/Highlight');
  });

  it('orders quad points as readers actually expect', async () => {
    // The specification says counter-clockwise from the lower left, but every
    // real producer writes upper-left, upper-right, lower-left, lower-right,
    // and readers follow the producers. The other order draws a bow tie.
    const result = await applyHighlights(await blankPdf(), [oneLine]);
    const quads = (await annotationsOf(result))[0].QuadPoints;
    const numbers = (quads.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(
      numbers,
      [72, 715, 340, 715, 72, 697, 340, 697],
      'expected upper-left, upper-right, lower-left, lower-right'
    );
  });

  it('spans every line of a multi-line selection', async () => {
    const result = await applyHighlights(await blankPdf(), [
      {
        page: 0,
        rects: [
          [72, 697, 340, 715],
          [72, 677, 345, 695],
        ],
        color: '#ffd400',
      },
    ]);
    const annots = await annotationsOf(result);
    const numbers = (annots[0].QuadPoints.match(/[-\d.]+/g) || []).map(Number);
    // Eight numbers per quad, one quad per line.
    assert.strictEqual(numbers.length, 16);
    // And one annotation, not one per line: the two lines are one highlight.
    assert.strictEqual(annots.length, 1);
  });

  it('bounds the rectangle around every line', async () => {
    const result = await applyHighlights(await blankPdf(), [
      {
        page: 0,
        rects: [
          [72, 697, 340, 715],
          [72, 677, 345, 695],
        ],
        color: '#ffd400',
      },
    ]);
    const rect = (await annotationsOf(result))[0].Rect;
    const numbers = (rect.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(numbers, [72, 677, 345, 715]);
  });

  it('marks the annotation printable', async () => {
    // Without the Print flag the highlight is on screen but absent from
    // anything printed or exported.
    const result = await applyHighlights(await blankPdf(), [oneLine]);
    assert.strictEqual((await annotationsOf(result))[0].F, '4');
  });

  it('writes the colour as PDF components', async () => {
    const result = await applyHighlights(await blankPdf(), [
      { page: 0, rects: [[0, 0, 10, 10]], color: '#ff0000' },
    ]);
    const colour = (await annotationsOf(result))[0].C;
    const numbers = (colour.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(numbers, [1, 0, 0]);
  });

  it('falls back to yellow rather than losing an unreadable colour', async () => {
    const result = await applyHighlights(await blankPdf(), [
      { page: 0, rects: [[0, 0, 10, 10]], color: 'not-a-colour' },
    ]);
    const annots = await annotationsOf(result);
    assert.strictEqual(annots.length, 1, 'the highlight must survive');
    const numbers = (annots[0].C.match(/[-\d.]+/g) || []).map(Number);
    assert.strictEqual(numbers[0], 1);
    assert.ok(numbers[2] < 0.1, 'expected a yellow, not a grey or a white');
  });

  it('puts each highlight on its own page', async () => {
    const result = await applyHighlights(await blankPdf(3), [
      { page: 0, rects: [[0, 0, 10, 10]], color: '#ffd400' },
      { page: 2, rects: [[0, 0, 10, 10]], color: '#ffd400' },
    ]);
    assert.strictEqual((await annotationsOf(result, 0)).length, 1);
    assert.strictEqual((await annotationsOf(result, 1)).length, 0);
    assert.strictEqual((await annotationsOf(result, 2)).length, 1);
  });

  it('ignores a highlight for a page that does not exist', async () => {
    // Stale coordinates from a document that was reloaded should not throw and
    // lose the save along with them.
    const result = await applyHighlights(await blankPdf(1), [
      { page: 7, rects: [[0, 0, 10, 10]], color: '#ffd400' },
    ]);
    assert.strictEqual((await annotationsOf(result)).length, 0);
  });

  it('keeps annotations the page already had', async () => {
    // A paper is full of link annotations. Replacing /Annots instead of
    // appending to it would quietly strip every one of them.
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.node.set(
      PDFName.of('Annots'),
      doc.context.obj([
        doc.context.register(
          doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Link'),
            Rect: [0, 0, 10, 10],
          })
        ),
      ])
    );

    const result = await applyHighlights(await doc.save(), [oneLine]);
    const annots = await annotationsOf(result);
    const subtypes = annots.map((a) => a.Subtype).sort();
    assert.deepStrictEqual(subtypes, ['/Highlight', '/Link']);
  });

  it('adds highlights to a page that has none without disturbing others', async () => {
    const result = await applyHighlights(await blankPdf(2), [
      oneLine,
      { page: 0, rects: [[10, 10, 20, 20]], color: '#00ff00' },
    ]);
    assert.strictEqual((await annotationsOf(result, 0)).length, 2);
  });
});
