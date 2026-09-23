/*
 * One Ctrl+Z for every kind of edit.
 *
 * There are two histories and they cannot be merged. PDF.js keeps its own for
 * the text boxes and freehand strokes it owns, behind a private field, and
 * exposes only undo() and redo() on the manager. Highlights are this fork's,
 * with their own stack in highlight.js. Left alone, each responds to Ctrl+Z
 * only when focus happens to be in the right place, so an edit could look
 * un-undoable purely because the caret was somewhere else.
 *
 * This file owns the keystroke instead, and keeps a running order of which
 * history performed each edit, so Ctrl+Z always takes back the most recent one
 * whichever system made it.
 */

'use strict';

(function () {
  /**
   * The order edits happened in: 'pdfjs' or 'highlight' per entry.
   *
   * PDF.js's edit count cannot be read, only whether it has anything left to
   * undo, so a marker is pushed on every state event that reports something
   * undoable. That over-counts — one edit can raise several events — and the
   * surplus is harmless: an undo that finds PDF.js with nothing left simply
   * drops the marker and moves on to the next entry. Under-counting is what
   * would lose an edit, and pushing on every event cannot under-count.
   */
  const past = [];
  const future = [];

  /** PDF.js's AnnotationEditorUIManager, taken from its own event. */
  let manager = null;
  let pdfjsCanUndo = false;
  let pdfjsCanRedo = false;

  function highlighter() {
    return window.__pdfTranslateHighlight;
  }

  /* ---------------------------------------------------------------- *
   * Performing an undo or redo
   * ---------------------------------------------------------------- */

  function undoPdfjs() {
    if (!manager || !pdfjsCanUndo) {
      return false;
    }
    manager.undo();
    return true;
  }

  function redoPdfjs() {
    if (!manager || !pdfjsCanRedo) {
      return false;
    }
    manager.redo();
    return true;
  }

  function undoHighlight() {
    const highlight = highlighter();
    return !!(highlight && highlight.undo());
  }

  function redoHighlight() {
    const highlight = highlighter();
    return !!(highlight && highlight.redo());
  }

  function undo() {
    // Walk back until something actually undoes: surplus PDF.js markers are
    // dropped here rather than being allowed to swallow a keystroke.
    while (past.length > 0) {
      const entry = past.pop();
      const done = entry === 'pdfjs' ? undoPdfjs() : undoHighlight();
      if (done) {
        future.push(entry);
        return true;
      }
    }
    return false;
  }

  function redo() {
    while (future.length > 0) {
      const entry = future.pop();
      const done = entry === 'pdfjs' ? redoPdfjs() : redoHighlight();
      if (done) {
        past.push(entry);
        return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Recording edits
   * ---------------------------------------------------------------- */

  /** Called by highlight.js after it changes something. */
  function recordHighlightEdit() {
    past.push('highlight');
    future.length = 0;
  }

  /* ---------------------------------------------------------------- *
   * The keystroke
   * ---------------------------------------------------------------- */

  /**
   * Whether the keystroke belongs to a text field rather than to us.
   *
   * PDF.js's text boxes are contenteditable, and inside one Ctrl+Z means
   * "undo my typing" — the browser's own history, which is the right answer
   * and not one this file could reproduce.
   */
  function isEditingText(event) {
    const node = event.target && event.target.nodeType === 3
      ? event.target.parentElement
      : event.target;
    if (!node || !node.closest) {
      return false;
    }
    return !!node.closest('input, textarea, [contenteditable="true"]');
  }

  function onKeyDown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = String(event.key || '').toLowerCase();
    if (key !== 'z' && key !== 'y') {
      return;
    }
    if (isEditingText(event)) {
      return;
    }

    const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);

    // Taken in the capture phase and stopped here, so that PDF.js's own
    // shortcut does not run a second undo behind this one.
    event.preventDefault();
    event.stopPropagation();

    if (wantsRedo) {
      redo();
    } else {
      undo();
    }
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function initialise() {
    // Capture phase, on window: PDF.js listens on the editor layers, and the
    // point is to be the only handler that acts however focus is placed.
    window.addEventListener('keydown', onKeyDown, true);

    window.__pdfTranslateUndo = {
      recordHighlightEdit: recordHighlightEdit,
      undo: undo,
      redo: redo,
      depth: function () {
        return past.length;
      },
    };

    const app = window.PDFViewerApplication;
    if (!app || !app.initializedPromise) {
      return;
    }

    app.initializedPromise.then(function () {
      app.eventBus.on('annotationeditorstateschanged', function (event) {
        // The manager is not reachable any other way: PDF.js keeps it in a
        // private field and only hands it out as the source of this event.
        if (event.source) {
          manager = event.source;
        }
        const details = event.details || {};
        pdfjsCanUndo = !!details.hasSomethingToUndo;
        pdfjsCanRedo = !!details.hasSomethingToRedo;

        if (pdfjsCanUndo) {
          past.push('pdfjs');
          future.length = 0;
        }
      });

      app.eventBus.on('documentloaded', function () {
        past.length = 0;
        future.length = 0;
        pdfjsCanUndo = false;
        pdfjsCanRedo = false;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
