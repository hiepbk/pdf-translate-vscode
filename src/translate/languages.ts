/**
 * The languages offered in the settings dropdowns and in the popup pickers.
 *
 * Codes are the ones Google accepts, because Google is the default backend.
 * Where DeepL spells a language differently it is recorded here rather than
 * guessed at the call site, and languages DeepL cannot translate into are
 * marked so the picker can leave them out when DeepL is selected.
 */

export interface Language {
  /** Code sent to the backend, and stored in settings. */
  code: string;
  /** English name, shown in the VS Code settings UI. */
  name: string;
  /** Name in the language itself, shown in the popup picker. */
  nativeName: string;
  /** DeepL's spelling, when it differs from `code`. */
  deeplCode?: string;
  /** Whether DeepL can translate *into* this language. */
  deepl: boolean;
}

/** Sentinel for "let the backend work it out", valid only as a source. */
export const AUTO_DETECT = 'auto';

/**
 * Sorted by English name so the dropdown is predictable to scan. Both backends
 * accept far more than this; the list is deliberately the common set rather
 * than exhaustive, so the dropdown stays usable.
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', deepl: true },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', deepl: true },
  { code: 'zh', name: 'Chinese', nativeName: '中文', deepl: true },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', deepl: true },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', deepl: true },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', deepl: true },
  { code: 'en', name: 'English', nativeName: 'English', deepl: true },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', deepl: true },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', deepl: true },
  { code: 'fr', name: 'French', nativeName: 'Français', deepl: true },
  { code: 'de', name: 'German', nativeName: 'Deutsch', deepl: true },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', deepl: true },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', deepl: true },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', deepl: false },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', deepl: true },
  {
    code: 'id',
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    deepl: true,
  },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', deepl: true },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', deepl: true },
  { code: 'ko', name: 'Korean', nativeName: '한국어', deepl: true },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', deepl: true },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', deepl: true },
  // Google spells Norwegian Bokmal "no"; DeepL spells it "NB".
  {
    code: 'no',
    name: 'Norwegian',
    nativeName: 'Norsk',
    deeplCode: 'NB',
    deepl: true,
  },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', deepl: false },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', deepl: true },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', deepl: true },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', deepl: true },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', deepl: true },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', deepl: true },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', deepl: true },
  { code: 'es', name: 'Spanish', nativeName: 'Español', deepl: true },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', deepl: true },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', deepl: true },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', deepl: true },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', deepl: true },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', deepl: true },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** A human-readable name for a code, falling back to the code itself. */
export function languageName(code: string): string {
  if (code === AUTO_DETECT) {
    return 'Auto-detect';
  }
  const language = BY_CODE.get(code.toLowerCase());
  return language ? language.name : code;
}

/**
 * The code to send to DeepL: its own spelling where that differs, upper-cased
 * because DeepL's API expects upper-case language codes.
 */
export function toDeepLCode(code: string): string {
  const language = BY_CODE.get(code.toLowerCase());
  if (language && language.deeplCode) {
    return language.deeplCode;
  }
  return code.toUpperCase();
}

/**
 * Languages worth offering as a *target* for the given backend. DeepL
 * translates into fewer languages than Google, and offering one it will reject
 * only produces a failed request.
 */
export function targetLanguagesFor(providerId: string): Language[] {
  if (providerId === 'deepl') {
    return LANGUAGES.filter((language) => language.deepl);
  }
  return LANGUAGES.slice();
}
