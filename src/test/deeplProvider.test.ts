import * as assert from 'assert';
import { DeepLProvider } from '../translate/deeplProvider';
import * as http from '../translate/http';
import { TranslationError } from '../translate/provider';

/*
 * These stub the HTTP layer rather than calling DeepL, so they run without an
 * API key and without a network. What they pin down is everything the provider
 * decides on its own: which host a key is sent to, how the request is shaped,
 * and how DeepL's status codes are turned into advice.
 */

interface Captured {
  url: string;
  options: http.HttpRequestOptions;
}

const realRequest = http.request;

function stubResponse(status: number, body: string): Captured[] {
  const calls: Captured[] = [];
  (http as { request: unknown }).request = async (
    url: string,
    options: http.HttpRequestOptions
  ): Promise<http.HttpResponse> => {
    calls.push({ url, options });
    return { status, body };
  };
  return calls;
}

function translate(provider: DeepLProvider, text: string): Promise<unknown> {
  return provider.translate({
    text,
    targetLanguage: 'vi',
    sourceLanguage: 'auto',
    timeoutMs: 1000,
  });
}

const OK_BODY = JSON.stringify({
  translations: [{ detected_source_language: 'EN', text: 'Xin chào.' }],
});

describe('DeepLProvider', () => {
  afterEach(() => {
    (http as { request: unknown }).request = realRequest;
  });

  it('sends a free key to the free host', async () => {
    const calls = stubResponse(200, OK_BODY);
    await translate(new DeepLProvider('abc-123:fx'), 'Hello.');
    assert.strictEqual(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  });

  it('sends a paid key to the paid host', async () => {
    const calls = stubResponse(200, OK_BODY);
    await translate(new DeepLProvider('abc-123'), 'Hello.');
    assert.strictEqual(calls[0].url, 'https://api.deepl.com/v2/translate');
  });

  it('authenticates and sends the target language in the body', async () => {
    const calls = stubResponse(200, OK_BODY);
    await translate(new DeepLProvider('abc-123:fx'), 'Hello.');

    const { options } = calls[0];
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(
      options.headers && options.headers.Authorization,
      'DeepL-Auth-Key abc-123:fx'
    );

    const body = JSON.parse(options.body as string);
    assert.deepStrictEqual(body.text, ['Hello.']);
    assert.strictEqual(body.target_lang, 'VI');
    // `auto` means "let DeepL decide", which it does when source_lang is absent.
    assert.strictEqual('source_lang' in body, false);
  });

  it('passes an explicit source language through', async () => {
    const calls = stubResponse(200, OK_BODY);
    await new DeepLProvider('k:fx').translate({
      text: 'Hello.',
      targetLanguage: 'vi',
      sourceLanguage: 'en',
      timeoutMs: 1000,
    });
    assert.strictEqual(
      JSON.parse(calls[0].options.body as string).source_lang,
      'EN'
    );
  });

  it('reports the detected source language', async () => {
    stubResponse(200, OK_BODY);
    const result = await new DeepLProvider('k:fx').translate({
      text: 'Hello.',
      targetLanguage: 'vi',
      sourceLanguage: 'auto',
      timeoutMs: 1000,
    });
    assert.strictEqual(result.translated, 'Xin chào.');
    assert.strictEqual(result.detectedSourceLanguage, 'en');
  });

  it('explains a rejected key rather than showing a status code', async () => {
    stubResponse(403, '{"message":"Wrong endpoint"}');
    await assert.rejects(
      translate(new DeepLProvider('k:fx'), 'Hello.'),
      (error: TranslationError) => {
        assert.ok(error instanceof TranslationError);
        assert.match(error.message, /rejected the API key/);
        // DeepL's own message names the problem, so it is kept.
        assert.match(error.message, /Wrong endpoint/);
        return true;
      }
    );
  });

  it('explains an exhausted quota', async () => {
    stubResponse(456, '');
    await assert.rejects(
      translate(new DeepLProvider('k:fx'), 'Hello.'),
      (error: TranslationError) => {
        assert.match(error.message, /quota .* is used up/);
        return true;
      }
    );
  });

  it('suggests checking the target language on a 400', async () => {
    stubResponse(400, '{"message":"Value for target_lang not supported."}');
    await assert.rejects(
      translate(new DeepLProvider('k:fx'), 'Hello.'),
      (error: TranslationError) => {
        assert.match(error.message, /target language/);
        assert.match(error.message, /not supported/);
        return true;
      }
    );
  });

  it('fails cleanly on a body it cannot parse', async () => {
    stubResponse(200, 'not json');
    await assert.rejects(
      translate(new DeepLProvider('k:fx'), 'Hello.'),
      (error: TranslationError) => {
        assert.ok(error instanceof TranslationError);
        return true;
      }
    );
  });

  it('splits text that exceeds the per-request size into several texts', async () => {
    const calls = stubResponse(
      200,
      JSON.stringify({
        translations: [{ text: 'a' }, { text: 'b' }],
      })
    );
    // Two sentences, each comfortably over the 4000-character chunk size.
    const long = 'x'.repeat(4500) + '. ' + 'y'.repeat(4500) + '.';
    await translate(new DeepLProvider('k:fx'), long);

    const body = JSON.parse(calls[0].options.body as string);
    assert.ok(body.text.length > 1, 'expected the text to be chunked');
    body.text.forEach((chunk: string) =>
      assert.ok(chunk.length <= 4000, 'every chunk stays within the limit')
    );
  });
});
