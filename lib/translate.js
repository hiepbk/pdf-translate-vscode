/*
 * Selection -> context menu -> translation popup, inside the PDF.js webview.
 *
 * This file is the entire webview half of the translation feature. It is kept
 * separate from PDF.js's own (minified) viewer.js and from main.js so that
 * upgrading the bundled PDF.js, or merging from upstream, never touches it.
 *
 * It does no networking: a webview's content security policy restricts
 * `connect-src` to the webview origin, and the translation endpoints send no
 * CORS headers. Instead it posts a message to the extension host, which owns
 * the network call, and renders whatever comes back.
 */

'use strict';

(function () {
  const vscode = acquireVsCodeApi();

  /** Pending translate requests, keyed by the id sent to the extension host. */
  const pending = new Map();
  let requestCounter = 0;

  /**
   * Language state for the popup's pickers, seeded from settings and then owned
   * by the webview until the user asks to make a choice the new default.
   */
  const languages = {
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    sources: [],
    targets: [],
  };

  const AUTO_DETECT = 'auto';

  /**
   * What the settings currently say, as opposed to what the pickers are set to.
   * The difference is what decides whether "Set as default" is worth offering.
   */
  const savedLanguages = { sourceLanguage: 'auto', targetLanguage: 'vi' };

  function loadLanguageSettings() {
    const element = document.getElementById('pdf-preview-config');
    if (!element) {
      return;
    }
    try {
      const config = JSON.parse(element.getAttribute('data-config'));
      applyLanguageSettings(config.translate);
    } catch (error) {
      // Leave the defaults in place; the pickers still work, they just start
      // from `auto` and `vi` rather than from the user's settings.
    }
  }

  function applyLanguageSettings(incoming) {
    if (!incoming) {
      return;
    }
    languages.sourceLanguage = incoming.sourceLanguage || AUTO_DETECT;
    languages.targetLanguage = incoming.targetLanguage || 'vi';
    languages.sources = incoming.sources || [];
    languages.targets = incoming.targets || [];
    savedLanguages.sourceLanguage = languages.sourceLanguage;
    savedLanguages.targetLanguage = languages.targetLanguage;
  }

  /* ---------------------------------------------------------------- *
   * Styles
   * ---------------------------------------------------------------- */

  /*
   * VS Code injects its theme as `--vscode-*` custom properties on the webview
   * root, so the popup follows the user's colour theme for free. Each one has a
   * fallback for the rare case where the variable is missing.
   */
  const STYLES = `
.pt-menu {
  position: fixed;
  z-index: 100000;
  min-width: 190px;
  padding: 4px 0;
  border-radius: 5px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  background: var(--vscode-menu-background, #252526);
  color: var(--vscode-menu-foreground, #cccccc);
  border: 1px solid var(--vscode-menu-border, rgba(128, 128, 128, 0.35));
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.36);
  user-select: none;
}
.pt-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 5px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.pt-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, #04395e);
  color: var(--vscode-menu-selectionForeground, #ffffff);
}
.pt-menu-item[aria-disabled='true'] {
  opacity: 0.45;
  cursor: default;
}
.pt-menu-item[aria-disabled='true']:hover {
  background: transparent;
  color: var(--vscode-menu-foreground, #cccccc);
}
.pt-menu-hint {
  font-size: 0.85em;
  opacity: 0.6;
}
.pt-menu-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));
}

.pt-popup {
  position: fixed;
  z-index: 100001;
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: calc(100vw - 24px);
  max-height: 60vh;
  border-radius: 6px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editorWidget-foreground, #cccccc);
  border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35));
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}
.pt-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: move;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.3));
}
.pt-popup-title {
  flex: 1;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pt-popup-meta {
  font-weight: 400;
  opacity: 0.65;
}
.pt-langbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.3));
}
.pt-select {
  flex: 1;
  min-width: 0;
  padding: 3px 5px;
  border-radius: 3px;
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-dropdown-background, #3c3c3c);
  color: var(--vscode-dropdown-foreground, #f0f0f0);
  border: 1px solid var(--vscode-dropdown-border, rgba(128, 128, 128, 0.35));
}
.pt-swap {
  flex: none;
  width: 26px;
  padding: 3px 0;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  font-size: 1.05em;
  line-height: 1;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
}
.pt-swap:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
.pt-popup-body {
  padding: 10px 12px;
  overflow-y: auto;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  user-select: text;
  cursor: text;
}
.pt-popup-original {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.3));
  opacity: 0.72;
  font-size: 0.94em;
}
.pt-popup-original > summary {
  cursor: pointer;
  opacity: 0.85;
  margin-bottom: 6px;
  user-select: none;
}
.pt-popup-footer {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.3));
}
.pt-button {
  padding: 4px 11px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
}
.pt-button:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
.pt-button-primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
.pt-button-primary:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.pt-spacer {
  flex: 1;
}
.pt-error {
  color: var(--vscode-errorForeground, #f48771);
}
.pt-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 7px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: pt-spin 0.7s linear infinite;
}
@keyframes pt-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .pt-spinner { animation-duration: 3s; }
}
`;

  function installStyles() {
    const style = document.createElement('style');
    style.id = 'pt-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------- *
   * Selection
   * ---------------------------------------------------------------- */

  /**
   * The current selection, or null. The text is returned raw: cleaning happens
   * in the extension host so that the rules live in one place and can be unit
   * tested outside the webview.
   */
  /**
   * `Element.closest` on an event target, tolerating the text nodes that some
   * events report.
   */
  function closestMatch(target, selector) {
    const element =
      target && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    return element && element.closest ? element.closest(selector) : null;
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const text = selection.toString();
    if (!text.trim()) {
      return null;
    }
    return { text: text, rect: selection.getRangeAt(0).getBoundingClientRect() };
  }

  /* ---------------------------------------------------------------- *
   * Context menu
   * ---------------------------------------------------------------- */

  let openMenu = null;

  function closeMenu() {
    if (openMenu && openMenu.parentNode) {
      openMenu.parentNode.removeChild(openMenu);
    }
    openMenu = null;
  }

  function addMenuItem(menu, label, hint, enabled, onActivate) {
    const item = document.createElement('div');
    item.className = 'pt-menu-item';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-disabled', enabled ? 'false' : 'true');

    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);

    if (hint) {
      const hintNode = document.createElement('span');
      hintNode.className = 'pt-menu-hint';
      hintNode.textContent = hint;
      item.appendChild(hintNode);
    }

    if (enabled) {
      // mousedown rather than click: the browser clears the selection on
      // mouseup in some cases, and the handlers need the selection intact.
      item.addEventListener('mousedown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        onActivate();
      });
    }

    menu.appendChild(item);
    return item;
  }

  function showMenu(x, y, selectionInfo) {
    closeMenu();

    const menu = document.createElement('div');
    menu.className = 'pt-menu';
    menu.setAttribute('role', 'menu');

    const hasSelection = selectionInfo !== null;
    const selectedText = hasSelection ? selectionInfo.text : '';

    addMenuItem(menu, 'Copy', 'Ctrl+C', hasSelection, function () {
      vscode.postMessage({ type: 'copy', text: selectedText });
    });

    addMenuItem(menu, 'Copy cleaned text', '', hasSelection, function () {
      vscode.postMessage({ type: 'copy-cleaned', text: selectedText });
    });

    const separator = document.createElement('div');
    separator.className = 'pt-menu-separator';
    menu.appendChild(separator);

    addMenuItem(menu, 'Translate', 'Alt+T', hasSelection, function () {
      requestTranslation(selectionInfo);
    });

    // Keep the menu inside the viewport: position it off-screen first so the
    // real size can be measured, then correct.
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);

    const bounds = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - bounds.width - 6);
    const top = Math.min(y, window.innerHeight - bounds.height - 6);
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';

    openMenu = menu;
  }

  /* ---------------------------------------------------------------- *
   * Popup
   * ---------------------------------------------------------------- */

  let openPopup = null;

  function closePopup() {
    if (openPopup && openPopup.root.parentNode) {
      openPopup.root.parentNode.removeChild(openPopup.root);
    }
    openPopup = null;
  }

  /**
   * Place the popup just under the selection, flipping above it when there is
   * no room below, so that it never covers the text being read.
   */
  function positionNearSelection(root, rect) {
    const bounds = root.getBoundingClientRect();
    const gap = 8;

    let top = rect.bottom + gap;
    if (top + bounds.height > window.innerHeight - gap) {
      const above = rect.top - bounds.height - gap;
      top = above >= gap ? above : Math.max(gap, window.innerHeight - bounds.height - gap);
    }

    let left = rect.left;
    if (left + bounds.width > window.innerWidth - gap) {
      left = window.innerWidth - bounds.width - gap;
    }

    root.style.left = Math.max(gap, left) + 'px';
    root.style.top = Math.max(gap, top) + 'px';
  }

  function makeDraggable(root, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', function (event) {
      // Ignore drags that start on a button inside the header.
      if (closestMatch(event.target, 'button')) {
        return;
      }
      dragging = true;
      const bounds = root.getBoundingClientRect();
      offsetX = event.clientX - bounds.left;
      offsetY = event.clientY - bounds.top;
      event.preventDefault();
    });

    document.addEventListener('mousemove', function (event) {
      if (!dragging) {
        return;
      }
      root.style.left = event.clientX - offsetX + 'px';
      root.style.top = event.clientY - offsetY + 'px';
    });

    document.addEventListener('mouseup', function () {
      dragging = false;
    });
  }

  /**
   * A `<select>` of languages. `extra` prepends an option that is not a real
   * language, which is how Auto-detect is offered on the source side only.
   */
  function buildLanguageSelect(options, selected, extra) {
    const select = document.createElement('select');
    select.className = 'pt-select';

    const all = extra ? [extra].concat(options) : options;
    all.forEach(function (option) {
      const node = document.createElement('option');
      node.value = option.code;
      node.textContent = option.name;
      if (option.code === selected) {
        node.selected = true;
      }
      select.appendChild(node);
    });

    // A select that is not in the list (a code typed into settings by hand)
    // would otherwise silently show the first entry instead.
    if (select.value !== selected) {
      const node = document.createElement('option');
      node.value = selected;
      node.textContent = selected;
      node.selected = true;
      select.insertBefore(node, select.firstChild);
    }

    return select;
  }

  /**
   * Source and target pickers with a swap between them. Changing either one
   * re-translates the same passage immediately, so trying another language is
   * one click rather than a trip through the settings editor.
   */
  function buildLanguageBar() {
    const bar = document.createElement('div');
    bar.className = 'pt-langbar';

    const source = buildLanguageSelect(
      languages.sources,
      languages.sourceLanguage,
      { code: AUTO_DETECT, name: 'Auto-detect' }
    );
    source.title = 'Language of the PDF';

    const swap = document.createElement('button');
    swap.className = 'pt-swap';
    swap.type = 'button';
    swap.textContent = '⇄';
    swap.title = 'Swap source and target';

    const target = buildLanguageSelect(
      languages.targets,
      languages.targetLanguage,
      null
    );
    target.title = 'Language to translate into';

    bar.appendChild(source);
    bar.appendChild(swap);
    bar.appendChild(target);

    function retranslate() {
      languages.sourceLanguage = source.value;
      languages.targetLanguage = target.value;
      if (openPopup && openPopup.sourceText) {
        translateInPlace(openPopup, openPopup.sourceText);
      }
    }

    source.addEventListener('change', retranslate);
    target.addEventListener('change', retranslate);

    swap.addEventListener('click', function () {
      // Swapping out of Auto-detect needs a concrete language, and the only one
      // available is whatever the last translation actually detected.
      const from =
        source.value === AUTO_DETECT
          ? openPopup && openPopup.detectedSourceLanguage
          : source.value;
      if (!from) {
        return;
      }
      const to = target.value;
      // The old source may be missing from the target list, and vice versa.
      if (!setSelectValue(target, from) || !setSelectValue(source, to)) {
        return;
      }
      retranslate();
    });

    return { root: bar, source: source, target: target };
  }

  function setSelectValue(select, value) {
    select.value = value;
    return select.value === value;
  }

  function createPopup(rect) {
    closePopup();

    const root = document.createElement('div');
    root.className = 'pt-popup';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Translation');

    const header = document.createElement('div');
    header.className = 'pt-popup-header';

    const title = document.createElement('div');
    title.className = 'pt-popup-title';
    title.textContent = 'Translation';
    header.appendChild(title);

    const close = document.createElement('button');
    close.className = 'pt-button';
    close.textContent = 'Close';
    close.addEventListener('click', closePopup);
    header.appendChild(close);

    const langbar = buildLanguageBar();

    const body = document.createElement('div');
    body.className = 'pt-popup-body';

    const footer = document.createElement('div');
    footer.className = 'pt-popup-footer';

    root.appendChild(header);
    root.appendChild(langbar.root);
    root.appendChild(body);
    root.appendChild(footer);

    // Clicks inside the popup must not reach the dismiss handler on document.
    root.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });

    root.style.left = '-9999px';
    root.style.top = '-9999px';
    document.body.appendChild(root);
    positionNearSelection(root, rect);
    makeDraggable(root, header);

    openPopup = {
      root: root,
      title: title,
      body: body,
      footer: footer,
      rect: rect,
      langbar: langbar,
      // The selection this popup is showing, kept so that changing a language
      // can re-translate it without the user selecting the text again.
      sourceText: '',
      detectedSourceLanguage: null,
    };
    return openPopup;
  }

  function renderLoading(popup) {
    popup.body.textContent = '';
    const line = document.createElement('div');
    const spinner = document.createElement('span');
    spinner.className = 'pt-spinner';
    line.appendChild(spinner);
    line.appendChild(document.createTextNode('Translating…'));
    popup.body.appendChild(line);
    popup.footer.textContent = '';
  }

  function renderError(popup, message) {
    popup.title.textContent = 'Translation failed';
    popup.body.textContent = '';

    const error = document.createElement('div');
    error.className = 'pt-error';
    error.textContent = message;
    popup.body.appendChild(error);

    popup.footer.textContent = '';
    const spacer = document.createElement('div');
    spacer.className = 'pt-spacer';
    popup.footer.appendChild(spacer);

    const dismiss = document.createElement('button');
    dismiss.className = 'pt-button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', closePopup);
    popup.footer.appendChild(dismiss);
  }

  function renderResult(popup, result) {
    popup.detectedSourceLanguage = result.detectedSourceLanguage || null;

    popup.title.textContent = 'Translation';
    const meta = document.createElement('span');
    meta.className = 'pt-popup-meta';
    // With Auto-detect the interesting fact is what the backend decided, so it
    // is named explicitly rather than left as "auto".
    meta.textContent =
      result.sourceLanguage === AUTO_DETECT && result.detectedSourceLanguage
        ? '  detected ' + result.detectedSourceLanguage + ' · ' + result.providerLabel
        : '  ' + result.providerLabel;
    popup.title.appendChild(meta);

    popup.body.textContent = '';

    const translated = document.createElement('div');
    translated.textContent = result.translated;
    popup.body.appendChild(translated);

    if (result.showOriginal) {
      const details = document.createElement('details');
      details.className = 'pt-popup-original';

      const summary = document.createElement('summary');
      summary.textContent = 'Original (cleaned)';
      details.appendChild(summary);

      const original = document.createElement('div');
      original.textContent = result.original;
      details.appendChild(original);

      popup.body.appendChild(details);
    }

    popup.footer.textContent = '';

    const copyTranslation = document.createElement('button');
    copyTranslation.className = 'pt-button pt-button-primary';
    copyTranslation.textContent = 'Copy translation';
    copyTranslation.addEventListener('click', function () {
      vscode.postMessage({ type: 'copy', text: result.translated });
    });
    popup.footer.appendChild(copyTranslation);

    const copyOriginal = document.createElement('button');
    copyOriginal.className = 'pt-button';
    copyOriginal.textContent = 'Copy original';
    copyOriginal.addEventListener('click', function () {
      vscode.postMessage({ type: 'copy', text: result.original });
    });
    popup.footer.appendChild(copyOriginal);

    const spacer = document.createElement('div');
    spacer.className = 'pt-spacer';
    popup.footer.appendChild(spacer);

    // Changing a language in the pickers affects this popup only. Offering the
    // change as an explicit action means checking one paragraph in German does
    // not quietly redefine the default for every paper afterwards.
    if (
      result.sourceLanguage !== savedLanguages.sourceLanguage ||
      result.targetLanguage !== savedLanguages.targetLanguage
    ) {
      const remember = document.createElement('button');
      remember.className = 'pt-button';
      remember.textContent = 'Set as default';
      remember.title =
        'Use ' +
        selectLabel(popup.langbar.source) +
        ' → ' +
        selectLabel(popup.langbar.target) +
        ' for future translations';
      remember.addEventListener('click', function () {
        savedLanguages.sourceLanguage = result.sourceLanguage;
        savedLanguages.targetLanguage = result.targetLanguage;
        vscode.postMessage({
          type: 'persist-languages',
          sourceLanguage: result.sourceLanguage,
          targetLanguage: result.targetLanguage,
        });
        remember.textContent = 'Saved';
        remember.disabled = true;
      });
      popup.footer.appendChild(remember);
    }

    const dismiss = document.createElement('button');
    dismiss.className = 'pt-button';
    dismiss.textContent = 'Close';
    dismiss.addEventListener('click', closePopup);
    popup.footer.appendChild(dismiss);
  }

  function selectLabel(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.textContent : select.value;
  }

  /* ---------------------------------------------------------------- *
   * Requests
   * ---------------------------------------------------------------- */

  function requestTranslation(selectionInfo) {
    if (!selectionInfo) {
      return;
    }
    const popup = createPopup(selectionInfo.rect);
    translateInPlace(popup, selectionInfo.text);
  }

  /**
   * Translate into an existing popup. Used both for the first request and for
   * every language change afterwards, so the popup stays where the reader put
   * it instead of jumping back to the selection.
   */
  function translateInPlace(popup, text) {
    const id = 'pt-' + ++requestCounter;
    popup.sourceText = text;
    renderLoading(popup);
    pending.set(id, popup);
    vscode.postMessage({
      type: 'translate',
      id: id,
      text: text,
      sourceLanguage: languages.sourceLanguage,
      targetLanguage: languages.targetLanguage,
    });
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function onMessage(event) {
    const message = event.data;
    if (!message) {
      return;
    }

    // Settings changed elsewhere; keep the pickers from drifting out of sync.
    if (message.type === 'languages') {
      applyLanguageSettings(message.translate);
      return;
    }

    if (message.type !== 'translate-result') {
      // `reload` and anything else belongs to main.js.
      return;
    }

    const popup = pending.get(message.id);
    pending.delete(message.id);
    // The popup may have been dismissed while the request was in flight.
    if (!popup || popup !== openPopup) {
      return;
    }

    if (message.ok) {
      renderResult(popup, message);
    } else {
      renderError(popup, message.error);
    }

    // Only place the popup for the first result. Later ones come from a
    // language change, and moving the popup back to the selection would yank it
    // out from under the reader — who may well have dragged it aside.
    if (!popup.placed) {
      popup.placed = true;
      positionNearSelection(popup.root, popup.rect);
    }
  }

  function onContextMenu(event) {
    // Leave the editable fields of the viewer chrome (the page-number box, the
    // find field) with their native menu, where paste actually matters.
    if (closestMatch(event.target, 'input, textarea, select')) {
      return;
    }
    event.preventDefault();
    showMenu(event.clientX, event.clientY, getSelectionInfo());
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      closeMenu();
      closePopup();
      return;
    }
    if (event.altKey && (event.key === 't' || event.key === 'T')) {
      const selectionInfo = getSelectionInfo();
      if (selectionInfo) {
        event.preventDefault();
        closeMenu();
        requestTranslation(selectionInfo);
      }
    }
  }

  function initialise() {
    installStyles();
    loadLanguageSettings();

    // Capture phase: PDF.js attaches its own handlers to the viewer container,
    // and the menu has to win over them.
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', closeMenu);
    window.addEventListener('message', onMessage);

    // A scroll would leave both the menu and the popup pointing at nothing.
    const viewerContainer = document.getElementById('viewerContainer');
    if (viewerContainer) {
      viewerContainer.addEventListener('scroll', closeMenu, { passive: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
