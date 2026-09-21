import * as vscode from 'vscode';
import { PdfCustomProvider } from './pdfProvider';
import {
  DEEPL_SECRET_KEY,
  TranslationService,
} from './translate/translationService';

export function activate(context: vscode.ExtensionContext): void {
  const extensionRoot = vscode.Uri.file(context.extensionPath);

  // Secret storage, not settings.json: an API key must not be synced across
  // machines by Settings Sync or committed with a dotfiles repository.
  const translationService = new TranslationService(context.secrets);

  const provider = new PdfCustomProvider(extensionRoot, translationService);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfCustomProvider.viewType,
      provider,
      {
        webviewOptions: {
          enableFindWidget: false, // default
          retainContextWhenHidden: true,
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf-translate.setDeepLApiKey', () =>
      setDeepLApiKey(context)
    ),
    vscode.commands.registerCommand('pdf-translate.clearDeepLApiKey', () =>
      clearDeepLApiKey(context)
    )
  );

  // A cached result belongs to the backend and language pair that produced it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pdf-translate')) {
        translationService.clearCache();
      }
    })
  );
}

async function setDeepLApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'DeepL API key',
    prompt:
      'Paste your DeepL API key. Free keys end in ":fx"; the matching API host is chosen automatically.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'The key cannot be empty.' : undefined,
  });

  if (key === undefined) {
    return; // cancelled
  }

  await context.secrets.store(DEEPL_SECRET_KEY, key.trim());
  vscode.window.showInformationMessage(
    'DeepL API key saved to VS Code secret storage.'
  );
}

async function clearDeepLApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(DEEPL_SECRET_KEY);
  vscode.window.showInformationMessage('DeepL API key removed.');
}

export function deactivate(): void {}
