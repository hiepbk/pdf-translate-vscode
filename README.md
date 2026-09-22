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
- **Works with no account.** The default backend needs no API key and no
  sign-up; translation works the moment the extension is installed.
- **DeepL optional**, for better prose. Its API key is kept in VS Code secret
  storage — never in `settings.json`, which gets synced and committed.
- **Pick the languages as you read.** The popup has source and target pickers
  with a swap button; changing either re-translates the same passage on the
  spot. The source can be left on **Auto-detect**. Defaults are English into
  Vietnamese.
- **Annotate and save.** **Text** adds a text box, **Draw** draws freehand, and
  `Ctrl+S` writes them into the PDF itself — so any other reader, Foxit and
  Adobe included, sees them.
- Results are cached per session, so re-selecting the same paragraph is instant.

## Setup

None. Install it and translate — the default backend needs no account, no API
key and no card.

### Switching to DeepL (optional)

DeepL generally produces better prose, at the cost of a sign-up. Its free tier
covers 500,000 characters a month but asks for a card to verify the account,
even though it does not charge one.

1. Create a key at [DeepL's API plans](https://www.deepl.com/pro-api). Free keys
   end in `:fx`.
2. Run **PDF Translate: Set DeepL API Key** from the Command Palette
   (`Ctrl+Shift+P`).
3. Set `pdf-translate.provider` to `deepl`.

The correct API host is chosen from the key, so free and paid keys both work
with no further configuration.

## Usage

1. Open any `.pdf` file. If VS Code opens it with a different viewer, use
   **Open With…** from the file's context menu and pick
   *PDF Viewer with Translate*.
2. Select some text, right-click, choose **Translate** (or press `Alt+T`).
3. The popup can be dragged by its title bar; `Esc` or **Close** dismisses it.

### Changing languages

The popup's two dropdowns are the source and the target. Changing either
re-translates the passage immediately, without closing the popup or moving it,
so comparing two target languages is a single click.

The change applies to that popup only. To make it the new default, press **Set
as default** in the popup footer — a one-off check of a German paragraph should
not quietly redefine what every future translation does. The same choices are
available from the Command Palette as **PDF Translate: Select Source Language**
and **Select Target Language**, and from the settings.

**⇄** swaps the two. When the source is *Auto-detect* it swaps in whatever the
last translation actually detected, since "auto" is not a language to translate
into.

## Annotating

**Text** and **Draw** sit in the toolbar. Both are PDF.js's own editors —
upstream ships them but keeps them hidden, because its viewer cannot save and
anything drawn would be lost on close.

`Ctrl+S` saves. The tab shows the usual dirty dot while there are unsaved
annotations, `Ctrl+Z` undoes within the editor, and **File → Revert** throws
away everything since the last save. Annotations are written into the PDF as
real annotation objects, not into a sidecar file, so they travel with the
document.

**Highlight** is this fork's own. The bundled PDF.js is 3.1.81 and its highlight
editor arrived in 4.3, so selecting text with Highlight on draws an overlay, and
the extension host writes real `/Highlight` annotations into the file when you
save — the same kind Foxit and Adobe write, complete with QuadPoints, so they
read them back.

Click a highlight to remove it while it is still unsaved. Once written into the
file it is a normal PDF annotation, and removing it needs a PDF editor.

> Saving rewrites the PDF in place. Keep papers you cannot replace under version
> control or a backup, as you would with any file an editor can write to.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `pdf-translate.provider` | `google` | `google` (no account) or `deepl` (API key) |
| `pdf-translate.targetLanguage` | `vi` | Language to translate into |
| `pdf-translate.sourceLanguage` | `en` | Language of the PDF, or `auto` to detect it |
| `pdf-translate.cleanText` | `true` | Repair PDF text before translating |
| `pdf-translate.removeHeadersFooters` | `true` | Drop running heads and page numbers |
| `pdf-translate.showOriginal` | `true` | Show the cleaned source in the popup |
| `pdf-translate.timeout` | `15000` | Backend timeout, in milliseconds |

The viewer's own defaults are inherited from upstream and live under
`pdf-translate.default.*` (cursor, scale, sidebar, scroll mode, spread mode).

> Note: upstream's settings are named `pdf-preview.*`. This fork uses
> `pdf-translate.*` so that both extensions can be installed side by side, so
> those settings do not carry over — set them again if you had customised them.

## The `client` parameter, and why it matters

The keyless backend calls Google's undocumented
`translate.googleapis.com/translate_a/single`. Almost every example of that
endpoint online uses `client=gtx`, and on many university and corporate
networks `client=gtx` is refused with an HTTP 429 "unusual traffic" page — the
request never reaches the translator, whatever user agent it carries.

`client=dict-chrome-ex` is served normally on those same networks and returns
an identical response shape, so that is what this extension sends. If you ever
see the rate-limit message, that parameter is the first thing to check.

The endpoint is undocumented and may change or throttle without notice, which is
why DeepL is there as a supported alternative.

Adding a third backend means implementing `TranslationProvider` in
[`src/translate/provider.ts`](src/translate/provider.ts) and returning it from
`TranslationService.resolveProvider`; nothing above that method needs to change.

## Installing

The extension is not on the VS Code Marketplace, so it installs from the
[GitHub Releases](https://github.com/hiepbk/pdf-translate-vscode/releases) of
this repository. One command, and the same command later updates it.

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/hiepbk/pdf-translate-vscode/main/install.ps1 | iex
```

**Linux, macOS, and SSH / WSL / container hosts**

```sh
curl -fsSL https://raw.githubusercontent.com/hiepbk/pdf-translate-vscode/main/install.sh | sh
```

Then reload VS Code (`Ctrl+Shift+P` → *Developer: Reload Window*).

### Why one command per machine

Settings Sync cannot restore this extension. It stores a list of **Marketplace
extension IDs** and re-downloads them from the Marketplace; an extension that
never came from there has no ID to download, so it is recorded in the sync
payload and then quietly skipped on the new machine. Running the install script
is what takes its place.

Remote windows need it for a second reason: VS Code never syncs extensions to or
from a remote window, so every SSH host, WSL distro and container needs its own
install regardless of where the extension came from.

### Cutting a release

Pushing a tag is all it takes. GitHub Actions runs the lint and the tests,
builds the VSIX and attaches it to a new Release, so releasing needs nothing
installed locally.

```sh
# 1. bump "version" in package.json, then
git commit -am "Release 0.2.0"
git tag v0.2.0          # the tag must match package.json, or the build fails
git push && git push --tags
```

### Building by hand

```sh
npm install
npm run package          # produces pdf-translate-<version>.vsix
code --install-extension pdf-translate-<version>.vsix
```

### Remote windows (SSH, WSL, containers)

The extension declares `"extensionKind": ["workspace", "ui"]`. Upstream declares
only `"ui"`, but a UI extension runs on the local machine and cannot read files
in a remote workspace, which is exactly what a custom editor for `*.pdf` has to
do. Preferring `workspace` means the extension runs wherever the PDF is, and
falls back to running locally for local files.

Two consequences when you work over SSH, WSL or in a container:

- The extension has to be installed **in that remote host**, not only locally.
  Run `install.sh` there, from VS Code's integrated terminal.
- The translation request is made from the remote host, so that host needs
  outbound HTTPS access.
- If you use the DeepL backend, secret storage belongs to the extension host, so
  the key is set **once per host**. The default Google backend needs no key and
  so needs nothing extra.

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
policy restricts `connect-src` to the webview's own origin, and neither
translation endpoint sends CORS headers. So the split is:

```
webview (lib/translate.js)          extension host (src/translate/*)
  contextmenu → selection    ──▶    clean the text
                                    call the backend over HTTPS
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
hiện trong popup ngay cạnh đoạn văn. Mặc định dịch từ tiếng Anh sang tiếng Việt.

Trong popup có hai ô chọn ngôn ngữ: ô trái là ngôn ngữ nguồn (chọn được
**Auto-detect** để tự nhận diện), ô phải là ngôn ngữ đích. Đổi ô nào thì dịch
lại ngay đoạn đó, không phải bôi đen lại. Nút **⇄** để đảo nguồn và đích. Nếu
muốn giữ lựa chọn đó làm mặc định thì bấm **Set as default**.

Không cần đăng ký gì cả, không cần API key, không cần thẻ — cài xong là dùng
được ngay, vì backend mặc định dùng Google Translate.

Nếu muốn chất lượng dịch tốt hơn thì chuyển sang DeepL: lấy key ở
[deepl.com/pro-api](https://www.deepl.com/pro-api) (bản free 500.000 ký tự/tháng,
nhưng phải nhập thẻ để xác minh), chạy lệnh **PDF Translate: Set DeepL API Key**,
rồi đổi `pdf-translate.provider` thành `deepl`. Key được lưu trong secret
storage của VS Code, không nằm trong `settings.json`.

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
