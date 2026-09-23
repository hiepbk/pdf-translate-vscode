/*
 * Text highlighting: the webview half.
 *
 * The bundled PDF.js is 3.1.81, which has no highlight editor — that arrived in
 * 4.3 — so this draws its own overlay and hands the geometry to the extension
 * host, which writes real `/Highlight` annotations into the file on save.
 *
 * Everything is measured in PDF user space, not pixels. A highlight recorded in
 * screen coordinates would be wrong the moment the page is zoomed or rotated,
 * and wrong again in the saved file. Converting once, at the moment of
 * selection, means the overlay is reprojected from the same numbers that end up
 * in the PDF.
 */

'use strict';

(function () {
  /** Highlights not yet written to the file, in PDF user space. */
  let pending = [];
  let active = false;
  /** Yellow unless the user configured otherwise; a highlighter is yellow. */
  let defaultColor = '#ffd400';

  function api() {
    return window.__pdfTranslateVsCode;
  }

  function post(message) {
    const vscode = api();
    if (vscode) {
      vscode.postMessage(message);
    }
  }

  function app() {
    return window.PDFViewerApplication;
  }

  /* ---------------------------------------------------------------- *
   * Styles
   * ---------------------------------------------------------------- */

  const STYLES = `
.pt-hl-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /*
   * No z-index here, deliberately. Absolute positioning alone does not create
   * a stacking context, but adding a z-index does — and a blended element only
   * blends with the backdrop inside its own stacking context. With a z-index
   * the layer isolated its children from the page canvas below, so multiply
   * had nothing to multiply against and painted flat opaque yellow over the
   * text. DOM order already puts this layer above the canvas.
   */
}
.pt-hl {
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 1px;
  /*
   * Multiply is what makes a highlighter look like a highlighter: the ink
   * darkens the page rather than covering it, so black text stays black.
   * The colour also carries alpha, so if blending is ever unavailable the
   * text still shows through instead of disappearing.
   */
  mix-blend-mode: multiply;
}
.pt-hl:hover {
  outline: 1px solid rgba(0, 0, 0, 0.45);
}
`;

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /**
   * `#rrggbb` as an `rgba()` with the given alpha.
   *
   * Belt and braces against the highlight hiding the text: multiply already
   * keeps it readable, and the alpha keeps it readable even if the blend does
   * not take effect. Only the overlay is drawn this way — the annotation
   * written into the file carries the pure colour, which is what other readers
   * expect.
   */
  function withAlpha(color, alpha) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
    const hex = match ? match[1] : 'ffd400';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  /* ---------------------------------------------------------------- *
   * Geometry
   * ---------------------------------------------------------------- */

  /**
   * The page a client rectangle sits on, found by its centre so that a
   * rectangle straddling a page gap is attributed to one page rather than
   * neither.
   */
  function pageAt(x, y) {
    const application = app();
    if (!application || !application.pdfViewer) {
      return null;
    }
    const layers = document.querySelectorAll('.page .textLayer');
    for (let i = 0; i < layers.length; i++) {
      const box = layers[i].getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const pageDiv = layers[i].closest('.page');
        const number = parseInt(pageDiv.getAttribute('data-page-number'), 10);
        const view = application.pdfViewer.getPageView(number - 1);
        if (view && view.viewport) {
          return { index: number - 1, viewport: view.viewport, box: box };
        }
      }
    }
    return null;
  }

  /**
   * Merge the many rectangles a selection produces — one per text span — into
   * one bar per line.
   *
   * Without this a highlighted sentence is a row of adjacent boxes with visible
   * seams between them, and the saved annotation carries dozens of quads where
   * a handful would do.
   */
  function mergeIntoLines(rects) {
    const sorted = rects.slice().sort(function (a, b) {
      return a[1] - b[1] || a[0] - b[0];
    });
    const lines = [];

    for (const rect of sorted) {
      const height = rect[3] - rect[1];
      const previous = lines[lines.length - 1];
      // Two fragments are on the same line when their vertical extents overlap
      // by most of a line's height; a tolerance in absolute pixels would be
      // wrong at a different zoom level.
      const sameLine =
        previous &&
        Math.abs(previous[1] - rect[1]) < height * 0.5 &&
        Math.abs(previous[3] - rect[3]) < height * 0.5;

      if (sameLine) {
        previous[0] = Math.min(previous[0], rect[0]);
        previous[1] = Math.min(previous[1], rect[1]);
        previous[2] = Math.max(previous[2], rect[2]);
        previous[3] = Math.max(previous[3], rect[3]);
      } else {
        lines.push(rect.slice());
      }
    }
    return lines;
  }

  /**
   * Turn the current selection into highlights, one per page it covers, with
   * every rectangle converted to PDF user space.
   */
  function highlightsFromSelection(selection, color) {
    const byPage = new Map();

    for (let r = 0; r < selection.rangeCount; r++) {
      const rects = selection.getRangeAt(r).getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        // Zero-area rectangles come from collapsed spans and empty text nodes.
        if (rect.width < 0.5 || rect.height < 0.5) {
          continue;
        }
        const page = pageAt(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        if (!page) {
          continue;
        }
        if (!byPage.has(page.index)) {
          byPage.set(page.index, { page: page, rects: [] });
        }
        // The text layer is inset-zero within the page, so its box origin is
        // exactly viewport (0, 0) — no border arithmetic needed.
        byPage.get(page.index).rects.push([
          rect.left - page.box.left,
          rect.top - page.box.top,
          rect.right - page.box.left,
          rect.bottom - page.box.top,
        ]);
      }
    }

    const result = [];
    byPage.forEach(function (entry) {
      const viewport = entry.page.viewport;
      const pdfRects = mergeIntoLines(entry.rects).map(function (rect) {
        const topLeft = viewport.convertToPdfPoint(rect[0], rect[1]);
        const bottomRight = viewport.convertToPdfPoint(rect[2], rect[3]);
        return [
          Math.min(topLeft[0], bottomRight[0]),
          Math.min(topLeft[1], bottomRight[1]),
          Math.max(topLeft[0], bottomRight[0]),
          Math.max(topLeft[1], bottomRight[1]),
        ];
      });
      if (pdfRects.length > 0) {
        result.push({
          page: entry.page.index,
          rects: pdfRects,
          color: color,
          text: selection.toString().trim().slice(0, 500),
        });
      }
    });
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function renderPage(pageIndex) {
    const application = app();
    if (!application || !application.pdfViewer) {
      return;
    }
    const view = application.pdfViewer.getPageView(pageIndex);
    if (!view || !view.div || !view.viewport) {
      return;
    }

    const existing = view.div.querySelector('.pt-hl-layer');
    if (existing) {
      existing.remove();
    }

    const mine = pending.filter(function (h) {
      return h.page === pageIndex;
    });
    if (mine.length === 0) {
      return;
    }

    const layer = document.createElement('div');
    layer.className = 'pt-hl-layer';
    const viewport = view.viewport;

    mine.forEach(function (highlight) {
      highlight.rects.forEach(function (rect) {
        // PDF's origin is bottom-left, the viewport's is top-left, so the
        // corners swap: the PDF top edge is the viewport's smaller y.
        const a = viewport.convertToViewportPoint(rect[0], rect[3]);
        const b = viewport.convertToViewportPoint(rect[2], rect[1]);

        const box = document.createElement('div');
        box.className = 'pt-hl';
        box.style.left = Math.min(a[0], b[0]) + 'px';
        box.style.top = Math.min(a[1], b[1]) + 'px';
        box.style.width = Math.abs(b[0] - a[0]) + 'px';
        box.style.height = Math.abs(b[1] - a[1]) + 'px';
        box.style.background = withAlpha(highlight.color, 0.45);
        box.title = 'Click to remove this highlight (before saving)';
        box.addEventListener('click', function (event) {
          event.stopPropagation();
          remove(highlight);
        });
        layer.appendChild(box);
      });
    });

    view.div.appendChild(layer);
  }

  function renderAll() {
    const seen = new Set();
    pending.forEach(function (h) {
      seen.add(h.page);
    });
    seen.forEach(renderPage);
  }

  /* ---------------------------------------------------------------- *
   * Mutating
   * ---------------------------------------------------------------- */

  function publish() {
    post({ type: 'highlights', highlights: pending });
  }

  /**
   * Undo history for highlights.
   *
   * PDF.js keeps its own history for the text boxes and drawings it owns, and
   * that history is behind a private field — it cannot be merged with this
   * one. So highlights keep their own, and lib/undo.js decides which of the
   * two a given Ctrl+Z belongs to.
   *
   * One selection is one entry, however many lines or pages it covered: the
   * user made one gesture and expects one undo to take it back.
   */
  const undoStack = [];
  const redoStack = [];

  function applyAdd(highlights) {
    pending = pending.concat(highlights);
    renderAll();
    publish();
    post({ type: 'edited' });
  }

  function applyRemove(highlights) {
    pending = pending.filter(function (h) {
      return highlights.indexOf(h) === -1;
    });
    // Re-render every page the removal touched, not just the current one.
    const pages = new Set();
    highlights.forEach(function (h) {
      pages.add(h.page);
    });
    pages.forEach(renderPage);
    publish();
    post({ type: 'edited' });
  }

  /** Tell the undo coordinator an edit happened, so Ctrl+Z orders it right. */
  function recordEdit() {
    if (window.__pdfTranslateUndo) {
      window.__pdfTranslateUndo.recordHighlightEdit();
    }
  }

  function add(highlights) {
    if (highlights.length === 0) {
      return;
    }
    applyAdd(highlights);
    undoStack.push({ type: 'add', items: highlights });
    // A new edit ends the redo branch, as in any editor.
    redoStack.length = 0;
    recordEdit();
  }

  function remove(highlight) {
    if (pending.indexOf(highlight) === -1) {
      return;
    }
    applyRemove([highlight]);
    undoStack.push({ type: 'remove', items: [highlight] });
    redoStack.length = 0;
    recordEdit();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) {
      return false;
    }
    if (entry.type === 'add') {
      applyRemove(entry.items);
    } else {
      applyAdd(entry.items);
    }
    redoStack.push(entry);
    return true;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) {
      return false;
    }
    if (entry.type === 'add') {
      applyAdd(entry.items);
    } else {
      applyRemove(entry.items);
    }
    undoStack.push(entry);
    return true;
  }

  /** Called once the host has written the pending highlights into the file. */
  function onSaved() {
    // The file now contains them as real annotations, and on the next load
    // PDF.js draws them itself. Keeping the overlay too would double the ink.
    pending = [];
    // The history goes with them: undoing a highlight that is already written
    // into the file would remove the overlay and leave the annotation behind.
    undoStack.length = 0;
    redoStack.length = 0;
    document.querySelectorAll('.pt-hl-layer').forEach(function (layer) {
      layer.remove();
    });
    publish();
  }

  /* ---------------------------------------------------------------- *
   * Toolbar
   * ---------------------------------------------------------------- */

  function currentColor() {
    const input = document.getElementById('pdfTranslateHighlightColor');
    return input && input.value ? input.value : defaultColor;
  }

  /**
   * Highlight mode is one tool among several, and the toolbar owns which one is
   * active — so this only reports and obeys, and does not toggle itself.
   */
  function setActive(value) {
    active = value;
    const picker = document.getElementById('pdfTranslateHighlightColor');
    if (picker) {
      picker.hidden = !active;
    }
  }

  function onMouseUp() {
    if (!active) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      return;
    }
    add(highlightsFromSelection(selection, currentColor()));
    // Leaving the selection in place would re-highlight the same text on the
    // next click anywhere in the document.
    selection.removeAllRanges();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function onMessage(event) {
    const message = event.data;
    if (!message) {
      return;
    }
    if (message.type === 'saved') {
      onSaved();
    }
  }

  function loadDefaultColour() {
    const element = document.getElementById('pdf-preview-config');
    if (!element) {
      return;
    }
    try {
      const config = JSON.parse(element.getAttribute('data-config'));
      if (config.highlightColor) {
        defaultColor = config.highlightColor;
      }
    } catch (error) {
      // Keep yellow.
    }
    const picker = document.getElementById('pdfTranslateHighlightColor');
    if (picker) {
      picker.value = defaultColor;
    }
  }

  function initialise() {
    installStyles();
    window.addEventListener('message', onMessage);
    loadDefaultColour();

    // The toolbar decides which tool is active; this is how it says so.
    window.__pdfTranslateHighlight = {
      setActive: setActive,
      isActive: function () {
        return active;
      },
      undo: undo,
      redo: redo,
      canUndo: function () {
        return undoStack.length > 0;
      },
      canRedo: function () {
        return redoStack.length > 0;
      },
    };
    setActive(false);

    document.addEventListener('mouseup', onMouseUp);

    const application = app();
    if (!application || !application.initializedPromise) {
      return;
    }
    application.initializedPromise.then(function () {
      // A page is re-rendered on zoom, rotation and when it scrolls back into
      // view, and each time the overlay is thrown away with it.
      application.eventBus.on('pagerendered', function (event) {
        renderPage(event.pageNumber - 1);
      });
      application.eventBus.on('scalechanging', renderAll);
      application.eventBus.on('rotationchanging', renderAll);
      // A reload replaces the document; anything unsaved belonged to the old
      // one and its coordinates may mean nothing in the new.
      application.eventBus.on('documentloaded', function () {
        pending = [];
        undoStack.length = 0;
        redoStack.length = 0;
        publish();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
