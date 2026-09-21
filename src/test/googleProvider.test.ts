import * as assert from 'assert';
import { GoogleTranslateProvider } from '../translate/googleProvider';
import * as http from '../translate/http';
import { TranslationError } from '../translate/provider';

/*
 * The endpoint is undocumented, so these tests pin the two things that were
 * established by probing it and that would silently break translation if they
 * regressed: the `client` parameter that gets the request served at all, and
 * the fact that the query string must stay inside the URL length ceiling for
 * any script.
 */

const realRequest = http.request;

/** A response in the shape the endpoint actually returns. */
function body(segments: string[], detected = 'en'): string {
  return JSON.stringify([
    segments.map((s) => [s, 'source', null, null, 3]),
    null,
    detected,
  ]);
}

function stub(status: number, responseBody: string): string[] {
  const urls: string[] = [];
  (http as { request: unknown }).request = async (
    url: string
  ): Promise<http.HttpResponse> => {
    urls.push(url);
    return { status, body: responseBody };
  };
  return urls;
}

function translate(text: string, target = 'vi'): Promise<unknown> {
  return new GoogleTranslateProvider().translate({
    text,
    targetLanguage: target,
    sourceLanguage: 'auto',
    timeoutMs: 1000,
  });
}

describe('GoogleTranslateProvider', () => {
  afterEach(() => {
    (http as { request: unknown }).request = realRequest;
  });

  it('asks as the Chrome dictionary client, not as gtx', async () => {
    // `client=gtx` is refused with an HTTP 429 interstitial on many university
    // and corporate networks. This parameter is the whole reason the keyless
    // backend works, so it is worth a test of its own.
    const urls = stub(200, body(['Xin chào.']));
    await translate('Hello.');
    assert.ok(urls[0].includes('client=dict-chrome-ex'));
    assert.ok(!urls[0].includes('client=gtx'));
  });

  it('sends the target language and the text', async () => {
    const urls = stub(200, body(['Xin chào.']));
    await translate('Hello world.', 'ja');
    assert.ok(urls[0].includes('&tl=ja'));
    assert.ok(urls[0].includes('&q=Hello%20world.'));
  });

  it('joins the segments the endpoint split the text into', async () => {
    stub(200, body(['Câu một. ', 'Câu hai.']));
    const result = await new GoogleTranslateProvider().translate({
      text: 'Sentence one. Sentence two.',
      targetLanguage: 'vi',
      sourceLanguage: 'auto',
      timeoutMs: 1000,
    });
    assert.strictEqual(result.translated, 'Câu một. Câu hai.');
    assert.strictEqual(result.detectedSourceLanguage, 'en');
  });

  it('keeps every request inside the URL length ceiling for latin text', async () => {
    const urls = stub(200, body(['x']));
    await translate(
      'The quick brown fox jumps over the lazy dog. '.repeat(400)
    );
    urls.forEach((url) =>
      assert.ok(
        url.length < 8000,
        `url of ${url.length} chars exceeds the ceiling`
      )
    );
  });

  it('shrinks the chunk size for scripts that encode much larger', async () => {
    // A CJK character costs nine characters once percent-encoded, so a chunk
    // count based on raw length would overflow the query string.
    const urls = stub(200, body(['x']));
    await translate('这是一个测试句子，用来检查分块是否正确。'.repeat(200));
    urls.forEach((url) =>
      assert.ok(
        url.length < 8000,
        `url of ${url.length} chars exceeds the ceiling`
      )
    );
    assert.ok(urls.length > 1, 'expected CJK text to be split into chunks');
  });

  it('explains a 429 instead of showing the status code', async () => {
    stub(429, '<html>Sorry...');
    await assert.rejects(translate('Hello.'), (error: TranslationError) => {
      assert.ok(error instanceof TranslationError);
      assert.match(error.message, /rate-limiting/);
      return true;
    });
  });

  it('fails cleanly when the response is not the expected shape', async () => {
    stub(200, '{"unexpected":true}');
    await assert.rejects(translate('Hello.'), (error: TranslationError) => {
      assert.ok(error instanceof TranslationError);
      return true;
    });
  });

  it('fails cleanly on a body that is not JSON', async () => {
    stub(200, 'not json at all');
    await assert.rejects(translate('Hello.'), (error: TranslationError) => {
      assert.ok(error instanceof TranslationError);
      return true;
    });
  });
});
