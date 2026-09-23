import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable } from './disposable';
import { cleanPdfText } from './translate/cleanText';
import {
  AUTO_DETECT,
  LANGUAGES,
  targetLanguagesFor,
} from './translate/languages';
import { applyHighlights, Highlight } from './annotate/highlights';
import { MissingApiKeyError } from './translate/provider';
import {
  describeError,
  LanguageOverrides,
  TranslationService,
} from './translate/translationService';

function escapeAttribute(value: string | vscode.Uri): string {
  return value.toString().replace(/"/g, '&quot;');
}

type PreviewState = 'Disposed' | 'Visible' | 'Active';

/**
 * Serialising a large PDF takes a moment, but a save that never settles would
 * hang the editor's save indicator forever, so it is bounded.
 */
const SAVE_TIMEOUT_MS = 60000;

/**
 * How long after a save of our own the watcher's change event is treated as an
 * echo of that write rather than as an edit from elsewhere.
 */
const SELF_WRITE_GRACE_MS = 3000;

export class PdfPreview extends Disposable {
  private _previewState: PreviewState = 'Visible';

  /** Pending `getAnnotatedPdf` calls, keyed by the id sent to the webview. */
  private readonly _pendingSaves = new Map<
    string,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  private _saveCounter = 0;
  /** Timestamp until which a watcher change is an echo of our own write. */
  private _selfWriteUntil = 0;
  /** Highlights drawn but not yet written into the file. */
  private _highlights: Highlight[] = [];

  constructor(
    private readonly extensionRoot: vscode.Uri,
    private readonly resource: vscode.Uri,
    private readonly webviewEditor: vscode.WebviewPanel,
    private readonly translationService: TranslationService,
    private readonly onEdited: () => void
  ) {
    super();
    const resourceRoot = resource.with({
      path: resource.path.replace(/\/[^/]+?\.\w+$/, '/'),
    });

    webviewEditor.webview.options = {
      enableScripts: true,
      localResourceRoots: [resourceRoot, extensionRoot],
    };

    this._register(
      webviewEditor.webview.onDidReceiveMessage((message) => {
        switch (message.type) {
          case 'reopen-as-text': {
            vscode.commands.executeCommand(
              'vscode.openWith',
              resource,
              'default',
              webviewEditor.viewColumn
            );
            break;
          }
          case 'copy': {
            vscode.env.clipboard.writeText(message.text);
            break;
          }
          case 'copy-cleaned': {
            // The same cleaning the translator applies, without translating:
            // useful for pasting a quotation into notes.
            vscode.env.clipboard.writeText(cleanPdfText(message.text));
            break;
          }
          case 'translate': {
            this.translate(message.id, message.text, {
              sourceLanguage: message.sourceLanguage,
              targetLanguage: message.targetLanguage,
            });
            break;
          }
          case 'edited': {
            // PDF.js reported that its annotation storage changed.
            this.onEdited();
            break;
          }
          case 'request-save': {
            // Ctrl+S pressed with focus inside the webview, where VS Code's
            // own keybindings never see it.
            vscode.commands.executeCommand('workbench.action.files.save');
            break;
          }
          case 'annotated-pdf': {
            this.receiveAnnotatedPdf(message);
            break;
          }
          case 'highlights': {
            // The webview owns the unsaved highlights; the host keeps a copy
            // so that a save can write them without another round-trip.
            this._highlights = message.highlights || [];
            break;
          }
          case 'persist-languages': {
            this.persistLanguages(
              message.sourceLanguage,
              message.targetLanguage
            );
            break;
          }
        }
      })
    );

    this._register(
      webviewEditor.onDidChangeViewState(() => {
        this.update();
      })
    );

    this._register(
      webviewEditor.onDidDispose(() => {
        this._previewState = 'Disposed';
      })
    );

    const watcher = this._register(
      vscode.workspace.createFileSystemWatcher(resource.fsPath)
    );
    this._register(
      watcher.onDidChange((e) => {
        if (e.toString() !== this.resource.toString()) {
          return;
        }
        // The watcher fires for our own saves too. Reloading then would throw
        // away the editor state — the open text box, the current tool — and
        // reload a file the webview already agrees with. Only a change made by
        // something else is worth reacting to.
        if (this.consumeSelfWrite()) {
          return;
        }
        this.reload();
      })
    );
    this._register(
      watcher.onDidDelete((e) => {
        if (e.toString() === this.resource.toString()) {
          this.webviewEditor.dispose();
        }
      })
    );

    this.webviewEditor.webview.html = this.getWebviewContents();
    this.update();
  }

  /**
   * Translate a selection on behalf of the webview and post the outcome back.
   *
   * Errors are reported into the popup rather than thrown: a failed lookup is a
   * normal outcome of a network call, and a notification toast would be both
   * more intrusive and further from the text the user is reading.
   */
  private async translate(
    id: string,
    text: string,
    overrides: LanguageOverrides
  ): Promise<void> {
    const showOriginal = vscode.workspace
      .getConfiguration('pdf-translate')
      .get<boolean>('showOriginal', true);

    try {
      const outcome = await this.translationService.translate(text, overrides);
      this.post({
        type: 'translate-result',
        id,
        ok: true,
        showOriginal,
        original: outcome.original,
        translated: outcome.translated,
        providerLabel: outcome.providerLabel,
        detectedSourceLanguage: outcome.detectedSourceLanguage,
        sourceLanguage: outcome.sourceLanguage,
        targetLanguage: outcome.targetLanguage,
      });
    } catch (error) {
      this.post({
        type: 'translate-result',
        id,
        ok: false,
        error: describeError(error),
      });

      // A missing key is the one failure the user can fix on the spot, and it
      // is what every first translation hits, so offer the command instead of
      // leaving them to find it in the Command Palette.
      if (error instanceof MissingApiKeyError) {
        const action = 'Set DeepL API key';
        const choice = await vscode.window.showWarningMessage(
          describeError(error),
          action
        );
        if (choice === action) {
          vscode.commands.executeCommand('pdf-translate.setDeepLApiKey');
        }
      }
    }
  }

  /**
   * Ask the webview to serialise the document, annotations included.
   *
   * Only PDF.js can do this: the annotations live in its editor layer and its
   * writer is what turns them back into PDF objects. The bytes come back as
   * base64 because a webview message is JSON — a `Uint8Array` would arrive as
   * an object with one numbered key per byte, which for a paper-sized PDF is
   * millions of keys.
   */
  public getAnnotatedPdf(): Promise<Uint8Array> {
    if (this._previewState === 'Disposed') {
      return Promise.reject(
        new Error('The PDF editor was closed before the save completed.')
      );
    }

    const id = `save-${++this._saveCounter}`;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._pendingSaves.delete(id)) {
          reject(
            new Error('Timed out waiting for the PDF editor to produce a file.')
          );
        }
      }, SAVE_TIMEOUT_MS);

      this._pendingSaves.set(id, {
        resolve: (bytes): void => {
          clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (error): void => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.post({ type: 'get-annotated-pdf', id });
    });
  }

  private receiveAnnotatedPdf(message: {
    id: string;
    ok: boolean;
    data?: string;
    error?: string;
  }): void {
    const pending = this._pendingSaves.get(message.id);
    if (!pending) {
      return;
    }
    this._pendingSaves.delete(message.id);

    if (!message.ok || typeof message.data !== 'string') {
      pending.reject(
        new Error(message.error || 'The PDF editor could not save the file.')
      );
      return;
    }
    pending.resolve(Buffer.from(message.data, 'base64'));
  }

  /**
   * The document as it should be written to disk.
   *
   * Two writers in sequence, because neither can do the other's job: PDF.js
   * serialises the text boxes and drawings it owns, then the highlights are
   * added to that result, since the bundled PDF.js is too old to write them.
   */
  public async getSaveableBytes(): Promise<Uint8Array> {
    const fromPdfJs = await this.getAnnotatedPdf();
    return applyHighlights(fromPdfJs, this._highlights);
  }

  /** Tell the webview the file on disk now matches what it holds. */
  public markSaved(): void {
    this.post({ type: 'saved' });
  }

  /**
   * Note that this extension is about to write the file, so the change the
   * watcher reports can be ignored.
   *
   * The flag expires on its own: a save that somehow produced no filesystem
   * event would otherwise leave it set, and the next genuine external change
   * would be swallowed.
   */
  public expectSelfWrite(): void {
    this._selfWriteUntil = Date.now() + SELF_WRITE_GRACE_MS;
  }

  private consumeSelfWrite(): boolean {
    if (Date.now() > this._selfWriteUntil) {
      return false;
    }
    this._selfWriteUntil = 0;
    return true;
  }

  /** Throw away unsaved annotations by reloading the file from disk. */
  public async revert(): Promise<void> {
    this.post({ type: 'reload' });
  }

  /**
   * Make the popup's language choice the new default.
   *
   * Written at Global scope rather than Workspace: the language someone reads
   * papers in belongs to them, not to whichever folder happens to be open.
   */
  private async persistLanguages(
    sourceLanguage?: string,
    targetLanguage?: string
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('pdf-translate');
    if (sourceLanguage) {
      await config.update(
        'sourceLanguage',
        sourceLanguage,
        vscode.ConfigurationTarget.Global
      );
    }
    if (targetLanguage) {
      await config.update(
        'targetLanguage',
        targetLanguage,
        vscode.ConfigurationTarget.Global
      );
    }
  }

  /**
   * What the popup's language pickers need: the options to offer, and the
   * current choices. The target list depends on the backend, because DeepL
   * translates into fewer languages than Google and offering one it rejects
   * only produces a failed request.
   */
  private languageSettings(): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration('pdf-translate');
    const provider = config.get<string>('provider', 'google');

    return {
      sourceLanguage: config.get<string>('sourceLanguage', AUTO_DETECT),
      targetLanguage: config.get<string>('targetLanguage', 'vi'),
      // Sources are unrestricted: both backends detect or accept any of these.
      sources: LANGUAGES.map((language) => ({
        code: language.code,
        name: language.nativeName,
      })),
      targets: targetLanguagesFor(provider).map((language) => ({
        code: language.code,
        name: language.nativeName,
      })),
    };
  }

  /**
   * Push the language settings to the webview after they change elsewhere, so
   * the popup's pickers do not drift from the settings they were built from.
   */
  public refreshLanguages(): void {
    this.post({ type: 'languages', translate: this.languageSettings() });
  }

  private post(message: Record<string, unknown>): void {
    if (this._previewState !== 'Disposed') {
      this.webviewEditor.webview.postMessage(message);
    }
  }

  private reload(): void {
    if (this._previewState !== 'Disposed') {
      this.webviewEditor.webview.postMessage({ type: 'reload' });
    }
  }

  private update(): void {
    if (this._previewState === 'Disposed') {
      return;
    }

    if (this.webviewEditor.active) {
      this._previewState = 'Active';
      return;
    }
    this._previewState = 'Visible';
  }

  private getWebviewContents(): string {
    const webview = this.webviewEditor.webview;
    const docPath = webview.asWebviewUri(this.resource);
    const cspSource = webview.cspSource;
    const resolveAsUri = (...p: string[]): vscode.Uri => {
      const uri = vscode.Uri.file(path.join(this.extensionRoot.path, ...p));
      return webview.asWebviewUri(uri);
    };

    const config = vscode.workspace.getConfiguration('pdf-translate');
    const settings = {
      cMapUrl: resolveAsUri('lib', 'web', 'cmaps/').toString(),
      path: docPath.toString(),
      translate: this.languageSettings(),
      highlightColor: config.get<string>('highlightColor', '#ffd400'),
      defaults: {
        cursor: config.get('default.cursor') as string,
        scale: config.get('default.scale') as string,
        sidebar: config.get('default.sidebar') as boolean,
        scrollMode: config.get('default.scrollMode') as string,
        spreadMode: config.get('default.spreadMode') as string,
      },
    };

    const head = `<!DOCTYPE html>
<html dir="ltr" mozdisallowselectionprint>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="google" content="notranslate">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspSource}; script-src 'unsafe-inline' ${cspSource}; style-src 'unsafe-inline' ${cspSource}; img-src blob: data: ${cspSource};">
<meta id="pdf-preview-config" data-config="${escapeAttribute(
      JSON.stringify(settings)
    )}">
<title>PDF.js viewer</title>
<link rel="resource" type="application/l10n" href="${resolveAsUri(
      'lib',
      'web',
      'locale',
      'locale.properties'
    )}">
<link rel="stylesheet" href="${resolveAsUri('lib', 'web', 'viewer.css')}">
<link rel="stylesheet" href="${resolveAsUri('lib', 'pdf.css')}">
<script src="${resolveAsUri('lib', 'build', 'pdf.js')}"></script>
<script src="${resolveAsUri('lib', 'build', 'pdf.worker.js')}"></script>
<script src="${resolveAsUri('lib', 'web', 'viewer.js')}"></script>
<script src="${resolveAsUri('lib', 'main.js')}"></script>
<script src="${resolveAsUri('lib', 'translate.js')}"></script>
<script src="${resolveAsUri('lib', 'annotate.js')}"></script>
<script src="${resolveAsUri('lib', 'highlight.js')}"></script>
<script src="${resolveAsUri('lib', 'toolbar.js')}"></script>
</head>`;

    const body = `<body tabindex="1">
    <div id="outerContainer">

      <div id="sidebarContainer">
        <div id="toolbarSidebar">
          <div id="toolbarSidebarLeft">
            <div id="sidebarViewButtons" class="splitToolbarButton toggled" role="radiogroup">
              <button id="viewThumbnail" class="toolbarButton toggled" title="Show Thumbnails" tabindex="2" data-l10n-id="thumbs" role="radio" aria-checked="true" aria-controls="thumbnailView">
                 <span data-l10n-id="thumbs_label">Thumbnails</span>
              </button>
              <button id="viewOutline" class="toolbarButton" title="Show Document Outline (double-click to expand/collapse all items)" tabindex="3" data-l10n-id="document_outline" role="radio" aria-checked="false" aria-controls="outlineView">
                 <span data-l10n-id="document_outline_label">Document Outline</span>
              </button>
              <button id="viewAttachments" class="toolbarButton" title="Show Attachments" tabindex="4" data-l10n-id="attachments" role="radio" aria-checked="false" aria-controls="attachmentsView">
                 <span data-l10n-id="attachments_label">Attachments</span>
              </button>
              <button id="viewLayers" class="toolbarButton" title="Show Layers (double-click to reset all layers to the default state)" tabindex="5" data-l10n-id="layers" role="radio" aria-checked="false" aria-controls="layersView">
                 <span data-l10n-id="layers_label">Layers</span>
              </button>
            </div>
          </div>

          <div id="toolbarSidebarRight">
            <div id="outlineOptionsContainer" class="hidden">
              <div class="verticalToolbarSeparator"></div>

              <button id="currentOutlineItem" class="toolbarButton" disabled="disabled" title="Find Current Outline Item" tabindex="6" data-l10n-id="current_outline_item">
                <span data-l10n-id="current_outline_item_label">Current Outline Item</span>
              </button>
            </div>
          </div>
        </div>
        <div id="sidebarContent">
          <div id="thumbnailView">
          </div>
          <div id="outlineView" class="hidden">
          </div>
          <div id="attachmentsView" class="hidden">
          </div>
          <div id="layersView" class="hidden">
          </div>
        </div>
        <div id="sidebarResizer"></div>
      </div>  <!-- sidebarContainer -->

      <div id="mainContainer">
        <div class="findbar hidden doorHanger" id="findbar">
          <div id="findbarInputContainer">
            <input id="findInput" class="toolbarField" title="Find" placeholder="Find in document…" tabindex="91" data-l10n-id="find_input" aria-invalid="false">
            <div class="splitToolbarButton">
              <button id="findPrevious" class="toolbarButton" title="Find the previous occurrence of the phrase" tabindex="92" data-l10n-id="find_previous">
                <span data-l10n-id="find_previous_label">Previous</span>
              </button>
              <div class="splitToolbarButtonSeparator"></div>
              <button id="findNext" class="toolbarButton" title="Find the next occurrence of the phrase" tabindex="93" data-l10n-id="find_next">
                <span data-l10n-id="find_next_label">Next</span>
              </button>
            </div>
          </div>

          <div id="findbarOptionsOneContainer">
            <input type="checkbox" id="findHighlightAll" class="toolbarField" tabindex="94">
            <label for="findHighlightAll" class="toolbarLabel" data-l10n-id="find_highlight">Highlight All</label>
            <input type="checkbox" id="findMatchCase" class="toolbarField" tabindex="95">
            <label for="findMatchCase" class="toolbarLabel" data-l10n-id="find_match_case_label">Match Case</label>
          </div>
          <div id="findbarOptionsTwoContainer">
            <input type="checkbox" id="findMatchDiacritics" class="toolbarField" tabindex="96">
            <label for="findMatchDiacritics" class="toolbarLabel" data-l10n-id="find_match_diacritics_label">Match Diacritics</label>
            <input type="checkbox" id="findEntireWord" class="toolbarField" tabindex="97">
            <label for="findEntireWord" class="toolbarLabel" data-l10n-id="find_entire_word_label">Whole Words</label>
          </div>

          <div id="findbarMessageContainer" aria-live="polite">
            <span id="findResultsCount" class="toolbarLabel"></span>
            <span id="findMsg" class="toolbarLabel"></span>
          </div>
        </div>  <!-- findbar -->

        <div class="editorParamsToolbar hidden doorHangerRight" id="editorFreeTextParamsToolbar">
          <div class="editorParamsToolbarContainer">
            <div class="editorParamsSetter">
              <label for="editorFreeTextColor" class="editorParamsLabel" data-l10n-id="editor_free_text_color">Color</label>
              <input type="color" id="editorFreeTextColor" class="editorParamsColor" tabindex="100">
            </div>
            <div class="editorParamsSetter">
              <label for="editorFreeTextFontSize" class="editorParamsLabel" data-l10n-id="editor_free_text_size">Size</label>
              <input type="range" id="editorFreeTextFontSize" class="editorParamsSlider" value="10" min="5" max="100" step="1" tabindex="101">
            </div>
          </div>
        </div>

        <div class="editorParamsToolbar hidden doorHangerRight" id="editorInkParamsToolbar">
          <div class="editorParamsToolbarContainer">
            <div class="editorParamsSetter">
              <label for="editorInkColor" class="editorParamsLabel" data-l10n-id="editor_ink_color">Color</label>
              <input type="color" id="editorInkColor" class="editorParamsColor" tabindex="102">
            </div>
            <div class="editorParamsSetter">
              <label for="editorInkThickness" class="editorParamsLabel" data-l10n-id="editor_ink_thickness">Thickness</label>
              <input type="range" id="editorInkThickness" class="editorParamsSlider" value="1" min="1" max="20" step="1" tabindex="103">
            </div>
            <div class="editorParamsSetter">
              <label for="editorInkOpacity" class="editorParamsLabel" data-l10n-id="editor_ink_opacity">Opacity</label>
              <input type="range" id="editorInkOpacity" class="editorParamsSlider" value="100" min="1" max="100" step="1" tabindex="104">
            </div>
          </div>
        </div>

        <div id="secondaryToolbar" class="secondaryToolbar hidden doorHangerRight">
          <div id="secondaryToolbarButtonContainer">
          <div style="display:none;">
            <button id="secondaryOpenFile" class="secondaryToolbarButton visibleLargeView" title="Open File" tabindex="51" data-l10n-id="open_file">
              <span data-l10n-id="open_file_label">Open</span>
            </button>

            <button id="secondaryPrint" class="secondaryToolbarButton visibleMediumView" title="Print" tabindex="52" data-l10n-id="print">
              <span data-l10n-id="print_label">Print</span>
            </button>

            <button id="secondaryDownload" class="secondaryToolbarButton visibleMediumView" title="Save" tabindex="53" data-l10n-id="save">
              <span data-l10n-id="save_label">Save</span>
            </button>

            <div class="horizontalToolbarSeparator visibleLargeView"></div>

            <button id="presentationMode" class="secondaryToolbarButton" title="Switch to Presentation Mode" tabindex="54" data-l10n-id="presentation_mode">
              <span data-l10n-id="presentation_mode_label">Presentation Mode</span>
            </button>

            <a href="#" id="viewBookmark" class="secondaryToolbarButton" title="Current view (copy or open in new window)" tabindex="55" data-l10n-id="bookmark">
              <span data-l10n-id="bookmark_label">Current View</span>
            </a>

            <div class="horizontalToolbarSeparator"></div>
            </div>

            <button id="firstPage" class="secondaryToolbarButton" title="Go to First Page" tabindex="56" data-l10n-id="first_page">
              <span data-l10n-id="first_page_label">Go to First Page</span>
            </button>
            <button id="lastPage" class="secondaryToolbarButton" title="Go to Last Page" tabindex="57" data-l10n-id="last_page">
              <span data-l10n-id="last_page_label">Go to Last Page</span>
            </button>

            <div class="horizontalToolbarSeparator"></div>

            <button id="pageRotateCw" class="secondaryToolbarButton" title="Rotate Clockwise" tabindex="58" data-l10n-id="page_rotate_cw">
              <span data-l10n-id="page_rotate_cw_label">Rotate Clockwise</span>
            </button>
            <button id="pageRotateCcw" class="secondaryToolbarButton" title="Rotate Counterclockwise" tabindex="59" data-l10n-id="page_rotate_ccw">
              <span data-l10n-id="page_rotate_ccw_label">Rotate Counterclockwise</span>
            </button>

            <div class="horizontalToolbarSeparator"></div>

            <div id="cursorToolButtons" role="radiogroup">
              <button id="cursorSelectTool" class="secondaryToolbarButton toggled" title="Enable Text Selection Tool" tabindex="60" data-l10n-id="cursor_text_select_tool" role="radio" aria-checked="true">
                <span data-l10n-id="cursor_text_select_tool_label">Text Selection Tool</span>
              </button>
              <button id="cursorHandTool" class="secondaryToolbarButton" title="Enable Hand Tool" tabindex="61" data-l10n-id="cursor_hand_tool" role="radio" aria-checked="false">
                <span data-l10n-id="cursor_hand_tool_label">Hand Tool</span>
              </button>
            </div>

            <div class="horizontalToolbarSeparator"></div>

            <div id="scrollModeButtons" role="radiogroup">
              <button id="scrollPage" class="secondaryToolbarButton" title="Use Page Scrolling" tabindex="62" data-l10n-id="scroll_page" role="radio" aria-checked="false">
                <span data-l10n-id="scroll_page_label">Page Scrolling</span>
              </button>
              <button id="scrollVertical" class="secondaryToolbarButton toggled" title="Use Vertical Scrolling" tabindex="63" data-l10n-id="scroll_vertical" role="radio" aria-checked="true">
                <span data-l10n-id="scroll_vertical_label" >Vertical Scrolling</span>
              </button>
              <button id="scrollHorizontal" class="secondaryToolbarButton" title="Use Horizontal Scrolling" tabindex="64" data-l10n-id="scroll_horizontal" role="radio" aria-checked="false">
                <span data-l10n-id="scroll_horizontal_label">Horizontal Scrolling</span>
              </button>
              <button id="scrollWrapped" class="secondaryToolbarButton" title="Use Wrapped Scrolling" tabindex="65" data-l10n-id="scroll_wrapped" role="radio" aria-checked="false">
                <span data-l10n-id="scroll_wrapped_label">Wrapped Scrolling</span>
              </button>
            </div>

            <div class="horizontalToolbarSeparator"></div>

            <div id="spreadModeButtons" role="radiogroup">
              <button id="spreadNone" class="secondaryToolbarButton toggled" title="Do not join page spreads" tabindex="66" data-l10n-id="spread_none" role="radio" aria-checked="true">
                <span data-l10n-id="spread_none_label">No Spreads</span>
              </button>
              <button id="spreadOdd" class="secondaryToolbarButton" title="Join page spreads starting with odd-numbered pages" tabindex="67" data-l10n-id="spread_odd" role="radio" aria-checked="false">
                <span data-l10n-id="spread_odd_label">Odd Spreads</span>
              </button>
              <button id="spreadEven" class="secondaryToolbarButton" title="Join page spreads starting with even-numbered pages" tabindex="68" data-l10n-id="spread_even" role="radio" aria-checked="false">
                <span data-l10n-id="spread_even_label">Even Spreads</span>
              </button>
            </div>

            <div class="horizontalToolbarSeparator"></div>

            <button id="documentProperties" class="secondaryToolbarButton" title="Document Properties…" tabindex="69" data-l10n-id="document_properties" aria-controls="documentPropertiesDialog">
              <span data-l10n-id="document_properties_label">Document Properties…</span>
            </button>
          </div>
        </div>  <!-- secondaryToolbar -->

        <div class="toolbar">
          <div id="toolbarContainer">
            <div id="toolbarViewer">
              <div id="toolbarViewerLeft">
                <button id="sidebarToggle" class="toolbarButton" title="Toggle Sidebar" tabindex="11" data-l10n-id="toggle_sidebar" aria-expanded="false" aria-controls="sidebarContainer">
                  <span data-l10n-id="toggle_sidebar_label">Toggle Sidebar</span>
                </button>
                <div class="toolbarButtonSpacer"></div>
                <button id="viewFind" class="toolbarButton" title="Find in Document" tabindex="12" data-l10n-id="findbar" aria-expanded="false" aria-controls="findbar">
                  <span data-l10n-id="findbar_label">Find</span>
                </button>
                <div class="splitToolbarButton hiddenSmallView">
                  <button class="toolbarButton" title="Previous Page" id="previous" tabindex="13" data-l10n-id="previous">
                    <span data-l10n-id="previous_label">Previous</span>
                  </button>
                  <div class="splitToolbarButtonSeparator"></div>
                  <button class="toolbarButton" title="Next Page" id="next" tabindex="14" data-l10n-id="next">
                    <span data-l10n-id="next_label">Next</span>
                  </button>
                </div>
                <input type="number" id="pageNumber" class="toolbarField" title="Page" value="1" min="1" tabindex="15" data-l10n-id="page" autocomplete="off">
                <span id="numPages" class="toolbarLabel"></span>
              </div>
              <div id="toolbarViewerRight">
              <div style="display:none;">
                <button id="openFile" class="toolbarButton hiddenLargeView" title="Open File" tabindex="31" data-l10n-id="open_file">
                  <span data-l10n-id="open_file_label">Open</span>
                </button>

                <button id="print" class="toolbarButton hiddenMediumView" title="Print" tabindex="32" data-l10n-id="print">
                  <span data-l10n-id="print_label">Print</span>
                </button>

                <button id="download" class="toolbarButton hiddenMediumView" title="Save" tabindex="33" data-l10n-id="save">
                  <span data-l10n-id="save_label">Save</span>
                </button>

                </div>

                <!--
                  One exclusive tool group, in the order a reader reaches for
                  them. Hand and Select drive PDF.js's cursor tools, which it
                  otherwise buries in the Tools menu; Highlight is this fork's
                  own; Typewriter and Draw are PDF.js's annotation editors,
                  which upstream ships but hides because its viewer is
                  read-only and anything drawn would be lost on close.

                  lib/toolbar.js keeps exactly one of them active, since PDF.js
                  treats cursor tools and editor modes as unrelated systems
                  that can both be "on" at once.
                -->
                <div id="pdfTranslateTools" class="splitToolbarButton toggled" role="radiogroup">
                  <button id="pdfTranslateHand" class="toolbarButton" title="Hand — drag to scroll" role="radio" aria-checked="false" tabindex="34">
                    <span>Hand</span>
                  </button>
                  <button id="pdfTranslateSelect" class="toolbarButton" title="Select text" role="radio" aria-checked="true" tabindex="35">
                    <span>Select</span>
                  </button>
                  <button id="pdfTranslateHighlight" class="toolbarButton" title="Highlight — select text to mark it" role="radio" aria-checked="false" tabindex="36">
                    <span>Highlight</span>
                  </button>
                </div>

                <input type="color" id="pdfTranslateHighlightColor" value="#ffd400" title="Highlight colour" tabindex="37" hidden>

                <div id="editorModeButtons" class="splitToolbarButton toggled" role="radiogroup">
                  <button id="editorFreeText" class="toolbarButton" disabled="disabled" title="Typewriter — click to place a text box" role="radio" aria-checked="false" tabindex="38">
                    <span>Typewriter</span>
                  </button>
                  <button id="editorInk" class="toolbarButton" disabled="disabled" title="Draw freehand" role="radio" aria-checked="false" tabindex="39">
                    <span>Draw</span>
                  </button>
                </div>

                <div id="editorModeSeparator" class="verticalToolbarSeparator"></div>
                <button id="secondaryToolbarToggle" class="toolbarButton" title="Tools" tabindex="48" data-l10n-id="tools" aria-expanded="false" aria-controls="secondaryToolbar">
                  <span data-l10n-id="tools_label">Tools</span>
                </button>
              </div>
              <div id="toolbarViewerMiddle">
                <div class="splitToolbarButton">
                  <button id="zoomOut" class="toolbarButton" title="Zoom Out" tabindex="21" data-l10n-id="zoom_out">
                    <span data-l10n-id="zoom_out_label">Zoom Out</span>
                  </button>
                  <div class="splitToolbarButtonSeparator"></div>
                  <button id="zoomIn" class="toolbarButton" title="Zoom In" tabindex="22" data-l10n-id="zoom_in">
                    <span data-l10n-id="zoom_in_label">Zoom In</span>
                   </button>
                </div>
                <span id="scaleSelectContainer" class="dropdownToolbarButton">
                  <select id="scaleSelect" title="Zoom" tabindex="23" data-l10n-id="zoom">
                    <option id="pageAutoOption" title="" value="auto" selected="selected" data-l10n-id="page_scale_auto">Automatic Zoom</option>
                    <option id="pageActualOption" title="" value="page-actual" data-l10n-id="page_scale_actual">Actual Size</option>
                    <option id="pageFitOption" title="" value="page-fit" data-l10n-id="page_scale_fit">Page Fit</option>
                    <option id="pageWidthOption" title="" value="page-width" data-l10n-id="page_scale_width">Page Width</option>
                    <option id="customScaleOption" title="" value="custom" disabled="disabled" hidden="true"></option>
                    <option title="" value="0.5" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 50 }'>50%</option>
                    <option title="" value="0.75" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 75 }'>75%</option>
                    <option title="" value="1" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 100 }'>100%</option>
                    <option title="" value="1.25" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 125 }'>125%</option>
                    <option title="" value="1.5" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 150 }'>150%</option>
                    <option title="" value="2" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 200 }'>200%</option>
                    <option title="" value="3" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 300 }'>300%</option>
                    <option title="" value="4" data-l10n-id="page_scale_percent" data-l10n-args='{ "scale": 400 }'>400%</option>
                  </select>
                </span>
              </div>
            </div>
            <div id="loadingBar">
              <div class="progress">
                <div class="glimmer">
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="viewerContainer" tabindex="0">
          <div id="viewer" class="pdfViewer"></div>
        </div>
      </div> <!-- mainContainer -->

      <div id="dialogContainer">
        <dialog id="passwordDialog">
          <div class="row">
            <label for="password" id="passwordText" data-l10n-id="password_label">Enter the password to open this PDF file:</label>
          </div>
          <div class="row">
            <input type="password" id="password" class="toolbarField">
          </div>
          <div class="buttonRow">
            <button id="passwordCancel" class="dialogButton"><span data-l10n-id="password_cancel">Cancel</span></button>
            <button id="passwordSubmit" class="dialogButton"><span data-l10n-id="password_ok">OK</span></button>
          </div>
        </dialog>
        <dialog id="documentPropertiesDialog">
          <div class="row">
            <span id="fileNameLabel" data-l10n-id="document_properties_file_name">File name:</span>
            <p id="fileNameField" aria-labelledby="fileNameLabel">-</p>
          </div>
          <div class="row">
            <span id="fileSizeLabel" data-l10n-id="document_properties_file_size">File size:</span>
            <p id="fileSizeField" aria-labelledby="fileSizeLabel">-</p>
          </div>
          <div class="separator"></div>
          <div class="row">
            <span id="titleLabel" data-l10n-id="document_properties_title">Title:</span>
            <p id="titleField" aria-labelledby="titleLabel">-</p>
          </div>
          <div class="row">
            <span id="authorLabel" data-l10n-id="document_properties_author">Author:</span>
            <p id="authorField" aria-labelledby="authorLabel">-</p>
          </div>
          <div class="row">
            <span id="subjectLabel" data-l10n-id="document_properties_subject">Subject:</span>
            <p id="subjectField" aria-labelledby="subjectLabel">-</p>
          </div>
          <div class="row">
            <span id="keywordsLabel" data-l10n-id="document_properties_keywords">Keywords:</span>
            <p id="keywordsField" aria-labelledby="keywordsLabel">-</p>
          </div>
          <div class="row">
            <span id="creationDateLabel" data-l10n-id="document_properties_creation_date">Creation Date:</span>
            <p id="creationDateField" aria-labelledby="creationDateLabel">-</p>
          </div>
          <div class="row">
            <span id="modificationDateLabel" data-l10n-id="document_properties_modification_date">Modification Date:</span>
            <p id="modificationDateField" aria-labelledby="modificationDateLabel">-</p>
          </div>
          <div class="row">
            <span id="creatorLabel" data-l10n-id="document_properties_creator">Creator:</span>
            <p id="creatorField" aria-labelledby="creatorLabel">-</p>
          </div>
          <div class="separator"></div>
          <div class="row">
            <span id="producerLabel" data-l10n-id="document_properties_producer">PDF Producer:</span>
            <p id="producerField" aria-labelledby="producerLabel">-</p>
          </div>
          <div class="row">
            <span id="versionLabel" data-l10n-id="document_properties_version">PDF Version:</span>
            <p id="versionField" aria-labelledby="versionLabel">-</p>
          </div>
          <div class="row">
            <span id="pageCountLabel" data-l10n-id="document_properties_page_count">Page Count:</span>
            <p id="pageCountField" aria-labelledby="pageCountLabel">-</p>
          </div>
          <div class="row">
            <span id="pageSizeLabel" data-l10n-id="document_properties_page_size">Page Size:</span>
            <p id="pageSizeField" aria-labelledby="pageSizeLabel">-</p>
          </div>
          <div class="separator"></div>
          <div class="row">
            <span id="linearizedLabel" data-l10n-id="document_properties_linearized">Fast Web View:</span>
            <p id="linearizedField" aria-labelledby="linearizedLabel">-</p>
          </div>
          <div class="buttonRow">
            <button id="documentPropertiesClose" class="dialogButton"><span data-l10n-id="document_properties_close">Close</span></button>
          </div>
        </dialog>
        <dialog id="printServiceDialog" style="min-width: 200px;">
          <div class="row">
            <span data-l10n-id="print_progress_message">Preparing document for printing…</span>
          </div>
          <div class="row">
            <progress value="0" max="100"></progress>
            <span data-l10n-id="print_progress_percent" data-l10n-args='{ "progress": 0 }' class="relative-progress">0%</span>
          </div>
          <div class="buttonRow">
            <button id="printCancel" class="dialogButton"><span data-l10n-id="print_progress_close">Cancel</span></button>
          </div>
        </dialog>
      </div>  <!-- dialogContainer -->

    </div> <!-- outerContainer -->
    <div id="printContainer"></div>

    <input type="file" id="fileInput" class="hidden">
  </body>`;

    const tail = ['</html>'].join('\n');

    return head + body + tail;
  }
}
