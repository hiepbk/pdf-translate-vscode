import * as assert from 'assert';
import { cleanPdfText, splitIntoChunks } from '../translate/cleanText';

/*
 * These run under plain mocha (`npm run test:unit`) rather than the VS Code
 * integration harness: nothing in cleanText.ts touches the VS Code API, and
 * keeping the tests out of process makes them fast enough to run on every edit.
 *
 * The cases are the failure modes that PDF text layers actually produce, so a
 * regression here is a regression in translation quality.
 */
describe('cleanPdfText', () => {
  it('rejoins lines wrapped mid-sentence', () => {
    assert.strictEqual(
      cleanPdfText(
        'The quick brown fox jumps over\n' +
          'the lazy dog and keeps running\n' +
          'until it is tired.'
      ),
      'The quick brown fox jumps over the lazy dog and keeps running until it is tired.'
    );
  });

  it('undoes end-of-line hyphenation before a lowercase continuation', () => {
    assert.strictEqual(
      cleanPdfText(
        'This representation is a gener-\n' +
          'alisation of the earlier model\n' +
          'proposed by the authors.'
      ),
      'This representation is a generalisation of the earlier model proposed by the authors.'
    );
  });

  it('keeps the hyphen of a genuine compound', () => {
    assert.strictEqual(
      cleanPdfText(
        'We evaluate on the non-\n' +
          'Euclidean manifold described\n' +
          'in the previous section.'
      ),
      'We evaluate on the non-Euclidean manifold described in the previous section.'
    );
  });

  it('normalises ligatures, curly quotes, hard spaces and soft hyphens', () => {
    assert.strictEqual(
      cleanPdfText('The ﬁrst “eﬀicient” method was ‘­best’.'),
      'The first "efficient" method was \'best\'.'
    );
  });

  it('drops a page number and the running head beside it', () => {
    assert.strictEqual(
      cleanPdfText(
        'the results are summarised in\n' +
          'Table 2 below, which shows that\n' +
          '12\n' +
          'Journal of Irreproducible Results\n' +
          'the proposed method outperforms\n' +
          'every baseline we tested.'
      ),
      'the results are summarised in Table 2 below, which shows that the proposed method outperforms every baseline we tested.'
    );
  });

  it('drops a running head that repeats across a page break', () => {
    assert.strictEqual(
      cleanPdfText(
        'we now turn to the second experiment\n' +
          'Smith et al.\n' +
          'which was designed to isolate the effect\n' +
          'Smith et al.\n' +
          'of the regularisation term on accuracy.'
      ),
      'we now turn to the second experiment which was designed to isolate the effect of the regularisation term on accuracy.'
    );
  });

  it('drops an arXiv stamp without eating the line after it', () => {
    assert.strictEqual(
      cleanPdfText(
        'arXiv:2301.12345v2 [cs.CL] 5 Jan 2023\n' +
          'We introduce a new method for aligning\n' +
          'language models with human preferences.'
      ),
      'We introduce a new method for aligning language models with human preferences.'
    );
  });

  it('keeps a paragraph break where a short line ends a sentence', () => {
    assert.strictEqual(
      cleanPdfText(
        'This is the first paragraph which runs on for quite a while here.\n' +
          'It ends early.\n' +
          'This is the second paragraph which also runs on for quite a while.'
      ),
      'This is the first paragraph which runs on for quite a while here. It ends early.\n' +
        'This is the second paragraph which also runs on for quite a while.'
    );
  });

  it('does not break a line where a sentence ends mid-column', () => {
    assert.strictEqual(
      cleanPdfText(
        'The model converges after twenty epochs. We then freeze\n' +
          'the encoder and fine-tune only the classification head on\n' +
          'the downstream task.'
      ),
      'The model converges after twenty epochs. We then freeze the encoder and fine-tune only the classification head on the downstream task.'
    );
  });

  it('keeps one bullet per line', () => {
    assert.strictEqual(
      cleanPdfText(
        'We make three contributions to the field:\n' +
          '• a new dataset of annotated examples\n' +
          '• a training method that is faster\n' +
          '• an analysis of the failure modes'
      ),
      'We make three contributions to the field:\n' +
        '• a new dataset of annotated examples\n' +
        '• a training method that is faster\n' +
        '• an analysis of the failure modes'
    );
  });

  it('never empties a selection that is only page furniture', () => {
    assert.strictEqual(cleanPdfText('12'), '12');
  });

  it('keeps words that are spelled with roman-numeral letters', () => {
    assert.strictEqual(
      cleanPdfText('he said\ndid\nthe civil war end'),
      'he said did the civil war end'
    );
  });

  it('passes text through when cleaning is disabled', () => {
    assert.strictEqual(
      cleanPdfText('a\nb', { enabled: false, removeHeadersFooters: false }),
      'a\nb'
    );
  });

  it('tidies spacing around punctuation and brackets', () => {
    assert.strictEqual(
      cleanPdfText('The result ( see Table 1 ) was clear , and final .'),
      'The result (see Table 1) was clear, and final.'
    );
  });
});

describe('splitIntoChunks', () => {
  const sentence = (letter: string): string => letter.repeat(60) + '.';

  it('returns a single chunk when the text already fits', () => {
    assert.deepStrictEqual(splitIntoChunks('short text', 100), ['short text']);
  });

  it('returns nothing for empty input', () => {
    assert.deepStrictEqual(splitIntoChunks('', 100), []);
  });

  it('cuts at a sentence boundary rather than mid-sentence', () => {
    const chunks = splitIntoChunks(
      [sentence('A'), sentence('B'), sentence('C')].join(' '),
      100
    );
    assert.strictEqual(chunks[0], sentence('A'));
    chunks.forEach((chunk) => assert.ok(chunk.length <= 100));
  });

  it('keeps every word when it has to fall back to a space', () => {
    const words = 'word '.repeat(60).trim();
    const chunks = splitIntoChunks(words, 50);
    assert.strictEqual(chunks.join(' '), words);
  });
});
