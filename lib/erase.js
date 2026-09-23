/*
 * The Erase tool: take an annotation off the page, whether it was made in this
 * session or found in the file.
 *
 * Three kinds of thing can be under the cursor, and each comes off a different
 * way:
 *
 *   - an unsaved highlight, which is this fork's own overlay;
 *   - an unsaved text box or drawing, which belongs to PDF.js's editor and is
 *     deleted through the editor itself;
 *   - an annotation already in the file, which PDF.js 3.1.81 cannot delete at
 *     all — its editors only ever create.
 *
 * The last case is the interesting one. PDF.js paints annotations into the page
 * canvas, so hiding the element in the annotation layer changes nothing. But
 * the worker asks `mustBeViewed(annotationStorage)` before drawing each one,
 * and that consults the storage for a `hidden` flag. Setting it and re-rendering
 * the page makes the annotation disappear without touching the file, which is
 * what lets an erase stay undoable until the document is saved.
 */

'use strict';

(function () {
  /** Ids of annotations erased but not yet written out of the file. */
  let erased = [];
  let active = false;

  function post(message) {
    const vscode = window.__pdfTranslateVsCode;
    if (vscode) {
      vscode.postMessage(message);
    }
  }

  function app() {
    return window.PDFViewerApplication;
  }

  /* ---------------------------------------------------------------- *
   * Finding what was clicked
   * ---------------------------------------------------------------- */

  /**
   * The page under a point, with the geometry needed to convert into PDF
   * coordinates. The text layer is inset-zero within the page, so its box is
   * exactly the viewport origin.
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
        if (view && view.viewport && view.pdfPage) {
          return { index: number - 1, view: view, box: box };
        }
      }
    }
    return null;
  }

  /** Whether a PDF-space point falls inside an annotation's rectangle. */
  function contains(rect, x, y) {
    if (!rect || rect.length < 4) {
      return false;
    }
    return (
      x >= Math.min(rect[0], rect[2]) &&
      x <= Math.max(rect[0], rect[2]) &&
      y >= Math.min(rect[1], rect[3]) &&
      y <= Math.max(rect[1], rect[3])
    );
  }

  /**
   * The annotation under a point, or null.
   *
   * Hit-testing on geometry rather than on the annotation layer's elements,
   * because those only exist for annotations PDF.js considers renderable — a
   * highlight with no contents has no element to click, and would be
   * un-erasable if the DOM were the only route to it. The last match wins, so
   * the annotation drawn on top is the one taken away.
   */
  async function annotationAt(page, x, y) {
    const annotations = await page.view.pdfPage.getAnnotations();
    let found = null;
    for (const annotation of annotations) {
      if (erased.indexOf(annotation.id) !== -1) {
        continue;
      }
      if (contains(annotation.rect, x, y)) {
        found = annotation;
      }
    }
    return found;
  }

  /* ---------------------------------------------------------------- *
   * Hiding and restoring
   * ---------------------------------------------------------------- */

  function storage() {
    const application = app();
    return application && application.pdfDocument
      ? application.pdfDocument.annotationStorage
      : null;
  }

  /**
   * Re-render one page so the worker is asked again which annotations to draw.
   *
   * The rendering cache is keyed partly on a hash of the annotation storage, so
   * changing the storage is enough to make this produce a different result
   * rather than the cached one.
   */
  function redraw(pageIndex) {
    const application = app();
    if (!application || !application.pdfViewer) {
      return;
    }
    const view = application.pdfViewer.getPageView(pageIndex);
    if (!view) {
      return;
    }
    view.reset();
    application.pdfViewer.update();
  }

  function setHidden(annotationId, pageIndex, hidden) {
    const store = storage();
    if (!store) {
      return;
    }
    store.setValue(annotationId, { hidden: hidden });
    redraw(pageIndex);
  }

  function publish() {
    post({ type: 'deleted-annotations', ids: erased });
  }

  function recordEdit() {
    if (window.__pdfTranslateUndo) {
      window.__pdfTranslateUndo.recordEraseEdit();
    }
  }

  /* ---------------------------------------------------------------- *
   * Erasing
   * ---------------------------------------------------------------- */

  const undoStack = [];
  const redoStack = [];

  function applyErase(entry) {
    erased.push(entry.id);
    setHidden(entry.id, entry.page, true);
    publish();
    post({ type: 'edited' });
  }

  function applyRestore(entry) {
    erased = erased.filter(function (id) {
      return id !== entry.id;
    });
    setHidden(entry.id, entry.page, false);
    publish();
    post({ type: 'edited' });
  }

  function erase(annotation, pageIndex) {
    const entry = { id: annotation.id, page: pageIndex };
    applyErase(entry);
    undoStack.push(entry);
    redoStack.length = 0;
    recordEdit();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) {
      return false;
    }
    applyRestore(entry);
    redoStack.push(entry);
    return true;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) {
      return false;
    }
    applyErase(entry);
    undoStack.push(entry);
    return true;
  }

  /** After a save the erasures are in the file; there is nothing to restore. */
  function onSaved() {
    erased = [];
    undoStack.length = 0;
    redoStack.length = 0;
    publish();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  async function onClick(event) {
    if (!active) {
      return;
    }

    // An unsaved highlight is this fork's own overlay and comes off through
    // the highlighter, which owns its undo history.
    const overlay =
      event.target && event.target.closest
        ? event.target.closest('.pt-hl')
        : null;
    if (overlay) {
      return; // highlight.js handles its own click.
    }

    const page = pageAt(event.clientX, event.clientY);
    if (!page) {
      return;
    }

    const point = page.view.viewport.convertToPdfPoint(
      event.clientX - page.box.left,
      event.clientY - page.box.top
    );

    const annotation = await annotationAt(page, point[0], point[1]);
    if (annotation) {
      event.preventDefault();
      event.stopPropagation();
      erase(annotation, page.index);
    }
  }

  function setActive(value) {
    active = value;
    const container = document.getElementById('viewerContainer');
    if (container) {
      // A crosshair says "this click removes something" before it happens.
      container.style.cursor = active ? 'crosshair' : '';
    }
  }

  function onMessage(event) {
    if (event.data && event.data.type === 'saved') {
      onSaved();
    }
  }

  function initialise() {
    window.addEventListener('message', onMessage);
    document.addEventListener('click', onClick, true);

    window.__pdfTranslateErase = {
      setActive: setActive,
      isActive: function () {
        return active;
      },
      undo: undo,
      redo: redo,
      canUndo: function () {
        return undoStack.length > 0;
      },
    };
    setActive(false);

    const application = app();
    if (!application || !application.initializedPromise) {
      return;
    }
    application.initializedPromise.then(function () {
      application.eventBus.on('documentloaded', function () {
        // A reload replaces the document, and the ids belonged to the old one.
        erased = [];
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
