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
- Added DeepL as the translation backend, behind a `TranslationProvider`
  interface so a second backend can be added without touching the viewer. The
  API key is held in VS Code secret storage, and the free or paid API host is
  chosen from the key.
- Renamed the extension to `hiepbk.pdf-translate`, the custom editor to
  `pdfTranslate.preview` and the settings section to `pdf-translate.*`, so this
  fork can be installed alongside the original without either overwriting the
  other.

A backend using Google's undocumented `translate_a/single` endpoint was written
and then dropped before release: it answers HTTP 429 on some university and
corporate networks no matter how the request is shaped, which makes it unfit as
the default path.

For the history of the upstream viewer this fork is based on, see
[CHANGELOG.upstream.md](CHANGELOG.upstream.md).

### Deviation from upstream worth knowing about

Upstream declares `"extensionKind": ["ui"]`. A UI extension runs on the local
machine and cannot read files in a remote workspace, which is precisely what a
custom editor for `*.pdf` must do, so this fork declares
`["workspace", "ui"]` instead. See the README for what that means when working
over SSH, WSL or in a container.
