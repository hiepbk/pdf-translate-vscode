import * as vscode from 'vscode';
import { PdfPreview } from './pdfPreview';
import { TranslationService } from './translate/translationService';

export class PdfCustomProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'pdfTranslate.preview';

  private readonly _previews = new Set<PdfPreview>();
  private _activePreview: PdfPreview | undefined;

  constructor(
    private readonly extensionRoot: vscode.Uri,
    private readonly translationService: TranslationService
  ) {}

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: (): void => {} };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewEditor: vscode.WebviewPanel
  ): Promise<void> {
    const preview = new PdfPreview(
      this.extensionRoot,
      document.uri,
      webviewEditor,
      this.translationService
    );
    this._previews.add(preview);
    this.setActivePreview(preview);

    webviewEditor.onDidDispose(() => {
      preview.dispose();
      this._previews.delete(preview);
    });

    webviewEditor.onDidChangeViewState(() => {
      if (webviewEditor.active) {
        this.setActivePreview(preview);
      } else if (this._activePreview === preview && !webviewEditor.active) {
        this.setActivePreview(undefined);
      }
    });
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
