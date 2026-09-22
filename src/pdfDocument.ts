import * as vscode from 'vscode';

/**
 * A PDF open in the editor.
 *
 * The edited bytes do not live here. PDF.js owns the annotations, inside the
 * webview, and only it can serialise them back into a PDF — so this document is
 * little more than a URI plus the dirty flag that VS Code needs in order to
 * show the dot on the tab and enable Ctrl+S. When a save happens, the provider
 * asks the webview for the bytes.
 *
 * Undo is deliberately left to PDF.js as well. Firing a
 * `CustomDocumentContentChangeEvent` rather than a `CustomDocumentEditEvent`
 * tells VS Code "this is dirty" without asking it to drive undo, which keeps
 * one undo stack — the editor's own — instead of two that can disagree.
 */
export class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  public dispose(): void {
    // Nothing owned: the webview holds the editing state, and the preview is
    // disposed by the provider when its panel closes.
  }
}
