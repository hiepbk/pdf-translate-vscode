/**
 * The contract every translation backend implements.
 *
 * Backends differ in how they authenticate, how much text they accept per call
 * and how they report errors, but the viewer only ever needs "turn this text
 * into that language", so that is all this interface exposes.
 */

export interface TranslationRequest {
  text: string;
  /** BCP-47-ish target code, e.g. `vi`. */
  targetLanguage: string;
  /** Source code, or `auto` to let the backend decide. */
  sourceLanguage: string;
  timeoutMs: number;
}

export interface TranslationResult {
  translated: string;
  /** Source language the backend reported, when it reports one. */
  detectedSourceLanguage?: string;
}

export interface TranslationProvider {
  /** Stable id used in settings and shown in the popup. */
  readonly id: string;
  /** Human-readable name for the popup header and error messages. */
  readonly label: string;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

/**
 * An error carrying a message that is safe and useful to show in the popup.
 * Anything thrown that is not a `TranslationError` is reported as an unexpected
 * failure, so backends should wrap the failures they understand.
 */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
    // Required so that `instanceof` works when targeting ES5/ES6 downlevel.
    Object.setPrototypeOf(this, TranslationError.prototype);
  }
}

/**
 * Raised when no API key has been stored yet. This is the guaranteed state on
 * first use, and the only failure the user can fix immediately, so it is
 * distinguished from other errors in order to offer them the command that fixes
 * it rather than only describing it.
 */
export class MissingApiKeyError extends TranslationError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingApiKeyError';
    Object.setPrototypeOf(this, MissingApiKeyError.prototype);
  }
}
