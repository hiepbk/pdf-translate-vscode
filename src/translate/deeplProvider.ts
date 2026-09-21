import { splitIntoChunks } from './cleanText';
import { request } from './http';
import {
  TranslationError,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from './provider';

/**
 * DeepL, via the documented v2 API.
 *
 * Needs an API key, which is kept in VS Code's secret storage rather than in
 * settings.json — settings are synced and frequently committed to dotfile
 * repositories, and an API key does not belong in either.
 */

/** DeepL accepts up to 50 texts and 128 KiB per request; stay well under both. */
const CHUNK_SIZE = 4000;
const MAX_TEXTS_PER_REQUEST = 40;

interface DeepLTranslation {
  detected_source_language?: string;
  text: string;
}

export class DeepLProvider implements TranslationProvider {
  public readonly id = 'deepl';
  public readonly label = 'DeepL';

  constructor(private readonly apiKey: string) {}

  /**
   * Free keys carry a `:fx` suffix and are only served by the free host;
   * sending a free key to the paid host (or the reverse) is a 403. Picking the
   * host from the key means the user never has to configure this.
   */
  private get endpoint(): string {
    return this.apiKey.trim().endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
  }

  public async translate(req: TranslationRequest): Promise<TranslationResult> {
    const chunks = splitIntoChunks(req.text, CHUNK_SIZE);
    const pieces: string[] = [];
    let detected: string | undefined;

    for (let i = 0; i < chunks.length; i += MAX_TEXTS_PER_REQUEST) {
      const batch = chunks.slice(i, i + MAX_TEXTS_PER_REQUEST);

      const payload: Record<string, unknown> = {
        text: batch,
        target_lang: req.targetLanguage.toUpperCase(),
      };
      if (req.sourceLanguage && req.sourceLanguage !== 'auto') {
        payload.source_lang = req.sourceLanguage.toUpperCase();
      }

      const body = JSON.stringify(payload);
      const response = await request(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey.trim()}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        },
        body,
        timeoutMs: req.timeoutMs,
      });

      if (response.status !== 200) {
        throw new TranslationError(
          describeFailure(response.status, response.body)
        );
      }

      let parsed: { translations?: DeepLTranslation[] };
      try {
        parsed = JSON.parse(response.body);
      } catch (error) {
        throw new TranslationError('Could not parse the response from DeepL.');
      }

      if (!parsed.translations || parsed.translations.length === 0) {
        throw new TranslationError('DeepL returned no translation.');
      }

      for (const translation of parsed.translations) {
        pieces.push(translation.text);
        if (!detected && translation.detected_source_language) {
          detected = translation.detected_source_language.toLowerCase();
        }
      }
    }

    return {
      translated: pieces.join(' ').trim(),
      detectedSourceLanguage: detected,
    };
  }
}

/**
 * DeepL's status codes are specific enough to be actionable, so they are turned
 * into advice rather than a bare number. The API's own `message` field is
 * appended when present because it names the offending parameter — most often
 * a target language DeepL does not support.
 */
function describeFailure(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === 'string') {
      detail = ` ${parsed.message}`;
    }
  } catch (error) {
    // A non-JSON body carries nothing worth showing.
  }

  switch (status) {
    case 403:
      return `DeepL rejected the API key. Run "PDF Translate: Set DeepL API Key" to re-enter it.${detail}`;
    case 429:
      return `DeepL is rate-limiting this key; wait a moment and try again.${detail}`;
    case 456:
      return `The DeepL quota for this key is used up for the current billing period.${detail}`;
    case 400:
      return `DeepL rejected the request. Check that the target language is one DeepL supports.${detail}`;
    default:
      return `DeepL returned HTTP ${status}.${detail}`;
  }
}
