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
  /** The highlights the webview last told the host about. */
  currentHighlights(): unknown[];
  press(key: string, modifiers?: Record<string, boolean>): void;
  /** Press Ctrl+Z as though the caret were inside a text box. */
  pressInTextBox(key: string): void;
  /** Pretend PDF.js reported an editor edit. */
  editorEdit(): void;
  /** How many times PDF.js's own undo() was called. */
  pdfjsUndoCount(): number;
  /** What a keystroke did to the event: cancelled, stopped, or neither. */
  pressAndWatch(
    key: string,
    modifiers?: Record<string, boolean>
  ): { prevented: boolean; stopped: boolean };
}

async function run(): Promise<Harness> {
  const posted: Array<Record<string, unknown>> = [];
  const byId: Record<string, Record<string, unknown>> = {};
  const documentListeners: Record<string, Array<(e: unknown) => void>> = {};
  const windowListeners: Record<string, Array<(e: unknown) => void>> = {};
  const busHandlers: Record<string, Array<(e: unknown) => void>> = {};

  // Stands in for PDF.js's AnnotationEditorUIManager, which the real code only
  // ever reaches as the `source` of its state event.
  let pdfjsUndos = 0;
  const uiManager = {
    undo: (): void => {
      pdfjsUndos++;
      // PDF.js re-announces its state after an undo, which is how the
      // coordinator learns there is nothing left to take back.
      (busHandlers['annotationeditorstateschanged'] || []).forEach((fn) =>
        fn({
          source: uiManager,
          details: { hasSomethingToUndo: false, hasSomethingToRedo: true },
        })
      );
    },
    redo: (): void => undefined,
  };

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
        on: (type: string, fn: (e: unknown) => void): void => {
          (busHandlers[type] = busHandlers[type] || []).push(fn);
        },
        dispatch: (type: string, event: unknown): void => {
          (busHandlers[type] || []).forEach((fn) => fn(event));
        },
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

  ['highlight.js', 'toolbar.js', 'undo.js', 'noPrint.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(LIB, name), 'utf8'), sandbox, {
      filename: name,
    });
  });

  (documentListeners['DOMContentLoaded'] || []).forEach((fn) => fn({}));

  // Each script finishes wiring itself inside initializedPromise.then(), which
  // is a microtask. Without draining it here the event-bus handlers are not
  // registered yet, and every test that fires a PDF.js event would pass for
  // the wrong reason — by doing nothing at all.
  await new Promise((resolve) => setImmediate(resolve));

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
    currentHighlights: (): unknown[] => {
      const messages = posted.filter((m) => m.type === 'highlights');
      if (messages.length === 0) {
        return [];
      }
      return messages[messages.length - 1].highlights as unknown[];
    },
    press: (key, modifiers = {}): void => {
      const target = makeElement();
      target.closest = (): null => null;
      (windowListeners['keydown'] || []).forEach((fn) =>
        fn({
          key,
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          target,
          preventDefault: (): void => undefined,
          stopPropagation: (): void => undefined,
          ...modifiers,
        })
      );
    },
    pressInTextBox: (key): void => {
      const target = makeElement();
      // A contenteditable ancestor: PDF.js's text boxes are exactly this.
      target.closest = (): unknown => makeElement();
      (windowListeners['keydown'] || []).forEach((fn) =>
        fn({
          key,
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          target,
          preventDefault: (): void => undefined,
          stopPropagation: (): void => undefined,
        })
      );
    },
    editorEdit: (): void => {
      (busHandlers['annotationeditorstateschanged'] || []).forEach((fn) =>
        fn({
          source: uiManager,
          details: { hasSomethingToUndo: true, hasSomethingToRedo: false },
        })
      );
    },
    pdfjsUndoCount: (): number => pdfjsUndos,
    pressAndWatch: (key, modifiers = {}) => {
      const seen = { prevented: false, stopped: false };
      const target = makeElement();
      target.closest = (): null => null;
      (windowListeners['keydown'] || []).forEach((fn) =>
        fn({
          key,
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          target,
          preventDefault: (): void => {
            seen.prevented = true;
          },
          stopPropagation: (): void => {
            seen.stopped = true;
          },
          ...modifiers,
        })
      );
      return seen;
    },
  };
}

describe('highlighting, wired end to end', () => {
  it('exposes its API to the toolbar', async () => {
    // If highlight.js fails to parse or throw during setup, the toolbar button
    // has nothing to call and highlighting silently does nothing.
    assert.strictEqual(typeof (await run()).isActive, 'function');
  });

  it('is off until the toolbar turns it on', async () => {
    const harness = await run();
    assert.strictEqual(harness.isActive(), false);
  });

  it('turns on when the Highlight button is clicked', async () => {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    assert.strictEqual(harness.isActive(), true);
  });

  it('ignores a selection while another tool is active', async () => {
    const harness = await run();
    harness.selectText(
      [{ left: 172, top: 150, right: 300, bottom: 168 }],
      'some text'
    );
    assert.strictEqual(
      harness.posted.filter((m) => m.type === 'highlights').length,
      0
    );
  });

  it('produces a highlight in PDF coordinates from a selection', async () => {
    const harness = await run();
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

  it('merges the fragments of one line into a single bar', async () => {
    // A selection returns one rectangle per text span. Left alone they render
    // as adjacent boxes with visible seams, and bloat the saved annotation.
    const harness = await run();
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

  it('keeps separate lines separate', async () => {
    const harness = await run();
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

  it('marks the document edited so Ctrl+S has something to save', async () => {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(
      [{ left: 172, top: 150, right: 440, bottom: 168 }],
      'text'
    );
    assert.ok(harness.posted.some((m) => m.type === 'edited'));
  });
});

describe('Ctrl+Z', () => {
  const LINE = [{ left: 172, top: 150, right: 440, bottom: 168 }];
  const SECOND_LINE = [{ left: 172, top: 200, right: 400, bottom: 218 }];

  async function withOneHighlight(): Promise<Harness> {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'first');
    return harness;
  }

  it('takes back a highlight', async () => {
    const harness = await withOneHighlight();
    assert.strictEqual(harness.currentHighlights().length, 1);
    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 0);
  });

  it('takes back one selection at a time, newest first', async () => {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'first');
    harness.selectText(SECOND_LINE, 'second');
    assert.strictEqual(harness.currentHighlights().length, 2);

    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 1);
    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 0);
  });

  it('does nothing once there is nothing left to take back', async () => {
    const harness = await withOneHighlight();
    harness.press('z');
    harness.press('z');
    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 0);
  });

  it('puts a highlight back with Ctrl+Y', async () => {
    const harness = await withOneHighlight();
    harness.press('z');
    harness.press('y');
    assert.strictEqual(harness.currentHighlights().length, 1);
  });

  it('puts a highlight back with Ctrl+Shift+Z', async () => {
    const harness = await withOneHighlight();
    harness.press('z');
    harness.press('z', { shiftKey: true });
    assert.strictEqual(harness.currentHighlights().length, 1);
  });

  it('abandons the redo branch after a new edit', async () => {
    const harness = await withOneHighlight();
    harness.press('z');
    harness.selectText(SECOND_LINE, 'second');
    harness.press('y');
    // Redoing the abandoned highlight would resurrect something the user
    // deliberately took back, so only the new one is there.
    assert.strictEqual(harness.currentHighlights().length, 1);
  });

  it('leaves Ctrl+Z alone inside a text box', async () => {
    // PDF.js's text boxes are contenteditable, where Ctrl+Z means "undo my
    // typing" — the browser's own history, which this must not swallow.
    const harness = await withOneHighlight();
    harness.pressInTextBox('z');
    assert.strictEqual(harness.currentHighlights().length, 1);
  });

  it('sends the undo to PDF.js when its edit was the most recent', async () => {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'a highlight first');
    harness.editorEdit();

    harness.press('z');
    assert.strictEqual(harness.pdfjsUndoCount(), 1, 'PDF.js should undo');
    assert.strictEqual(
      harness.currentHighlights().length,
      1,
      'the highlight is older, so it must survive'
    );
  });

  it('reaches the highlight underneath once PDF.js is exhausted', async () => {
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'a highlight first');
    harness.editorEdit();

    harness.press('z');
    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 0);
  });

  it('undoes the highlight first when it came after the editor edit', async () => {
    const harness = await run();
    harness.editorEdit();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'a highlight last');

    harness.press('z');
    assert.strictEqual(harness.currentHighlights().length, 0);
    assert.strictEqual(
      harness.pdfjsUndoCount(),
      0,
      'the editor edit is older and must wait its turn'
    );
  });

  it('drops surplus PDF.js markers instead of swallowing a keystroke', async () => {
    // One editor edit can raise several state events, so the coordinator
    // deliberately over-counts. An undo that finds PDF.js with nothing left
    // must move on to the next entry rather than doing nothing.
    const harness = await run();
    harness.click('pdfTranslateHighlight');
    harness.selectText(LINE, 'a highlight');
    harness.editorEdit();
    harness.editorEdit();
    harness.editorEdit();

    harness.press('z'); // consumes PDF.js's single real undo
    harness.press('z'); // must skip the surplus markers and reach the highlight
    assert.strictEqual(harness.currentHighlights().length, 0);
  });
});

describe('printing', () => {
  /*
   * A webview is a Chromium frame, and Chromium claims Ctrl+P for print
   * preview and Ctrl+Shift+P for the system print dialog. Ctrl+Shift+P is how
   * VS Code opens the Command Palette, so over a PDF it opened a print dialog
   * instead. The keystroke has to be cancelled for Chromium and still allowed
   * through to VS Code, which is a narrower thing than "handle the key".
   */
  it('cancels Chromium printing on Ctrl+Shift+P', async () => {
    const harness = await run();
    const seen = harness.pressAndWatch('p', { shiftKey: true });
    assert.strictEqual(seen.prevented, true, 'Chromium must not print');
  });

  it('still lets Ctrl+Shift+P reach VS Code', async () => {
    // Stopping propagation would trade a broken print for a broken Command
    // Palette, which is the shortcut the user actually wanted.
    const harness = await run();
    const seen = harness.pressAndWatch('p', { shiftKey: true });
    assert.strictEqual(seen.stopped, false, 'the keystroke must travel on');
  });

  it('cancels Chromium printing on Ctrl+P too', async () => {
    const harness = await run();
    const seen = harness.pressAndWatch('p');
    assert.strictEqual(seen.prevented, true);
    assert.strictEqual(seen.stopped, false);
  });

  it('leaves Ctrl+Alt+P alone', async () => {
    // That combination is PDF.js's presentation mode, not a print.
    const harness = await run();
    const seen = harness.pressAndWatch('p', { altKey: true });
    assert.strictEqual(seen.prevented, false);
  });

  it('leaves unrelated Ctrl combinations to VS Code', async () => {
    const harness = await run();
    const seen = harness.pressAndWatch('b');
    assert.strictEqual(seen.prevented, false);
    assert.strictEqual(seen.stopped, false);
  });
});
