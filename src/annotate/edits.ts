/*
 * The edits a save applies to a PDF that PDF.js cannot make itself.
 *
 * The bundled PDF.js is 3.1.81. Its `saveNewAnnotations` understands only
 * FreeText and Ink — the highlight editor arrived in 4.3 — and it cannot
 * delete an annotation that was already in the file at all. So highlights are
 * added and annotations removed here, in one pass, after PDF.js has produced
 * the file containing everything it does handle.
 *
 * Highlights come out as real `/Highlight` annotations with QuadPoints and an
 * appearance stream, so Foxit, Adobe, Preview and PDF.js itself all show them,
 * and they travel inside the document rather than in a sidecar file.
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

/** Everything a save has to apply to the file in one pass. */
export interface AnnotationEdits {
  /** Highlights to add. */
  highlights?: readonly Highlight[];
  /**
   * Annotations to remove, by PDF.js's id for them — `"12R"` or `"12R3"`,
   * which is the object's reference written out. That is the only handle the
   * webview has on an annotation that was already in the file, and it maps
   * straight onto a pdf-lib reference.
   */
  deletedAnnotationIds?: readonly string[];
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Object and generation numbers from PDF.js's `"<num>R<gen>"` id. */
function parseAnnotationId(id: string): { num: number; gen: number } | null {
  const match = /^(\d+)R(\d*)$/.exec(String(id).trim());
  if (!match) {
    return null;
  }
  return {
    num: parseInt(match[1], 10),
    gen: match[2] ? parseInt(match[2], 10) : 0,
  };
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
 * Apply the edits to `pdfBytes` and return the new document.
 *
 * Deletions run before additions so that a highlight added and removed in the
 * same session cannot be resurrected by the ordering, and both share one load
 * and one save — a paper is several megabytes, and doing it twice would show.
 *
 * pdf-lib is loaded here rather than at module scope so that opening a PDF
 * never pays for it: it is only needed when an edited document is saved.
 */
export async function applyEdits(
  pdfBytes: Uint8Array,
  edits: AnnotationEdits
): Promise<Uint8Array> {
  const highlights = edits.highlights || [];
  const deleted = edits.deletedAnnotationIds || [];
  if (highlights.length === 0 && deleted.length === 0) {
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

  removeAnnotations(pages, deleted, PDFName, PDFArray);

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

    // Without an appearance stream a /Highlight is invisible in PDF.js — its
    // annotation layer gives `.highlightAnnotation` a cursor and nothing else,
    // because the colour is supposed to come from the appearance. Adobe and
    // Foxit synthesise one; PDF.js does not, so it is built here. Multiply is
    // what makes it read as a highlighter: the ink darkens the page instead of
    // covering the text.
    const box = boundingBox(highlight.rects);
    const operators = ['/GS gs', `${r} ${g} ${b} rg`];
    for (const rect of highlight.rects) {
      const [x1, y1, x2, y2] = rect;
      const left = Math.min(x1, x2);
      const bottom = Math.min(y1, y2);
      operators.push(
        `${left} ${bottom} ${Math.abs(x2 - x1)} ${Math.abs(y2 - y1)} re`
      );
    }
    operators.push('f');

    const appearance = context.stream(operators.join('\n'), {
      Type: PDFName.of('XObject'),
      Subtype: PDFName.of('Form'),
      BBox: box.map((n: number) => PDFNumber.of(n)),
      // A transparency group is what lets the blend mode see the page behind
      // the annotation rather than only the annotation's own blank backdrop.
      Group: context.obj({
        Type: PDFName.of('Group'),
        S: PDFName.of('Transparency'),
        CS: PDFName.of('DeviceRGB'),
      }),
      Resources: context.obj({
        ExtGState: context.obj({
          GS: context.obj({
            Type: PDFName.of('ExtGState'),
            BM: PDFName.of('Multiply'),
            CA: PDFNumber.of(1),
            ca: PDFNumber.of(1),
          }),
        }),
      }),
    });

    annotation.set(
      PDFName.of('AP'),
      context.obj({ N: context.register(appearance) })
    );

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

/**
 * Drop the named annotations from every page that carries them.
 *
 * The reference is matched rather than the object's contents, because two
 * identical highlights on a page are distinct annotations and deleting one
 * must not take the other with it. Entries that are not references — a page
 * may inline an annotation dictionary — are left alone, since there is no
 * reference to match them by.
 */
interface AnnotsArray {
  size(): number;
  get(index: number): { objectNumber?: number; generationNumber?: number };
  remove(index: number): void;
}

interface PdfLibPage {
  node: {
    lookupMaybe(key: unknown, type: unknown): AnnotsArray | undefined;
  };
}

function removeAnnotations(
  pages: PdfLibPage[],
  ids: readonly string[],
  PDFName: { of(name: string): unknown },
  PDFArray: unknown
): void {
  if (ids.length === 0) {
    return;
  }

  const wanted = new Set<string>();
  for (const id of ids) {
    const ref = parseAnnotationId(id);
    if (ref) {
      wanted.add(`${ref.num}:${ref.gen}`);
    }
  }
  if (wanted.size === 0) {
    return;
  }

  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      continue;
    }
    // Backwards, so removing one does not shift the indices still to check.
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i);
      if (!entry || typeof entry.objectNumber !== 'number') {
        continue;
      }
      const key = `${entry.objectNumber}:${entry.generationNumber || 0}`;
      if (wanted.has(key)) {
        annots.remove(i);
      }
    }
  }
}
