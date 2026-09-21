import * as vscode from 'vscode';
import { PdfCustomProvider } from './pdfProvider';
import {
  AUTO_DETECT,
  languageName,
  targetLanguagesFor,
} from './translate/languages';
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
    ),
    vscode.commands.registerCommand('pdf-translate.selectTargetLanguage', () =>
      selectLanguage('target')
    ),
    vscode.commands.registerCommand('pdf-translate.selectSourceLanguage', () =>
      selectLanguage('source')
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('pdf-translate')) {
        return;
      }
      // A cached result belongs to the backend and language pair that made it.
      translationService.clearCache();
      // Open previews built their language pickers from the old settings.
      provider.refreshLanguages();
    })
  );
}

/**
 * Pick a language from the Command Palette, as an alternative to the popup's
 * dropdowns for anyone who would rather not reach for the mouse.
 */
async function selectLanguage(which: 'source' | 'target'): Promise<void> {
  const config = vscode.workspace.getConfiguration('pdf-translate');
  const isSource = which === 'source';
  const key = isSource ? 'sourceLanguage' : 'targetLanguage';
  const current = config.get<string>(key, isSource ? AUTO_DETECT : 'vi');

  const choices = targetLanguagesFor(
    config.get<string>('provider', 'google')
  ).map((language) => ({
    label: language.name,
    description: language.nativeName,
    detail: language.code === current ? 'Current' : undefined,
    code: language.code,
  }));

  if (isSource) {
    // Only the source may be left to the backend to work out.
    choices.unshift({
      label: 'Auto-detect',
      description: 'Let the translation backend identify the language',
      detail: current === AUTO_DETECT ? 'Current' : undefined,
      code: AUTO_DETECT,
    });
  }

  const picked = await vscode.window.showQuickPick(choices, {
    title: isSource ? 'Language of the PDF' : 'Language to translate into',
    matchOnDescription: true,
    placeHolder: `Currently ${languageName(current)}`,
  });

  if (!picked) {
    return;
  }

  await config.update(key, picked.code, vscode.ConfigurationTarget.Global);
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
