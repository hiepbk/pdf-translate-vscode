import * as vscode from 'vscode';
import { cleanPdfText } from './cleanText';
import { DeepLProvider } from './deeplProvider';
import { GoogleTranslateProvider } from './googleProvider';
import { AUTO_DETECT } from './languages';
import {
  MissingApiKeyError,
  TranslationError,
  TranslationProvider,
} from './provider';

/** Secret storage key for the DeepL API key. */
export const DEEPL_SECRET_KEY = 'pdf-translate.deepl.apiKey';

/** Settings section owned by this extension. */
const CONFIG_SECTION = 'pdf-translate';

export interface TranslationOutcome {
  /** The selection after cleaning, i.e. the text that was actually sent. */
  original: string;
  translated: string;
  providerLabel: string;
  detectedSourceLanguage?: string;
  /** The languages actually used, which may be overrides rather than settings. */
  sourceLanguage: string;
  targetLanguage: string;
}

/** Languages chosen for one translation, overriding the configured defaults. */
export interface LanguageOverrides {
  sourceLanguage?: string;
  targetLanguage?: string;
}

/**
 * Owns backend selection, configuration and the result cache, so that the
 * webview side never has to know which backend is in use.
 */
export class TranslationService {
  /**
   * Re-selecting a paragraph that was just translated is the single most common
   * interaction, so results are memoised. The cap is small because entries hold
   * whole paragraphs and the window is per-session anyway.
   */
  private readonly cache = new Map<string, TranslationOutcome>();
  private static readonly MAX_CACHE_ENTRIES = 64;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * `overrides` carries the languages chosen in the popup's pickers. They are
   * deliberately not written to settings first: switching the target language
   * to check a phrase should not silently change the default for every future
   * translation, so the popup asks for the change it wants and persists it only
   * when the user's choice is meant to stick.
   */
  public async translate(
    rawSelection: string,
    overrides: LanguageOverrides = {}
  ): Promise<TranslationOutcome> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    const cleaned = cleanPdfText(rawSelection, {
      enabled: config.get<boolean>('cleanText', true),
      removeHeadersFooters: config.get<boolean>('removeHeadersFooters', true),
    });

    if (!cleaned) {
      throw new TranslationError(
        'The selection contains no text to translate.'
      );
    }

    const targetLanguage = (
      overrides.targetLanguage || config.get<string>('targetLanguage', 'vi')
    ).trim();
    const sourceLanguage = (
      overrides.sourceLanguage ||
      config.get<string>('sourceLanguage', AUTO_DETECT)
    ).trim();
    const timeoutMs = config.get<number>('timeout', 15000);

    if (targetLanguage === AUTO_DETECT) {
      throw new TranslationError(
        'Auto-detect is only meaningful for the source language; choose a target language to translate into.'
      );
    }
    const provider = await this.resolveProvider(
      config.get<string>('provider', 'google')
    );

    // Serialising the inputs as JSON makes the key unambiguous: no separator
    // character has to be reserved, so no selection can collide with another.
    const cacheKey = JSON.stringify([
      provider.id,
      sourceLanguage,
      targetLanguage,
      cleaned,
    ]);

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await provider.translate({
      text: cleaned,
      targetLanguage,
      sourceLanguage,
      timeoutMs,
    });

    const outcome: TranslationOutcome = {
      original: cleaned,
      translated: result.translated,
      providerLabel: provider.label,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceLanguage,
      targetLanguage,
    };

    this.remember(cacheKey, outcome);
    return outcome;
  }

  /** Drop memoised results, e.g. after the backend or languages change. */
  public clearCache(): void {
    this.cache.clear();
  }

  private remember(key: string, outcome: TranslationOutcome): void {
    if (this.cache.size >= TranslationService.MAX_CACHE_ENTRIES) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, outcome);
  }

  /**
   * Google is the default because it needs no account: the feature works the
   * moment the extension is installed. DeepL is opt-in for anyone who wants a
   * documented API and better prose behind it.
   */
  private async resolveProvider(id: string): Promise<TranslationProvider> {
    if (id === 'deepl') {
      const apiKey = await this.secrets.get(DEEPL_SECRET_KEY);
      if (!apiKey) {
        throw new MissingApiKeyError(
          'The DeepL backend is selected but no API key is stored. Add one, or set "pdf-translate.provider" back to "google", which needs no key.'
        );
      }
      return new DeepLProvider(apiKey);
    }
    return new GoogleTranslateProvider();
  }
}

/** Turn any thrown value into a message that is safe to show in the popup. */
export function describeError(error: unknown): string {
  if (error instanceof TranslationError) {
    return error.message;
  }
  if (error instanceof Error) {
    // Network-level failures surface here; the code is more useful than the
    // stack, which the user cannot act on.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return 'Could not reach the translation service. Check your internet connection or proxy settings.';
    }
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      return 'The connection to the translation service was interrupted. Try again.';
    }
    return error.message;
  }
  return String(error);
}
