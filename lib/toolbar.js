/*
 * One exclusive tool group: Hand, Select, Highlight, Typewriter, Draw.
 *
 * PDF.js keeps these in two unrelated systems — cursor tools (hand and select)
 * and annotation editor modes (free text and ink) — and highlighting is this
 * fork's own third thing. Left alone they overlap: the hand tool stays "on"
 * while the typewriter is active, and nothing says which one the click will
 * actually do.
 *
 * A reader expects what Foxit and every other PDF tool does: exactly one tool
 * at a time. This file is the single place that decides which, and translates
 * that decision into whichever of the three systems needs telling.
 */

'use strict';

(function () {
  /** PDF.js's own enumerations, which are not exported to the page. */
  const CURSOR_SELECT = 0;
  const CURSOR_HAND = 1;
  const EDITOR_NONE = 0;
  const EDITOR_FREETEXT = 3;
  const EDITOR_INK = 15;

  const HAND = 'hand';
  const SELECT = 'select';
  const HIGHLIGHT = 'highlight';
  const TYPEWRITER = 'typewriter';
  const DRAW = 'draw';

  let current = SELECT;
  /** Set while this file is the one changing PDF.js, to ignore its echo. */
  let applying = false;

  function app() {
    return window.PDFViewerApplication;
  }

  function highlighter() {
    return window.__pdfTranslateHighlight;
  }

  /* ---------------------------------------------------------------- *
   * Styles
   * ---------------------------------------------------------------- */

  /*
   * PDF.js draws button icons as a CSS mask over a themed background colour,
   * so its own icons are reused through the same custom properties. Highlight
   * has no icon in 3.1.81, so one is inlined — a marker nib over a stroke.
   */
  const STYLES = `
#pdfTranslateHand::before {
  -webkit-mask-image: var(--secondaryToolbarButton-handTool-icon);
          mask-image: var(--secondaryToolbarButton-handTool-icon);
}
#pdfTranslateSelect::before {
  -webkit-mask-image: var(--secondaryToolbarButton-selectTool-icon);
          mask-image: var(--secondaryToolbarButton-selectTool-icon);
}
#pdfTranslateHighlight::before {
  -webkit-mask-image: var(--pdfTranslate-highlight-icon);
          mask-image: var(--pdfTranslate-highlight-icon);
}
:root {
  --pdfTranslate-highlight-icon: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.6 1.6a1.4 1.4 0 0 1 2 0l1.8 1.8a1.4 1.4 0 0 1 0 2l-6 6-3.8-3.8 6-6z'/%3E%3Cpath d='M4.1 8.2 7.8 12l-1.3 1.3H3.2l-1.1 1.1-1-1 1.1-1.1V9.4l1.9-1.2z'/%3E%3C/svg%3E");
}
#pdfTranslateHighlightColor {
  width: 28px;
  height: 22px;
  margin: 3px 2px 0;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  vertical-align: top;
}
`;

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------- *
   * Applying a tool
   * ---------------------------------------------------------------- */

  function setCursorTool(tool) {
    const application = app();
    if (application && application.pdfCursorTools) {
      application.pdfCursorTools.switchTool(tool);
    }
  }

  function setEditorMode(mode) {
    const application = app();
    if (!application || !application.eventBus) {
      return;
    }
    // Going through the event bus rather than the property keeps PDF.js's own
    // buttons in step: they listen for the same event this dispatches.
    application.eventBus.dispatch('switchannotationeditormode', {
      source: window,
      mode: mode,
    });
  }

  function setTool(tool) {
    current = tool;
    applying = true;
    try {
      const highlight = highlighter();
      if (highlight) {
        highlight.setActive(tool === HIGHLIGHT);
      }

      if (tool === TYPEWRITER) {
        setEditorMode(EDITOR_FREETEXT);
      } else if (tool === DRAW) {
        setEditorMode(EDITOR_INK);
      } else {
        setEditorMode(EDITOR_NONE);
        // Highlighting needs a text selection, so it rides on the select tool.
        setCursorTool(tool === HAND ? CURSOR_HAND : CURSOR_SELECT);
      }
    } finally {
      applying = false;
    }
    paint();
  }

  /* ---------------------------------------------------------------- *
   * Reflecting the state in the buttons
   * ---------------------------------------------------------------- */

  const BUTTONS = [
    { tool: HAND, id: 'pdfTranslateHand' },
    { tool: SELECT, id: 'pdfTranslateSelect' },
    { tool: HIGHLIGHT, id: 'pdfTranslateHighlight' },
    { tool: TYPEWRITER, id: 'editorFreeText' },
    { tool: DRAW, id: 'editorInk' },
  ];

  function paint() {
    BUTTONS.forEach(function (entry) {
      const button = document.getElementById(entry.id);
      if (!button) {
        return;
      }
      const on = entry.tool === current;
      button.classList.toggle('toggled', on);
      button.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function initialise() {
    installStyles();

    // Hand, Select and Highlight are this fork's buttons, so they are wired
    // here. Typewriter and Draw are PDF.js's own and already dispatch the mode
    // change themselves; adding a second handler would toggle it straight back
    // off. Their state is picked up from the event instead.
    [
      { tool: HAND, id: 'pdfTranslateHand' },
      { tool: SELECT, id: 'pdfTranslateSelect' },
      { tool: HIGHLIGHT, id: 'pdfTranslateHighlight' },
    ].forEach(function (entry) {
      const button = document.getElementById(entry.id);
      if (button) {
        button.addEventListener('click', function () {
          setTool(entry.tool);
        });
      }
    });

    const application = app();
    if (!application || !application.initializedPromise) {
      return;
    }

    application.initializedPromise.then(function () {
      application.eventBus.on('annotationeditormodechanged', function (event) {
        if (applying) {
          return;
        }
        // The user reached for PDF.js's own Text or Draw button. Follow it, so
        // that Highlight switches off rather than staying armed underneath.
        if (event.mode === EDITOR_FREETEXT) {
          setTool(TYPEWRITER);
        } else if (event.mode === EDITOR_INK) {
          setTool(DRAW);
        } else if (current === TYPEWRITER || current === DRAW) {
          setTool(SELECT);
        }
      });

      application.eventBus.on('cursortoolchanged', function (event) {
        if (applying) {
          return;
        }
        // Presentation mode and the secondary toolbar also switch the cursor.
        setTool(event.tool === CURSOR_HAND ? HAND : SELECT);
      });

      // Start on whichever cursor tool the settings asked for, so the toolbar
      // agrees with the viewer from the first frame.
      const configured =
        application.pdfCursorTools && application.pdfCursorTools.activeTool;
      current = configured === CURSOR_HAND ? HAND : SELECT;
      paint();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
