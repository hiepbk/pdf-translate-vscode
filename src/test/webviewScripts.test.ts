import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/*
 * The webview scripts under lib/ are plain JavaScript: tsc never sees them and
 * eslint only runs over src/, so nothing checked they even parsed. A stray
 * backtick inside a CSS template literal once closed the string early and
 * killed lib/highlight.js outright — the file simply never ran, the toolbar
 * button did nothing, and the only symptom was "highlighting doesn't work".
 *
 * These tests close that gap: every script must parse, and the highlight path
 * must survive a click and a selection.
 */

const LIB = path.join(__dirname, '..', '..', '..', 'lib');

function webviewScripts(): string[] {
  return fs
    .readdirSync(LIB)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(LIB, name));
}

describe('webview scripts', () => {
  it('finds the scripts it is meant to be checking', () => {
    const names = webviewScripts().map((file) => path.basename(file));
    ['translate.js', 'annotate.js', 'highlight.js', 'toolbar.js'].forEach(
      (expected) => assert.ok(names.includes(expected), `missing ${expected}`)
    );
  });

  webviewScripts().forEach((file) => {
    it(`${path.basename(file)} parses`, () => {
      const source = fs.readFileSync(file, 'utf8');
      // Compiling is enough: a syntax error throws here, and nothing runs.
      assert.doesNotThrow(
        () => new vm.Script(source, { filename: file }),
        `${path.basename(file)} has a syntax error, so it would never run`
      );
    });
  });
});

/* ------------------------------------------------------------------ *
 * The highlight path, end to end
 * ------------------------------------------------------------------ */

/** The smallest DOM that lib/highlight.js and lib/toolbar.js will run against. */
function makeElement(tag = 'div'): Record<string, unknown> {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const attributes: Record<string, string> = {};
  const element: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    children: [] as unknown[],
    hidden: false,
    value: '',
    title: '',
    textContent: '',
    classList: {
      toggle: (): void => undefined,
      add: (): void => undefined,
      remove: (): void => undefined,
    },
    setAttribute: (k: string, v: string): void => {
      attributes[k] = String(v);
    },
    getAttribute: (k: string): string | null =>
      k in attributes ? attributes[k] : null,
    appendChild: (child: unknown): unknown => child,
    removeChild: (): void => undefined,
    remove: (): void => undefined,
    addEventListener: (type: string, fn: (e: unknown) => void): void => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire: (type: string, event: unknown): void => {
      (listeners[type] || []).forEach((fn) => fn(event || {}));
    },
    querySelector: (): null => null,
    closest: (): null => null,
    getBoundingClientRect: (): Record<string, number> => ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    }),
  };
  return element;
}

interface Harness {
  posted: Array<Record<string, unknown>>;
  click(id: string): void;
  selectText(rects: Array<Record<string, number>>, text: string): void;
  isActive(): boolean;
}

function run(): Harness {
  const posted: Array<Record<string, unknown>> = [];
  const byId: Record<string, Record<string, unknown>> = {};
  const documentListeners: Record<string, Array<(e: unknown) => void>> = {};
  const windowListeners: Record<string, Array<(e: unknown) => void>> = {};

  // A page sitting at (100, 50) on screen, 595x842, rendered at 1:1.
  const pageBox = { left: 100, top: 50, right: 695, bottom: 892 };
  const textLayer = makeElement();
  textLayer.getBoundingClientRect = (): Record<string, number> => pageBox;
  const page = makeElement();
  page.getAttribute = (k: string): string | null =>
    k === 'data-page-number' ? '1' : null;
  textLayer.closest = (): unknown => page;

  const layers: unknown[] = [textLayer];

  [
    'pdfTranslateSelect',
    'pdfTranslateHighlight',
    'editorFreeText',
    'editorInk',
  ].forEach((id) => {
    byId[id] = makeElement('button');
  });
  const colour = makeElement('input');
  colour.value = '#ffd400';
  byId['pdfTranslateHighlightColor'] = colour;

  const viewport = {
    // PDF space counts y upward from the bottom of an 842-high page.
    convertToPdfPoint: (x: number, y: number): number[] => [x, 842 - y],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 842 - y],
  };
  const pageView = { div: makeElement(), viewport };

  const doc = {
    readyState: 'loading',
    head: makeElement(),
    body: makeElement(),
    createElement: (tag: string): unknown => makeElement(tag),
    getElementById: (id: string): unknown => byId[id] || null,
    addEventListener: (type: string, fn: (e: unknown) => void): void => {
      (documentListeners[type] = documentListeners[type] || []).push(fn);
    },
    querySelectorAll: (selector: string): unknown[] =>
      selector === '.page .textLayer' ? layers : [],
  };

  const win: Record<string, unknown> = {
    document: doc,
    addEventListener: (type: string, fn: (e: unknown) => void): void => {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    getSelection: (): unknown => null,
    __pdfTranslateVsCode: {
      postMessage: (m: Record<string, unknown>): void => {
        // A webview message is serialised on its way to the extension host, so
        // recording the serialised form is the faithful thing to do — and it
        // sheds the sandbox's own Array prototype, which deepStrictEqual would
        // otherwise refuse to match against this context's.
        posted.push(JSON.parse(JSON.stringify(m)));
      },
    },
    PDFViewerApplication: {
      initializedPromise: Promise.resolve(),
      pdfCursorTools: { activeTool: 0, switchTool: (): void => undefined },
      pdfViewer: { getPageView: (): unknown => pageView },
      eventBus: {
        on: (): void => undefined,
        dispatch: (): void => undefined,
      },
    },
  };
  win.window = win;

  const sandbox: Record<string, unknown> = {
    window: win,
    document: doc,
    Node: { TEXT_NODE: 3 },
    Set,
    Map,
    Math,
    JSON,
    parseInt,
    String,
    Number,
    Array,
    Object,
    Promise,
    Infinity,
    console,
  };
  vm.createContext(sandbox);

  ['highlight.js', 'toolbar.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(LIB, name), 'utf8'), sandbox, {
      filename: name,
    });
  });

  (documentListeners['DOMContentLoaded'] || []).forEach((fn) => fn({}));

  return {
    posted,
    click: (id): void => {
      (byId[id].fire as (t: string, e: unknown) => void)('click', {});
    },
    selectText: (rects, text): void => {
      // A real DOMRect carries width and height, and the code uses them to
      // find each rectangle's centre. Leaving them out of the stub made that
      // centre NaN and every rectangle fell off the page.
      const complete = rects.map((rect) => ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }));
      win.getSelection = (): unknown => ({
        isCollapsed: false,
        rangeCount: 1,
        toString: (): string => text,
        getRangeAt: (): unknown => ({
          getClientRects: (): unknown[] => complete,
        }),
        removeAllRanges: (): void => undefined,
      });
      (documentListeners['mouseup'] || []).forEach((fn) => fn({}));
    },
    isActive: (): boolean => {
      const api = win.__pdfTranslateHighlight as { isActive(): boolean };
      return api.isActive();
    },
  };
}

describe('highlighting, wired end to end', () => {
  it('exposes its API to the toolbar', () => {
    // If highlight.js fails to parse or throw during setup, the toolbar button
    // has nothing to call and highlighting silently does nothing.
    assert.strictEqual(typeof run().isActive, 'function');
  });

  it('is off until the toolbar turns it on', () => {
    const harness = run();
    assert.strictEqual(harness.isActive(), false);
  });

  it('turns on when the Highlight button is clicked', () => {
    const harness = run();
    harness.click('pdfTranslateHighlight');
    assert.strictEqual(harness.isActive(), true);
  });

  it('ignores a selection while another tool is active', () => {
    const harness = run();
    harness.selectText(
      [{ left: 172, top: 150, right: 300, bottom: 168 }],
      'some text'
    );
    assert.strictEqual(
      harness.posted.filter((m) => m.type === 'highlights').length,
      0
    );
  });

  it('produces a highlight in PDF coordinates from a selection', () => {
    const harness = run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(
      [{ left: 172, top: 150, right: 440, bottom: 168 }],
      'The model converges after twenty epochs.'
    );

    const messages = harness.posted.filter((m) => m.type === 'highlights');
    assert.strictEqual(messages.length, 1);

    const highlights = messages[0].highlights as Array<{
      page: number;
      rects: number[][];
      color: string;
    }>;
    assert.strictEqual(highlights.length, 1);
    assert.strictEqual(highlights[0].page, 0);
    // Page-relative x, and y flipped into PDF space: 842 - (168 - 50) = 724.
    assert.deepStrictEqual(highlights[0].rects, [[72, 724, 340, 742]]);
    assert.strictEqual(highlights[0].color, '#ffd400');
  });

  it('merges the fragments of one line into a single bar', () => {
    // A selection returns one rectangle per text span. Left alone they render
    // as adjacent boxes with visible seams, and bloat the saved annotation.
    const harness = run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(
      [
        { left: 172, top: 150, right: 300, bottom: 168 },
        { left: 300, top: 150, right: 440, bottom: 168 },
      ],
      'two fragments, one line'
    );

    const messages = harness.posted.filter((m) => m.type === 'highlights');
    const highlights = messages[0].highlights as Array<{ rects: number[][] }>;
    assert.strictEqual(highlights[0].rects.length, 1, 'expected one bar');
    assert.deepStrictEqual(highlights[0].rects, [[72, 724, 340, 742]]);
  });

  it('keeps separate lines separate', () => {
    const harness = run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(
      [
        { left: 172, top: 150, right: 440, bottom: 168 },
        { left: 172, top: 172, right: 400, bottom: 190 },
      ],
      'two lines'
    );

    const messages = harness.posted.filter((m) => m.type === 'highlights');
    const highlights = messages[0].highlights as Array<{ rects: number[][] }>;
    assert.strictEqual(highlights[0].rects.length, 2);
  });

  it('marks the document edited so Ctrl+S has something to save', () => {
    const harness = run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(
      [{ left: 172, top: 150, right: 440, bottom: 168 }],
      'text'
    );
    assert.ok(harness.posted.some((m) => m.type === 'edited'));
  });
});
