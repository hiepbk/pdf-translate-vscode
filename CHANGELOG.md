# Change Log

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
