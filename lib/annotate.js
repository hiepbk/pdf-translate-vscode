/*
 * Annotation editing: the webview half.
 *
 * PDF.js already ships the text-box and freehand editors and can write them
 * back into a PDF; upstream simply hides them, because its viewer is read-only.
 * All this file does is turn them on and connect two wires to the extension
 * host:
 *
 *   annotations changed  -> "edited"            (VS Code marks the tab dirty)
 *   host asks for bytes  -> "annotated-pdf"     (VS Code writes them to disk)
 *
 * Kept out of translate.js because the two features share nothing, and out of
 * PDF.js's own files so that upgrading the bundle never touches it.
 */

'use strict';

(function () {
  /*
   * translate.js owns the single acquireVsCodeApi() handle — calling it twice
   * throws — so it hands the handle over on the window instead.
   */
  function api() {
    return window.__pdfTranslateVsCode;
  }

  function post(message) {
    const vscode = api();
    if (vscode) {
      vscode.postMessage(message);
    }
  }

  /* ---------------------------------------------------------------- *
   * Dirty tracking
   * ---------------------------------------------------------------- */

  /**
   * PDF.js reports edits through two callbacks on its annotation storage
   * rather than through the event bus, so they are the hook. They are
   * assignments, not listeners, so re-attaching on every document load is both
   * necessary and safe.
   */
  function watchForEdits(pdfDocument) {
    const storage = pdfDocument && pdfDocument.annotationStorage;
    if (!storage) {
      return;
    }

    storage.onSetModified = function () {
      post({ type: 'edited' });
    };
    // onResetModified fires when we ourselves clear the flag after a save, so
    // it deliberately reports nothing: the host already knows.
    storage.onResetModified = function () {};
  }

  /**
   * Put the Text and Draw buttons back in step with the viewer.
   *
   * PDF.js disables them on `toolbarreset` and re-enables them when it
   * announces the editor mode. This fork loads the document twice — `open()`
   * for initialisation, then `load()` with a second document object to
   * preserve the scroll position across reloads — so the reset can arrive
   * last and leave the buttons disabled over a perfectly editable document.
   * Re-announcing the current mode uses PDF.js's own mechanism to fix that,
   * rather than reaching in and clearing `disabled` behind its back.
   */
  function enableEditorButtons(app) {
    if (!app.pdfViewer || !app.eventBus) {
      return;
    }
    app.eventBus.dispatch('annotationeditormodechanged', {
      source: app.pdfViewer,
      mode: app.pdfViewer.annotationEditorMode,
    });
  }

  /* ---------------------------------------------------------------- *
   * Saving
   * ---------------------------------------------------------------- */

  /**
   * A webview message is JSON, so raw bytes cannot cross it: a Uint8Array would
   * arrive as an object with one numbered key per byte. Base64 costs a third
   * more characters and survives intact.
   */
  function toBase64(bytes) {
    let binary = '';
    // String.fromCharCode.apply blows the argument limit somewhere above ~100k
    // arguments, and a PDF is far larger, so it is fed in slices.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK)
      );
    }
    return btoa(binary);
  }

  async function sendAnnotatedPdf(id) {
    try {
      const app = window.PDFViewerApplication;
      if (!app || !app.pdfDocument) {
        throw new Error('The document is not loaded yet.');
      }

      // saveDocument() serialises the annotation storage into a real PDF, so
      // the text boxes and drawings are readable in any other PDF reader.
      const data = await app.pdfDocument.saveDocument();
      post({ type: 'annotated-pdf', id: id, ok: true, data: toBase64(data) });
    } catch (error) {
      post({
        type: 'annotated-pdf',
        id: id,
        ok: false,
        error: (error && error.message) || String(error),
      });
    }
  }

  function markSaved() {
    const app = window.PDFViewerApplication;
    if (app && app.pdfDocument && app.pdfDocument.annotationStorage) {
      // Without this the storage stays "modified", and the next edit would not
      // fire onSetModified again — leaving the tab clean while it is dirty.
      app.pdfDocument.annotationStorage.resetModified();
    }
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function onMessage(event) {
    const message = event.data;
    if (!message) {
      return;
    }
    if (message.type === 'get-annotated-pdf') {
      sendAnnotatedPdf(message.id);
    } else if (message.type === 'saved') {
      markSaved();
    }
  }

  function initialise() {
    window.addEventListener('message', onMessage);

    const app = window.PDFViewerApplication;
    if (!app || !app.initializedPromise) {
      return;
    }

    app.initializedPromise.then(function () {
      // A reload replaces the document, and with it the annotation storage,
      // so the hooks are attached per document rather than once.
      app.eventBus.on('documentloaded', function () {
        watchForEdits(app.pdfDocument);
        enableEditorButtons(app);
      });

      // Ctrl+S inside the webview never reaches VS Code's keybinding layer, so
      // it is forwarded. Without this, saving would only work when focus
      // happened to be outside the PDF.
      window.addEventListener(
        'keydown',
        function (event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            post({ type: 'request-save' });
          }
        },
        true
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
