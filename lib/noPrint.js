/*
 * Keep printing out of the way of VS Code's keyboard.
 *
 * A webview is a Chromium frame, and Chromium claims Ctrl+P for its print
 * preview and Ctrl+Shift+P for the system print dialog. In a browser that is
 * reasonable; inside an editor it is not, because Ctrl+Shift+P is how VS Code
 * opens the Command Palette. Pressing it over a PDF opened a print dialog
 * instead.
 *
 * The fix is to cancel the browser's default action and nothing else. Calling
 * preventDefault() stops Chromium printing; deliberately *not* calling
 * stopPropagation() leaves the keystroke travelling on to VS Code's own
 * handler, which is what opens the Command Palette. Swallowing the event
 * entirely would trade one broken shortcut for another.
 *
 * This viewer has no print feature of its own to lose: upstream already hides
 * the print buttons, because its own viewer is read-only.
 */

'use strict';

(function () {
  function onKeyDown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    if (String(event.key || '').toLowerCase() !== 'p') {
      return;
    }
    // Cancel Chromium's print, and let the keystroke continue to VS Code.
    event.preventDefault();
  }

  function initialise() {
    // Capture phase, so this runs before anything in the page can act on it.
    window.addEventListener('keydown', onKeyDown, true);

    const app = window.PDFViewerApplication;
    if (!app || !app.initializedPromise) {
      return;
    }
    app.initializedPromise.then(function () {
      // Belt and braces: if anything else ever reaches for printing — a menu
      // item, a stray shortcut — it finds a door that does not open, rather
      // than a half-built print job.
      app.triggerPrinting = function () {};
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
