import * as assert from 'assert';
import {
  AUTO_DETECT,
  LANGUAGES,
  languageName,
  targetLanguagesFor,
  toDeepLCode,
} from '../translate/languages';

/*
 * The table is generated into package.json's settings enums by a build step, so
 * these guard the properties that step and the two backends rely on.
 */
describe('languages', () => {
  it('has no duplicate codes', () => {
    const codes = LANGUAGES.map((language) => language.code);
    assert.strictEqual(new Set(codes).size, codes.length);
  });

  it('never offers auto as a real language', () => {
    // `auto` is a source-only sentinel; having it in the table would let it
    // reach a backend as a target language.
    assert.ok(!LANGUAGES.some((language) => language.code === AUTO_DETECT));
  });

  it('covers the defaults the extension ships with', () => {
    const codes = LANGUAGES.map((language) => language.code);
    assert.ok(codes.includes('en'), 'default source');
    assert.ok(codes.includes('vi'), 'default target');
  });

  it('names a language, and falls back to the code for an unknown one', () => {
    assert.strictEqual(languageName('vi'), 'Vietnamese');
    assert.strictEqual(languageName(AUTO_DETECT), 'Auto-detect');
    assert.strictEqual(languageName('zz'), 'zz');
  });

  it('upper-cases codes for DeepL', () => {
    assert.strictEqual(toDeepLCode('vi'), 'VI');
    assert.strictEqual(toDeepLCode('en'), 'EN');
  });

  it("uses DeepL's own spelling where it differs from Google's", () => {
    // Google calls Norwegian Bokmal "no", DeepL calls it "NB"; sending "NO"
    // to DeepL is rejected.
    assert.strictEqual(toDeepLCode('no'), 'NB');
  });

  it('offers every language as a Google target', () => {
    assert.strictEqual(targetLanguagesFor('google').length, LANGUAGES.length);
  });

  it('hides languages DeepL cannot translate into', () => {
    const deepl = targetLanguagesFor('deepl').map((language) => language.code);
    assert.ok(deepl.includes('vi'));
    assert.ok(!deepl.includes('hi'), 'Hindi is not a DeepL target');
    assert.ok(deepl.length < LANGUAGES.length);
  });
});

describe('settings enums', () => {
  /*
   * The dropdowns in the VS Code settings UI come from enums in package.json,
   * which were generated from the table above. Nothing keeps them in step
   * afterwards, so adding a language to the table and forgetting the manifest
   * would silently leave it out of the settings UI. This is that check.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const manifest = require('../../../package.json');
  const properties = manifest.contributes.configuration.properties;
  const codes = LANGUAGES.map((language) => language.code);

  it('offers every language as a target, and nothing more', () => {
    const target = properties['pdf-translate.targetLanguage'];
    assert.deepStrictEqual(target.enum.slice().sort(), codes.slice().sort());
    assert.strictEqual(target.enum.length, target.enumDescriptions.length);
  });

  it('offers every language plus auto-detect as a source', () => {
    const source = properties['pdf-translate.sourceLanguage'];
    assert.deepStrictEqual(
      source.enum.slice().sort(),
      codes.concat(AUTO_DETECT).sort()
    );
    assert.strictEqual(source.enum.length, source.enumDescriptions.length);
  });

  it('defaults to English into Vietnamese', () => {
    assert.strictEqual(
      properties['pdf-translate.sourceLanguage'].default,
      'en'
    );
    assert.strictEqual(
      properties['pdf-translate.targetLanguage'].default,
      'vi'
    );
  });

  it('declares a command for each language picker', () => {
    const commands = manifest.contributes.commands.map(
      (command: { command: string }) => command.command
    );
    assert.ok(commands.includes('pdf-translate.selectSourceLanguage'));
    assert.ok(commands.includes('pdf-translate.selectTargetLanguage'));
  });
});
