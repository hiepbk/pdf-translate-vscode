import { splitIntoChunks } from './cleanText';
import { request } from './http';
import {
  TranslationError,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from './provider';

/**
 * Google Translate through the endpoint the Chrome dictionary extension uses.
 *
 * It needs no API key and no account, which makes it the only backend that
 * works the moment the extension is installed. It is undocumented and
 * unsupported, so a parse failure is treated as a normal error rather than a
 * bug, and DeepL stays available for anyone who wants a contract behind it.
 *
 * The `client` parameter is load-bearing. The widely cited `client=gtx` is
 * refused with an HTTP 429 "unusual traffic" interstitial on many university
 * and corporate networks — the request never gets as far as the translator.
 * `client=dict-chrome-ex` is served normally on those same networks and
 * returns an identical response shape.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * Budget for the percent-encoded query string. A single request carrying about
 * 5,000 encoded characters is served fine; the usual ceiling is around 8,000,
 * so this leaves room for the rest of the URL.
 */
const ENCODED_BUDGET = 5000;

/** Never chunk below this, or a long word could fail to make progress. */
const MIN_CHUNK_SIZE = 200;

/**
 * How many source characters fit in the budget, measured rather than assumed.
 *
 * Percent-encoding inflates text by an amount that depends entirely on the
 * script: plain English grows by about half, Vietnamese roughly doubles because
 * of its diacritics, and CJK expands ninefold. A fixed character count would
 * either waste most of the budget on English or overflow it on Chinese, so the
 * expansion is sampled from the text itself.
 */
function chunkSizeFor(text: string): number {
  const sample = text.slice(0, 500);
  if (sample.length === 0) {
    return ENCODED_BUDGET;
  }
  const expansion = encodeURIComponent(sample).length / sample.length;
  return Math.max(MIN_CHUNK_SIZE, Math.floor(ENCODED_BUDGET / expansion));
}

export class GoogleTranslateProvider implements TranslationProvider {
  public readonly id = 'google';
  public readonly label = 'Google Translate';

  public async translate(req: TranslationRequest): Promise<TranslationResult> {
    const chunks = splitIntoChunks(req.text, chunkSizeFor(req.text));
    const pieces: string[] = [];
    let detected: string | undefined;

    for (const chunk of chunks) {
      const url =
        `${ENDPOINT}?client=dict-chrome-ex` +
        `&sl=${encodeURIComponent(req.sourceLanguage || 'auto')}` +
        `&tl=${encodeURIComponent(req.targetLanguage)}` +
        `&dt=t&ie=UTF-8&oe=UTF-8` +
        `&q=${encodeURIComponent(chunk)}`;

      const response = await request(url, { timeoutMs: req.timeoutMs });

      if (response.status === 429) {
        throw new TranslationError(
          'Google is rate-limiting this network. Wait a minute and try again, translate a smaller selection, or switch to the DeepL backend in settings.'
        );
      }
      if (response.status !== 200) {
        throw new TranslationError(
          `Google Translate returned HTTP ${response.status}.`
        );
      }

      const parsed = parseResponse(response.body);
      pieces.push(parsed.translated);
      if (!detected && parsed.detectedSourceLanguage) {
        detected = parsed.detectedSourceLanguage;
      }
    }

    // Chunks were cut at sentence or paragraph boundaries and trimmed, so a
    // single space is the right seam between them.
    return {
      translated: pieces.join(' ').trim(),
      detectedSourceLanguage: detected,
    };
  }
}

/**
 * The response is a JSON array whose first element is a list of segments, each
 * of which is `[translated, original, ...]`. Segment boundaries are the
 * endpoint's own sentence split, so the pieces are concatenated without adding
 * separators — any trailing space is already part of each segment.
 */
function parseResponse(body: string): TranslationResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new TranslationError(
      'Could not parse the response from Google Translate. The unofficial endpoint may have changed; the DeepL backend is unaffected.'
    );
  }

  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new TranslationError(
      'Unexpected response shape from Google Translate.'
    );
  }

  const segments = payload[0] as unknown[];
  let translated = '';
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') {
      translated += segment[0];
    }
  }

  const detected = typeof payload[2] === 'string' ? payload[2] : undefined;

  return { translated, detectedSourceLanguage: detected };
}
