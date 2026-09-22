/*
 * Writing highlight annotations into a PDF.
 *
 * The bundled PDF.js is 3.1.81, whose `saveNewAnnotations` understands only
 * FreeText and Ink — the highlight editor arrived in 4.3. So highlights cannot
 * travel out through PDF.js's own save path, and are written here instead,
 * after PDF.js has produced the file containing everything it does handle.
 *
 * The result is a real `/Highlight` annotation with QuadPoints, so Foxit,
 * Adobe, Preview and PDF.js itself all show it, and it travels with the
 * document rather than living in a sidecar file.
 */

/** A highlight as the webview measured it, in PDF user-space coordinates. */
export interface Highlight {
  /** Zero-based page index. */
  page: number;
  /**
   * One rectangle per line of selected text, `[x1, y1, x2, y2]` with the
   * origin at the bottom-left of the page, as PDF uses.
   */
  rects: Array<[number, number, number, number]>;
  /** `#rrggbb`. */
  color: string;
  /** The text under the highlight, stored as the annotation's contents. */
  text?: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(color: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  // An unreadable colour should not lose the highlight, so yellow stands in.
  const hex = match ? match[1] : 'ffd400';
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/** The union of every rectangle: the annotation's `/Rect`. */
function boundingBox(
  rects: Array<[number, number, number, number]>
): [number, number, number, number] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const rect of rects) {
    x1 = Math.min(x1, rect[0], rect[2]);
    y1 = Math.min(y1, rect[1], rect[3]);
    x2 = Math.max(x2, rect[0], rect[2]);
    y2 = Math.max(y2, rect[1], rect[3]);
  }
  return [x1, y1, x2, y2];
}

/**
 * QuadPoints for one rectangle.
 *
 * The PDF specification describes the order as counter-clockwise starting at
 * the lower-left, but every producer in practice — and therefore every
 * consumer — writes upper-left, upper-right, lower-left, lower-right. Follow
 * the practice, or the highlight renders as a bow tie in some readers.
 */
function quadPoints(rect: [number, number, number, number]): number[] {
  const [x1, y1, x2, y2] = rect;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bottom = Math.min(y1, y2);
  const top = Math.max(y1, y2);
  return [left, top, right, top, left, bottom, right, bottom];
}

/**
 * Add the highlights to `pdfBytes` and return the new document.
 *
 * pdf-lib is loaded here rather than at module scope so that opening a PDF
 * never pays for it: it is only needed when a document with highlights is
 * saved.
 */
export async function applyHighlights(
  pdfBytes: Uint8Array,
  highlights: readonly Highlight[]
): Promise<Uint8Array> {
  if (highlights.length === 0) {
    return pdfBytes;
  }

  /* eslint-disable @typescript-eslint/no-var-requires */
  const {
    PDFDocument,
    PDFName,
    PDFArray,
    PDFNumber,
    PDFString,
    PDFHexString,
  } = require('pdf-lib');
  /* eslint-enable @typescript-eslint/no-var-requires */

  // ignoreEncryption: a paper downloaded from a publisher is often "encrypted"
  // with an empty owner password purely to flag printing permissions. Refusing
  // to annotate those would rule out much of what this is for.
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const context = pdfDoc.context;

  for (const highlight of highlights) {
    const page = pages[highlight.page];
    if (!page || highlight.rects.length === 0) {
      continue;
    }

    const { r, g, b } = parseColor(highlight.color);
    const quads: number[] = [];
    for (const rect of highlight.rects) {
      quads.push(...quadPoints(rect));
    }

    const annotation = context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Highlight'),
      Rect: boundingBox(highlight.rects).map((n: number) => PDFNumber.of(n)),
      QuadPoints: quads.map((n) => PDFNumber.of(n)),
      C: [PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)],
      CA: PDFNumber.of(1),
      // Bit 3 (Print). Without it the highlight is on screen but missing from
      // anything printed or exported.
      F: PDFNumber.of(4),
      T: PDFString.of('PDF Viewer with Translate'),
      Contents: PDFHexString.fromText(highlight.text || ''),
      M: PDFString.fromDate(new Date()),
    });

    const ref = context.register(annotation);

    // A page may have no /Annots at all, and when it does the array can be an
    // indirect reference rather than the array itself. `lookupMaybe` resolves
    // the reference and returns undefined for the missing case; plain `lookup`
    // throws there instead, which would turn a first highlight on a clean page
    // into a failed save.
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      annots = context.obj([]);
      page.node.set(PDFName.of('Annots'), annots);
    }
    // Appending, never replacing: a paper's links and bookmarks live in this
    // same array.
    annots.push(ref);
  }

  return pdfDoc.save({ useObjectStreams: false });
}
