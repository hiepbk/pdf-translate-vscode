import * as vscode from 'vscode';
import { PdfDocument } from './pdfDocument';
import { PdfPreview } from './pdfPreview';
import { TranslationService } from './translate/translationService';

/**
 * An editable custom editor for PDFs.
 *
 * Upstream registers a *readonly* provider, which is right for a pure viewer.
 * Annotations change that: text boxes and freehand drawing are worth nothing if
 * they vanish when the tab closes, so this provider implements the save side
 * and VS Code gives the editor a dirty marker, Ctrl+S, and hot exit in return.
 *
 * The bytes are produced by PDF.js inside the webview — it is the only thing
 * here that can serialise annotations into a PDF — so every save is a
 * round-trip to the preview.
 */
export class PdfCustomProvider
  implements vscode.CustomEditorProvider<PdfDocument>
{
  public static readonly viewType = 'pdfTranslate.preview';

  private readonly _previews = new Set<PdfPreview>();
  /** The preview showing each document, so a save knows who to ask. */
  private readonly _previewsByUri = new Map<string, PdfPreview>();
  private _activePreview: PdfPreview | undefined;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<PdfDocument>
  >();
  public readonly onDidChangeCustomDocument =
    this._onDidChangeCustomDocument.event;

  constructor(
    private readonly extensionRoot: vscode.Uri,
    private readonly translationService: TranslationService
  ) {}

  public openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  public async resolveCustomEditor(
    document: PdfDocument,
    webviewEditor: vscode.WebviewPanel
  ): Promise<void> {
    const preview = new PdfPreview(
      this.extensionRoot,
      document.uri,
      webviewEditor,
      this.translationService,
      // The webview reports an annotation change; VS Code learns the document
      // is dirty. Undo stays inside PDF.js, which already has its own stack.
      () => this._onDidChangeCustomDocument.fire({ document })
    );
    this._previews.add(preview);
    this._previewsByUri.set(document.uri.toString(), preview);
    this.setActivePreview(preview);

    webviewEditor.onDidDispose(() => {
      preview.dispose();
      this._previews.delete(preview);
      if (this._previewsByUri.get(document.uri.toString()) === preview) {
        this._previewsByUri.delete(document.uri.toString());
      }
    });

    webviewEditor.onDidChangeViewState(() => {
      if (webviewEditor.active) {
        this.setActivePreview(preview);
      } else if (this._activePreview === preview && !webviewEditor.active) {
        this.setActivePreview(undefined);
      }
    });
  }

  public async saveCustomDocument(
    document: PdfDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    await this.writeTo(document, document.uri, cancellation);
    // Only now is the in-webview copy authoritative again, so the dirty state
    // is cleared after the write rather than before it.
    this.previewFor(document).markSaved();
  }

  public async saveCustomDocumentAs(
    document: PdfDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    await this.writeTo(document, destination, cancellation);
  }

  public async revertCustomDocument(document: PdfDocument): Promise<void> {
    await this.previewFor(document).revert();
  }

  /**
   * Hot exit: VS Code asks for a copy it can restore from if the window closes
   * with unsaved annotations.
   */
  public async backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    await this.writeTo(document, context.destination, cancellation);
    return {
      id: context.destination.toString(),
      delete: async (): Promise<void> => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch (error) {
          // The backup is already gone, which is the state we wanted.
        }
      },
    };
  }

  private async writeTo(
    document: PdfDocument,
    target: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    const preview = this.previewFor(document);
    const bytes = await preview.getSaveableBytes();
    if (cancellation.isCancellationRequested) {
      return;
    }
    if (target.toString() === document.uri.toString()) {
      // Writing the file the webview is displaying trips the file watcher.
      preview.expectSelfWrite();
    }
    await vscode.workspace.fs.writeFile(target, bytes);
  }

  private previewFor(document: PdfDocument): PdfPreview {
    const preview = this._previewsByUri.get(document.uri.toString());
    if (!preview) {
      // Saving requires the webview, because it holds the annotations. Without
      // it there is nothing to write, and writing the unmodified file would
      // silently discard the user's edits.
      throw new Error(
        'The PDF editor for this file is no longer open, so its annotations cannot be saved.'
      );
    }
    return preview;
  }

  public get activePreview(): PdfPreview {
    return this._activePreview;
  }

  /**
   * Tell every open preview to rebuild its language pickers. Called when the
   * settings change, so a language chosen from the Command Palette or typed
   * into settings.json shows up in previews that are already open.
   */
  public refreshLanguages(): void {
    this._previews.forEach((preview) => preview.refreshLanguages());
  }

  private setActivePreview(value: PdfPreview | undefined): void {
    this._activePreview = value;
  }
}
