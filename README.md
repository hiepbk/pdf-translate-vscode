# PDF Viewer with Translate

Read PDFs inside VS Code, select any passage, right-click, and get a translation
in a popup next to the text — without leaving the editor or copying into a
browser tab.

This is a fork of [tomoki1207/vscode-pdfviewer](https://github.com/tomoki1207/vscode-pdfviewer),
which provides the PDF.js-based viewer. Everything about viewing PDFs is
upstream's work; this fork adds the selection, cleaning and translation layer.

## Features

- **Right-click a selection** in any PDF for **Copy**, **Copy cleaned text** and
  **Translate**. `Alt+T` translates the selection directly.
- **Text repair before translating.** Text pulled out of a PDF text layer is not
  prose: lines break mid-sentence, words are split across a hyphen, ligatures
  are single glyphs, and a selection that crosses a page break swallows the
  running header and the page number. All of that is repaired before the text is
  sent, which is what decides whether the translation reads well.
- **DeepL backend**, with the API key kept in VS Code's secret storage — never
  in `settings.json`, which gets synced and committed.
- **Any target language** DeepL supports, `vi` by default.
- Results are cached per session, so re-selecting the same paragraph is instant.

## Setup

Translation needs a DeepL API key. The free tier covers 500,000 characters a
month, which is a lot of paragraphs.

1. Create a key at [DeepL's API plans](https://www.deepl.com/pro-api). Free keys
   end in `:fx`.
2. Run **PDF Translate: Set DeepL API Key** from the Command Palette
   (`Ctrl+Shift+P`). The first time you translate without a key, the extension
   offers this command directly.

The correct API host is chosen from the key, so free and paid keys both work
with no further configuration.

## Usage

1. Open any `.pdf` file. If VS Code opens it with a different viewer, use
   **Open With…** from the file's context menu and pick
   *PDF Viewer with Translate*.
2. Select some text, right-click, choose **Translate** (or press `Alt+T`).
3. The popup can be dragged by its title bar; `Esc` or **Close** dismisses it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `pdf-translate.targetLanguage` | `vi` | Language to translate into |
| `pdf-translate.sourceLanguage` | `auto` | Language of the PDF, or `auto` |
| `pdf-translate.cleanText` | `true` | Repair PDF text before translating |
| `pdf-translate.removeHeadersFooters` | `true` | Drop running heads and page numbers |
| `pdf-translate.showOriginal` | `true` | Show the cleaned source in the popup |
| `pdf-translate.timeout` | `15000` | Backend timeout, in milliseconds |

The viewer's own defaults are inherited from upstream and live under
`pdf-translate.default.*` (cursor, scale, sidebar, scroll mode, spread mode).

> Note: upstream's settings are named `pdf-preview.*`. This fork uses
> `pdf-translate.*` so that both extensions can be installed side by side, so
> those settings do not carry over — set them again if you had customised them.

## Why not a keyless backend?

The obvious no-API-key option is Google's undocumented
`translate.googleapis.com/translate_a/single` endpoint. It was implemented and
then removed: on some networks — university and corporate ranges in particular —
Google answers it with an HTTP 429 "unusual traffic" interstitial regardless of
the request, so it cannot be relied on as a default. DeepL's documented API costs
one setup step and then simply works.

Adding another backend means implementing `TranslationProvider` in
[`src/translate/provider.ts`](src/translate/provider.ts) and returning it from
`TranslationService.resolveProvider`; nothing above that method needs to change.

## Installing

### From a VSIX

```sh
npm install
npm run package          # produces pdf-translate-<version>.vsix
code --install-extension pdf-translate-<version>.vsix
```

A sideloaded VSIX does **not** travel with Settings Sync — Settings Sync stores
a list of Marketplace extension IDs and re-downloads them, so an extension that
never came from the Marketplace cannot be restored on another machine. Install
the VSIX on each machine, or publish it to the Marketplace under your own
publisher ID.

### Remote windows (SSH, WSL, containers)

The extension declares `"extensionKind": ["workspace", "ui"]`. Upstream declares
only `"ui"`, but a UI extension runs on the local machine and cannot read files
in a remote workspace, which is exactly what a custom editor for `*.pdf` has to
do. Preferring `workspace` means the extension runs wherever the PDF is, and
falls back to running locally for local files.

Two consequences when you work over SSH, WSL or in a container:

- The extension has to be installed **in that remote host**, not only locally.
  VS Code shows it under *Local — Installed* with an "Install in SSH: …" button.
- Secret storage belongs to the extension host, so the DeepL key is set **once
  per host**. Run **PDF Translate: Set DeepL API Key** again in the remote
  window the first time you translate there.
- The DeepL request is made from the remote host, so that host needs outbound
  HTTPS access.

### Development

```sh
npm install
npm run compile
npm run test:unit        # the text-cleaning tests
npm run lint
```

Press `F5` in VS Code to launch an Extension Development Host with the extension
loaded.

## How it works

A VS Code webview cannot make the network call itself: its content security
policy restricts `connect-src` to the webview's own origin, and the DeepL API
sends no CORS headers. So the split is:

```
webview (lib/translate.js)          extension host (src/translate/*)
  contextmenu → selection    ──▶    clean the text
                                    call DeepL over HTTPS
  render popup               ◀──    post the result back
```

The webview half is confined to `lib/translate.js`, and the only change to the
HTML is one `<script>` tag. PDF.js's minified `viewer.js` is untouched, so
merging from upstream or upgrading the bundled PDF.js does not conflict with the
translation feature.

Note that the viewer's HTML is generated by `getWebviewContents()` in
[`src/pdfPreview.ts`](src/pdfPreview.ts) — `lib/web/viewer.html` ships with the
PDF.js distribution but is not what the extension loads.

## Tiếng Việt

Bôi đen chữ trong PDF → chuột phải → **Translate** (hoặc `Alt+T`) → bản dịch
hiện trong popup ngay cạnh đoạn văn. Mặc định dịch sang tiếng Việt.

Cần một API key của DeepL (bản free 500.000 ký tự/tháng là quá đủ): lấy key ở
[deepl.com/pro-api](https://www.deepl.com/pro-api), rồi chạy lệnh **PDF
Translate: Set DeepL API Key**. Key được lưu trong secret storage của VS Code,
không nằm trong `settings.json`.

Điểm quan trọng nhất là phần làm sạch chữ: chữ lấy từ PDF bị ngắt dòng giữa câu,
bị gạch nối cuối dòng, lẫn header/footer và số trang. Extension tự nối lại và
loại bỏ những thứ đó trước khi dịch, nên bản dịch đọc mượt hơn hẳn so với copy
thẳng sang Google Translate.

## Change log

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT, inherited from upstream. See [LICENSE](./LICENSE). The bundled PDF.js
distribution in `lib/` remains under the Apache License 2.0; see
[lib/LICENSE](./lib/LICENSE).
