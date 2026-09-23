import * as assert from 'assert';
import { applyEdits, Highlight } from '../annotate/edits';

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

describe('applying highlights', () => {
  it('returns the document untouched when there is nothing to add', async () => {
    const original = await blankPdf();
    const result = await applyEdits(original, { highlights: [] });
    // Identity, not merely equality: nothing should be re-serialised.
    assert.strictEqual(result, original);
  });

  it('writes a Highlight annotation', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    const annots = await annotationsOf(result);
    assert.strictEqual(annots.length, 1);
    assert.strictEqual(annots[0].Subtype, '/Highlight');
  });

  it('orders quad points as readers actually expect', async () => {
    // The specification says counter-clockwise from the lower left, but every
    // real producer writes upper-left, upper-right, lower-left, lower-right,
    // and readers follow the producers. The other order draws a bow tie.
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    const quads = (await annotationsOf(result))[0].QuadPoints;
    const numbers = (quads.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(
      numbers,
      [72, 715, 340, 715, 72, 697, 340, 697],
      'expected upper-left, upper-right, lower-left, lower-right'
    );
  });

  it('spans every line of a multi-line selection', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [
        {
          page: 0,
          rects: [
            [72, 697, 340, 715],
            [72, 677, 345, 695],
          ],
          color: '#ffd400',
        },
      ],
    });
    const annots = await annotationsOf(result);
    const numbers = (annots[0].QuadPoints.match(/[-\d.]+/g) || []).map(Number);
    // Eight numbers per quad, one quad per line.
    assert.strictEqual(numbers.length, 16);
    // And one annotation, not one per line: the two lines are one highlight.
    assert.strictEqual(annots.length, 1);
  });

  it('bounds the rectangle around every line', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [
        {
          page: 0,
          rects: [
            [72, 697, 340, 715],
            [72, 677, 345, 695],
          ],
          color: '#ffd400',
        },
      ],
    });
    const rect = (await annotationsOf(result))[0].Rect;
    const numbers = (rect.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(numbers, [72, 677, 345, 715]);
  });

  it('marks the annotation printable', async () => {
    // Without the Print flag the highlight is on screen but absent from
    // anything printed or exported.
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    assert.strictEqual((await annotationsOf(result))[0].F, '4');
  });

  it('writes the colour as PDF components', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [{ page: 0, rects: [[0, 0, 10, 10]], color: '#ff0000' }],
    });
    const colour = (await annotationsOf(result))[0].C;
    const numbers = (colour.match(/[-\d.]+/g) || []).map(Number);
    assert.deepStrictEqual(numbers, [1, 0, 0]);
  });

  it('falls back to yellow rather than losing an unreadable colour', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [{ page: 0, rects: [[0, 0, 10, 10]], color: 'not-a-colour' }],
    });
    const annots = await annotationsOf(result);
    assert.strictEqual(annots.length, 1, 'the highlight must survive');
    const numbers = (annots[0].C.match(/[-\d.]+/g) || []).map(Number);
    assert.strictEqual(numbers[0], 1);
    assert.ok(numbers[2] < 0.1, 'expected a yellow, not a grey or a white');
  });

  it('puts each highlight on its own page', async () => {
    const result = await applyEdits(await blankPdf(3), {
      highlights: [
        { page: 0, rects: [[0, 0, 10, 10]], color: '#ffd400' },
        { page: 2, rects: [[0, 0, 10, 10]], color: '#ffd400' },
      ],
    });
    assert.strictEqual((await annotationsOf(result, 0)).length, 1);
    assert.strictEqual((await annotationsOf(result, 1)).length, 0);
    assert.strictEqual((await annotationsOf(result, 2)).length, 1);
  });

  it('ignores a highlight for a page that does not exist', async () => {
    // Stale coordinates from a document that was reloaded should not throw and
    // lose the save along with them.
    const result = await applyEdits(await blankPdf(1), {
      highlights: [{ page: 7, rects: [[0, 0, 10, 10]], color: '#ffd400' }],
    });
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

    const result = await applyEdits(await doc.save(), {
      highlights: [oneLine],
    });
    const annots = await annotationsOf(result);
    const subtypes = annots.map((a) => a.Subtype).sort();
    assert.deepStrictEqual(subtypes, ['/Highlight', '/Link']);
  });

  it('adds highlights to a page that has none without disturbing others', async () => {
    const result = await applyEdits(await blankPdf(2), {
      highlights: [
        oneLine,
        { page: 0, rects: [[10, 10, 20, 20]], color: '#00ff00' },
      ],
    });
    assert.strictEqual((await annotationsOf(result, 0)).length, 2);
  });
});

describe('the appearance stream', () => {
  /*
   * Without one, a /Highlight is invisible in PDF.js: its annotation layer
   * gives `.highlightAnnotation` a cursor and nothing else, because the colour
   * is meant to come from the appearance. Adobe and Foxit synthesise one;
   * PDF.js does not. Highlights looked like they vanished the moment they were
   * saved, which read as the save having failed.
   */
  async function appearanceOf(bytes: Uint8Array): Promise<unknown> {
    const doc = await PDFDocument.load(bytes);
    const annots = doc
      .getPage(0)
      .node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const annotation = annots.lookup(0);
    const ap = annotation.get(PDFName.of('AP'));
    return doc.context.lookup(ap.get(PDFName.of('N')));
  }

  it('gives every highlight one', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    assert.ok(await appearanceOf(result), 'expected an /AP /N stream');
  });

  it('is a form XObject bounded by the highlight', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    const stream = (await appearanceOf(result)) as {
      dict: { get(k: unknown): { toString(): string } | undefined };
    };
    assert.strictEqual(
      stream.dict.get(PDFName.of('Subtype'))?.toString(),
      '/Form'
    );
    const box = stream.dict.get(PDFName.of('BBox'))?.toString() || '';
    assert.deepStrictEqual(
      (box.match(/[-\d.]+/g) || []).map(Number),
      [72, 697, 340, 715]
    );
  });

  it('multiplies, so the text underneath stays readable', async () => {
    // A plain fill would cover the words it is meant to mark.
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    const stream = (await appearanceOf(result)) as {
      dict: { toString(): string };
    };
    assert.match(stream.dict.toString(), /\/BM \/Multiply/);
  });

  it('declares a transparency group, or the blend has nothing to see', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [oneLine],
    });
    const stream = (await appearanceOf(result)) as {
      dict: { toString(): string };
    };
    assert.match(stream.dict.toString(), /\/S \/Transparency/);
  });

  it('paints one rectangle per line', async () => {
    const result = await applyEdits(await blankPdf(), {
      highlights: [
        {
          page: 0,
          rects: [
            [72, 697, 340, 715],
            [72, 677, 345, 695],
          ],
          color: '#ffd400',
        },
      ],
    });
    const stream = (await appearanceOf(result)) as { contents: Uint8Array };
    const operators = Buffer.from(stream.contents).toString('latin1');
    assert.strictEqual(
      (operators.match(/ re$/gm) || []).length,
      2,
      'expected a rectangle for each line'
    );
    assert.match(operators, /\/GS gs/, 'the blend state must be selected');
  });
});

describe('deleting annotations', () => {
  /*
   * PDF.js 3.1.81 cannot delete an annotation that was already in the file —
   * its editors only ever create — so the Erase tool hides the annotation in
   * the viewer and the reference is struck from the file here. The reference
   * is what identifies it: two identical highlights on a page are distinct
   * annotations, and deleting one must not take the other with it.
   */
  async function pdfWithAnnotations(
    count: number
  ): Promise<{ bytes: Uint8Array; ids: string[] }> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const refs = [];
    for (let i = 0; i < count; i++) {
      refs.push(
        doc.context.register(
          doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Square'),
            Rect: [i * 10, 0, i * 10 + 5, 5],
          })
        )
      );
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
    return {
      bytes: await doc.save(),
      // PDF.js names an annotation after its reference: "<num>R".
      ids: refs.map((ref) => `${ref.objectNumber}R`),
    };
  }

  it('removes the annotation it was asked to', async () => {
    const { bytes, ids } = await pdfWithAnnotations(3);
    const result = await applyEdits(bytes, {
      deletedAnnotationIds: [ids[1]],
    });
    assert.strictEqual((await annotationsOf(result)).length, 2);
  });

  it('leaves the others in place', async () => {
    const { bytes, ids } = await pdfWithAnnotations(3);
    const result = await applyEdits(bytes, {
      deletedAnnotationIds: [ids[0]],
    });
    const rects = (await annotationsOf(result)).map((a) => a.Rect);
    // The first was at x=0; the two that remain start at 10 and 20.
    assert.ok(!rects.some((r) => /\[ 0 0 5 5 \]/.test(r)));
    assert.strictEqual(rects.length, 2);
  });

  it('removes several at once', async () => {
    const { bytes, ids } = await pdfWithAnnotations(4);
    const result = await applyEdits(bytes, {
      deletedAnnotationIds: [ids[0], ids[2], ids[3]],
    });
    assert.strictEqual((await annotationsOf(result)).length, 1);
  });

  it('ignores an id that is not on the page', async () => {
    // A stale id from a reloaded document must not throw and lose the save.
    const { bytes } = await pdfWithAnnotations(2);
    const result = await applyEdits(bytes, {
      deletedAnnotationIds: ['99999R'],
    });
    assert.strictEqual((await annotationsOf(result)).length, 2);
  });

  it('ignores an id it cannot parse', async () => {
    const { bytes } = await pdfWithAnnotations(2);
    const result = await applyEdits(bytes, {
      deletedAnnotationIds: ['not-an-id', ''],
    });
    assert.strictEqual((await annotationsOf(result)).length, 2);
  });

  it('adds and deletes in a single pass', async () => {
    const { bytes, ids } = await pdfWithAnnotations(2);
    const result = await applyEdits(bytes, {
      highlights: [oneLine],
      deletedAnnotationIds: [ids[0]],
    });
    const annots = await annotationsOf(result);
    assert.strictEqual(annots.length, 2, 'one removed, one added');
    assert.ok(annots.some((a) => a.Subtype === '/Highlight'));
    assert.ok(annots.some((a) => a.Subtype === '/Square'));
  });

  it('returns the document untouched when nothing is deleted', async () => {
    const { bytes } = await pdfWithAnnotations(1);
    const result = await applyEdits(bytes, { deletedAnnotationIds: [] });
    assert.strictEqual(result, bytes);
  });
});
