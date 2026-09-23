# Change Log

## Unreleased

- Added undo and redo for every kind of edit. Highlights had none at all —
  they could only be clicked away — and PDF.js's own `Ctrl+Z` only fired when
  focus happened to be inside an editor layer, so an edit could look
  un-undoable purely because the caret was elsewhere. One coordinator now owns
  the keystroke and keeps the two histories in chronological order, so
  `Ctrl+Z` always takes back the most recent edit whichever made it. Inside a
  text box the keystroke is left alone, where it means "undo my typing".
- Added a Foxit-style tool group to the toolbar — **Select**, **Highlight**,
  **Typewriter**, **Draw** — with exactly one active at a time.
  PDF.js keeps cursor tools and annotation editor modes in two unrelated
  systems that can both be active at once, and buries the text cursor in the
  Tools menu; one place now decides which tool is active and tells whichever
  system needs telling. There is no hand tool: the wheel and the scrollbar
  scroll, and a reader of papers wants the text cursor by default.
- Fixed the highlight covering the text it highlighted. The overlay carried a
  `z-index`, which turned it into a stacking context; a blended element only
  blends with the backdrop inside its own stacking context, so `multiply` had
  nothing to multiply against and painted flat opaque yellow over the page.
  Removing the z-index restores the blend, and the overlay colour now also
  carries alpha so the text stays readable even where blending does not apply.
- Added `pdf-translate.highlightColor`, defaulting to yellow, as the colour new
  highlights start from. The Highlight button's own icon is yellow too.
- Fixed highlighting doing nothing at all: a backtick inside a CSS comment
  closed the template literal holding the stylesheet, so `lib/highlight.js` was
  a syntax error and never ran. Nothing caught it — tsc does not see `lib/` and
  eslint only runs over `src/` — so the test suite now compiles every webview
  script and drives the highlight path end to end against a stub DOM.
- Toolbar icons are inlined as data URIs. Reusing PDF.js's icon custom
  properties from an injected stylesheet left the buttons blank: their values
  are relative `url()`s, which do not resolve the same way outside the
  stylesheet that defines them.
- Added annotation editing: **Text** places a text box and **Draw** draws
  freehand, both PDF.js's own editors, which upstream ships but hides because a
  read-only viewer would lose anything drawn on close.
- Made the custom editor editable, so `Ctrl+S` writes the annotations into the
  PDF itself and VS Code supplies the dirty marker, Revert and hot exit.
  Undo stays inside PDF.js rather than being driven by VS Code, which keeps one
  undo stack instead of two that can disagree.
- PDF.js is the only thing that can serialise annotations back into a PDF, so a
  save is a round-trip to the webview. The bytes cross as base64: a webview
  message is JSON, and a `Uint8Array` would arrive as an object with one
  numbered key per byte.
- The file watcher no longer reloads the document after this extension's own
  save. It used to, which discarded the editor state and reloaded a file the
  webview already agreed with.
- Added text highlighting, written as real `/Highlight` annotations. The
  bundled PDF.js is 3.1.81 and its `saveNewAnnotations` understands only
  FreeText and Ink, so highlights cannot leave through its save path; they are
  measured in the webview, converted to PDF user space at the moment of
  selection — screen coordinates would be wrong at the next zoom — and written
  by pdf-lib on the host after PDF.js has produced everything it does handle.
  Adjacent fragments are merged into one bar per line, so a highlighted
  sentence is not a row of boxes with seams.
- Trimmed the `dist/` and `es/` trees of the runtime dependencies from the
  package: every one of them resolves to a CommonJS build elsewhere, and the
  unused copies were 2.7 MB of the VSIX.

## 0.1.0

First release of the fork.

- Added a context menu on the PDF text layer with **Copy**, **Copy cleaned
  text** and **Translate**, plus `Alt+T` as a shortcut for translating the
  current selection.
- Added a draggable translation popup that appears next to the selection and can
  show the cleaned source text alongside the translation.
- Added a text-repair pass for PDF text: rejoins lines broken mid-sentence,
  undoes end-of-line hyphenation, normalises ligatures, quotes, dashes and
  invisible spacing characters, and drops running headers, footers and page
  numbers that fall inside a selection spanning a page break.
- Added source and target language pickers to the popup, with a swap button and
  an **Auto-detect** source. Changing a language re-translates the open passage
  in place; making it the default is a separate, explicit action. The same
  choices are available as Command Palette commands and as settings dropdowns,
  generated from one language table so the two cannot drift apart. Defaults are
  English into Vietnamese.
- Added two translation backends behind a `TranslationProvider` interface.
  Google Translate is the default and needs no account or API key; DeepL is
  opt-in via `pdf-translate.provider`, holds its key in VS Code secret storage,
  and picks the free or paid API host from the key.
- Renamed the extension to `hiepbk.pdf-translate`, the custom editor to
  `pdfTranslate.preview` and the settings section to `pdf-translate.*`, so this
  fork can be installed alongside the original without either overwriting the
  other.

### A note on the Google endpoint

The keyless backend calls Google's undocumented `translate_a/single` with
`client=dict-chrome-ex`, not the widely cited `client=gtx`. On many
university and corporate networks `client=gtx` is refused with an HTTP 429
"unusual traffic" page regardless of user agent, while `dict-chrome-ex` is
served normally and returns the same response shape. Chunk sizes are computed
from the percent-encoded length rather than the character count, so that a
selection in a script such as Chinese — which encodes nine times larger — cannot
overflow the query string.

For the history of the upstream viewer this fork is based on, see
[CHANGELOG.upstream.md](CHANGELOG.upstream.md).

### Deviation from upstream worth knowing about

Upstream declares `"extensionKind": ["ui"]`. A UI extension runs on the local
machine and cannot read files in a remote workspace, which is precisely what a
custom editor for `*.pdf` must do, so this fork declares
`["workspace", "ui"]` instead. See the README for what that means when working
over SSH, WSL or in a container.
