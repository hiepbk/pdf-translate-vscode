/*
 * Cleaning of text extracted from a PDF.js text layer.
 *
 * A selection taken from `window.getSelection()` over a PDF text layer is not
 * prose: it is a sequence of positioned glyph runs that the browser stitches
 * together with newlines. Before it can be translated it has to be turned back
 * into sentences, otherwise the translation engine sees a pile of fragments and
 * returns a pile of fragments.
 *
 * The pipeline is:
 *   1. normalise characters   (ligatures, quotes, dashes, invisible spaces)
 *   2. split into lines and drop page furniture (running heads, page numbers)
 *   3. re-join the lines into paragraphs, undoing end-of-line hyphenation
 *   4. tidy the resulting spacing and punctuation
 */

export interface CleanOptions {
  /** Run the whole pipeline. When false the text is passed through untouched. */
  enabled: boolean;
  /** Drop lines that look like running headers, footers or page numbers. */
  removeHeadersFooters: boolean;
}

export const defaultCleanOptions: CleanOptions = {
  enabled: true,
  removeHeadersFooters: true,
};

/* ------------------------------------------------------------------ *
 * 1. Character normalisation
 * ------------------------------------------------------------------ */

/**
 * Ligatures are single code points in many PDF fonts. Translation engines and
 * dictionaries do not know them, so `ﬁnd` has to become `find`.
 */
const LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  [/ﬅ/g, 'st'],
  [/ﬆ/g, 'st'],
  [/Ĳ/g, 'IJ'],
  [/ĳ/g, 'ij'],
  [/Œ/g, 'OE'],
  [/œ/g, 'oe'],
  [/Æ/g, 'AE'],
  [/æ/g, 'ae'],
];

/**
 * Zero-width and formatting characters that carry no meaning in a PDF text
 * layer: ZWSP, the word joiner, the BOM and the soft hyphen. They are common in
 * extracted text and silently break the word-boundary checks further down the
 * pipeline. Built from escape sequences because they are invisible in source.
 *
 * Deliberately absent are ZWJ (U+200D) and ZWNJ (U+200C). They look equally
 * like noise, but they are load-bearing in Arabic, Persian and Indic scripts
 * and in emoji sequences, so stripping them would corrupt the text rather than
 * clean it.
 */
const INVISIBLE = new RegExp('[\u200B\u2060\uFEFF\u00AD]', 'g');

/** Every flavour of space that is not a plain U+0020. */
const EXOTIC_SPACE = new RegExp(
  '[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]',
  'g'
);

function normaliseCharacters(input: string): string {
  let text = input;

  // Normalise to composed form first so that accented characters are single
  // code points; some PDF producers emit "e" + combining acute.
  if (typeof text.normalize === 'function') {
    text = text.normalize('NFC');
  }

  text = text.replace(/\r\n?/g, '\n');

  for (const [pattern, replacement] of LIGATURES) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(INVISIBLE, '');
  text = text.replace(EXOTIC_SPACE, ' ');
  text = text.replace(/\t/g, ' ');

  // Curly quotes and primes confuse tokenisers far more often than they help.
  text = text.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');

  // Hyphen look-alikes and the typographic minus become an ASCII hyphen, so
  // that the de-hyphenation step below recognises a broken word however the
  // PDF producer spelled the break. The em dash is left alone: it is
  // punctuation between clauses, never a word break.
  text = text.replace(/[‐‑‒–−]/g, '-');

  // Ellipsis as three dots reads the same and survives chunking.
  text = text.replace(/…/g, '...');

  return text;
}

/* ------------------------------------------------------------------ *
 * 2. Page furniture
 * ------------------------------------------------------------------ */

/**
 * Patterns for lines that are part of the page, not part of the text. These are
 * only ever applied to lines in the interior of a multi-line selection, so a
 * user who deliberately selects a single page number still gets it translated.
 */
const FURNITURE_PATTERNS: RegExp[] = [
  // Bare page numbers, decorated or not: "12", "- 12 -", "[ 12 ]".
  /^[[(\-\u2014\s]*\d{1,4}[\])\-\u2014\s]*$/,
  // Roman-numeral page numbers from front matter. The lookahead demands at
  // least two numeral letters so that a line consisting of the word "I" is
  // left alone, and the body is a strict roman numeral so that words made of
  // numeral letters ("did", "civil") are not swallowed.
  /^[[(\-\u2014\s]*(?=[ivxlcdm]{2,})m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})[\])\-\u2014\s]*$/i,
  // "Page 3", "Page 3 of 12", "3 / 12".
  /^(page|p\.)\s*\d+(\s*(of|\/)\s*\d+)?$/i,
  /^\d+\s*\/\s*\d+$/,
  // arXiv and preprint stamps, usually printed down the side of the page.
  /^arxiv:\s*\d{4}\.\d{4,5}(v\d+)?(\s*\[[^\]]*\])?(\s+\d{1,2}\s+\w+\s+\d{4})?$/i,
  /^(preprint|submitted to|under review as a conference paper|accepted at)\b.{0,80}$/i,
  // Copyright, licensing and access footers.
  /^(\u00A9|\(c\)|copyright)\s*\d{4}.{0,80}$/i,
  /^all rights reserved\.?$/i,
  /^(licensed under|this work is licensed)\b.{0,80}$/i,
  /^(downloaded from|this content downloaded from)\b.{0,120}$/i,
  // Bare identifiers that carry no meaning for a reader.
  /^(doi|isbn|issn)\s*:?\s*\S+$/i,
  /^https?:\/\/\S+$/i,
  /^www\.\S+$/i,
];

function isFurnitureLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  // Anything long enough to be a sentence is not furniture, whatever it matches.
  if (trimmed.length > 140) {
    return false;
  }
  return FURNITURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * A running header repeats on every page, so in a selection that spans pages it
 * shows up several times verbatim. That repetition is the most reliable signal
 * available — far better than guessing from the wording.
 */
function findRepeatedLines(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    // Short lines only: a repeated full sentence is more likely to be real text
    // (a refrain, a repeated table cell) than a running head.
    if (key.length < 3 || key.length > 90) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const repeated = new Set<string>();
  counts.forEach((count, key) => {
    if (count >= 2) {
      repeated.add(key);
    }
  });
  return repeated;
}

/**
 * Words that a title never ends on, but a wrapped line of prose very often
 * does. "Table 2 below, which shows that" and "Journal of Irreproducible
 * Results" are otherwise indistinguishable — both are short, capitalised and
 * unpunctuated — and this is what separates them.
 */
const TRAILING_FUNCTION_WORD =
  /\b(the|an?|of|in|on|at|to|for|from|by|with|as|and|or|but|that|which|who|whose|is|are|was|were|be|been|has|have|had|its|their|our|this|these|those|we|it|not|than|then|when|while|between|into|over|under|about)$/i;

/**
 * Whether a line could be the journal name, chapter title or author list that
 * sits next to a page number in a header or footer band.
 *
 * A line that starts lowercase is the continuation of the sentence above it and
 * therefore body text; a line that ends in sentence punctuation is prose; and a
 * line that trails off on a function word is a wrapped sentence. What is left is
 * short, capitalised and self-contained — which is what a running head is.
 */
function couldBeRunningHead(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {
    return false;
  }
  if (/[.!?,;:]$/.test(trimmed)) {
    return false;
  }
  if (/^[a-z]/.test(trimmed)) {
    return false;
  }
  return !TRAILING_FUNCTION_WORD.test(trimmed);
}

/**
 * Whether the prose runs straight across `[start, end]`, i.e. the line above
 * the band breaks off mid-sentence and the line below picks it up in lower
 * case. When it does, whatever sits between them interrupted a sentence and is
 * page furniture rather than text.
 */
function textFlowsAcross(lines: string[], start: number, end: number): boolean {
  const before = lines[start - 1];
  const after = lines[end + 1];
  if (before === undefined || after === undefined) {
    return false;
  }
  return !/[.!?]["')\]]?$/.test(before.trim()) && /^[a-z]/.test(after.trim());
}

function stripFurniture(lines: string[]): string[] {
  if (lines.length < 3) {
    // Too little context to tell furniture from content; leave it alone.
    return lines;
  }

  const repeated = findRepeatedLines(lines);
  const drop = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const isInterior = i > 0 && i < lines.length - 1;
    const key = lines[i].trim().toLowerCase();

    // A page number at the very start or end of the selection is dropped too:
    // it is almost always the tail of the page the user started or stopped on.
    if (isFurnitureLine(lines[i])) {
      drop.add(i);
      continue;
    }

    // A repeated short line is only dropped in the interior, where a running
    // head genuinely appears between two pages of body text.
    if (isInterior && repeated.has(key) && key.length <= 90) {
      drop.add(i);
    }
  }

  // Page furniture comes in bands: the page number sits directly above or below
  // the journal name or chapter title. Those neighbours appear only once each,
  // so repetition cannot find them — but their adjacency to a line already
  // known to be furniture can.
  //
  // Two guards keep this from eating body text. Only bands strictly inside the
  // selection are grown, because at the edges there is no way to tell a running
  // head from the first line of the passage; and a grown band is only accepted
  // if the prose demonstrably runs across it.
  for (const seed of Array.from(drop)) {
    if (seed === 0 || seed === lines.length - 1) {
      continue;
    }

    let start = seed;
    let end = seed;
    while (start > 0 && couldBeRunningHead(lines[start - 1])) {
      start--;
    }
    while (end < lines.length - 1 && couldBeRunningHead(lines[end + 1])) {
      end++;
    }

    if (start === seed && end === seed) {
      continue;
    }
    if (!textFlowsAcross(lines, start, end)) {
      continue;
    }

    for (let j = start; j <= end; j++) {
      drop.add(j);
    }
  }

  const kept = lines.filter((_, index) => !drop.has(index));

  // Never hand back nothing: if the heuristics ate the whole selection the
  // heuristics were wrong.
  return kept.length > 0 ? kept : lines;
}

/* ------------------------------------------------------------------ *
 * 3. Re-joining lines into paragraphs
 * ------------------------------------------------------------------ */

const BULLET_START =
  /^\s*(?:[-•‣◦⁃∙*·▪●■⁃]|\(?\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivxlcdm]{1,5}[.)])\s+/i;

/** A heading-ish line: no terminal punctuation, short, often title case. */
function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false;
  }
  if (/[.!?;:,]$/.test(trimmed)) {
    return false;
  }
  // Numbered section headings: "3.2 Related Work".
  if (/^\d+(\.\d+)*\.?\s+\S/.test(trimmed)) {
    return true;
  }
  // ALL CAPS headings.
  if (trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Decide whether `previous` and `next` are two halves of one wrapped line, or
 * two separate blocks that should stay on separate lines.
 */
function isParagraphBreak(
  previous: string,
  next: string,
  medianLength: number
): boolean {
  const prev = previous.trim();
  const following = next.trim();

  if (!prev || !following) {
    return true;
  }
  // A list item always starts a new line, as does the line after a heading.
  if (BULLET_START.test(next) || looksLikeHeading(prev)) {
    return true;
  }
  // A line that ends a sentence *and* stops well short of the column width is
  // the last line of a paragraph. A sentence that ends mid-column is just a
  // sentence boundary inside a paragraph, and must not become a line break.
  if (/[.!?]["')\]]?$/.test(prev) && prev.length < medianLength * 0.8) {
    return true;
  }
  return false;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function joinLines(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }

  const medianLength = median(
    lines.map((line) => line.trim().length).filter((length) => length > 0)
  );

  let result = lines[0].trim();
  // The paragraph-break test compares against the width of the *line* that came
  // before, so the previous line is tracked separately from the accumulated
  // text: by the second join `result` is already longer than any single line.
  let previousLine = result;

  for (let i = 1; i < lines.length; i++) {
    const current = lines[i].trim();
    if (!current) {
      continue;
    }

    const previousEnd = result.slice(-1);
    const beforeHyphen = result.slice(-2, -1);
    const wasParagraphBreak = isParagraphBreak(
      previousLine,
      current,
      medianLength
    );
    previousLine = current;

    if (wasParagraphBreak) {
      result += '\n' + current;
      continue;
    }

    // End-of-line hyphenation. "represen-\ntation" must become "representation",
    // but a genuine compound such as "non-\nlinear" keeps its hyphen. The
    // distinguishing signal is the case of the continuation: PDF layout engines
    // only break inside a lowercase word.
    if (previousEnd === '-' && /[A-Za-zÀ-ɏ]/.test(beforeHyphen)) {
      if (/^[a-zß-ɏ]/.test(current)) {
        result = result.slice(0, -1) + current;
      } else {
        // Uppercase or digit after the break: a real hyphen, joined with no gap.
        result += current;
      }
      continue;
    }

    result += ' ' + current;
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 4. Final tidy-up
 * ------------------------------------------------------------------ */

function tidySpacing(input: string): string {
  let text = input;

  text = text.replace(/[ ]{2,}/g, ' ');
  // A space before closing punctuation is an artefact of glyph-run stitching.
  text = text.replace(/ +([,.;:!?%)\]}])/g, '$1');
  text = text.replace(/([([{]) +/g, '$1');
  // ...but a sentence must still breathe afterwards.
  text = text.replace(/([,;:])(?=[^\s\d])/g, '$1 ');
  text = text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function cleanPdfText(
  raw: string,
  options: CleanOptions = defaultCleanOptions
): string {
  if (!raw) {
    return '';
  }
  if (!options.enabled) {
    return raw.trim();
  }

  const normalised = normaliseCharacters(raw);

  let lines = normalised
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (options.removeHeadersFooters) {
    lines = stripFurniture(lines);
  }

  return tidySpacing(joinLines(lines));
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/**
 * Split text into pieces no longer than `limit`, preferring to break at
 * paragraph ends, then sentence ends, then word boundaries. Translation quality
 * drops sharply when a sentence is cut in half, so the order matters.
 */
export function splitIntoChunks(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) {
      // Sentence end followed by whitespace.
      const sentence = /[.!?]["')\]]?\s/g;
      let match: RegExpExecArray | null;
      let last = -1;
      while ((match = sentence.exec(window)) !== null) {
        last = match.index + match[0].length;
      }
      cut = last;
    }
    if (cut < limit * 0.5) {
      cut = window.lastIndexOf(' ');
    }
    if (cut <= 0) {
      cut = limit;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
