import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/*
 * install.sh picks the release asset out of GitHub's API response without jq,
 * which bare servers rarely have. That is easy to get subtly wrong, and was:
 * the first version piped line-oriented greps at it, but GitHub returns the
 * release as compact JSON on a single line, so the whole document arrived as
 * one "line" and a positional `cut` pulled an arbitrary field out of it. The
 * script then downloaded the release's own API URL and handed the JSON to
 * `code --install-extension`, which failed with "not a zip file" — and still
 * printed "Installed." at the end.
 *
 * These run the extraction exactly as the script has it, against both shapes
 * of JSON, so a future edit cannot quietly reintroduce that.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

/** A shell to run the pipeline in, or null when there is none to use. */
function findShell(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env['ProgramFiles'] || 'C:\\Program Files',
            'Git',
            'bin',
            'sh.exe'
          ),
          'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
        ]
      : ['/bin/sh'];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The URL-extraction pipeline, lifted verbatim out of install.sh. */
function extractionPipeline(): string {
  const source = fs.readFileSync(INSTALL_SH, 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('url=$(curl'));
  assert.ok(start >= 0, 'install.sh no longer starts the pipeline with curl');

  let end = start;
  while (end < lines.length && !lines[end].includes("sed 's/.*")) {
    end++;
  }
  assert.ok(end < lines.length, 'could not find the end of the pipeline');

  // Everything after the curl, which the test feeds from a file instead.
  return lines
    .slice(start, end + 1)
    .join('\n')
    .replace(/^url=\$\(curl[^\n]*\n/, 'url=$(cat "$1" \\\n');
}

function runPipeline(shell: string, json: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-translate-test-'));
  try {
    const jsonFile = path.join(dir, 'release.json');
    const script = path.join(dir, 'extract.sh');
    fs.writeFileSync(jsonFile, json);
    fs.writeFileSync(
      script,
      `#!/bin/sh\nset -eu\n${extractionPipeline()}\nprintf '%s' "$url"\n`
    );
    return execFileSync(shell, [script, jsonFile], {
      encoding: 'utf8',
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ASSET_URL =
  'https://github.com/hiepbk/pdf-translate-vscode/releases/download/v0.2.0/pdf-translate-0.2.0.vsix';

/** The shape GitHub actually returns: one line, no spaces after the colons. */
const COMPACT_JSON = JSON.stringify({
  url: 'https://api.github.com/repos/hiepbk/pdf-translate-vscode/releases/394450447',
  id: 394450447,
  tag_name: 'v0.2.0',
  assets: [
    {
      url: 'https://api.github.com/repos/hiepbk/pdf-translate-vscode/releases/assets/1',
      name: 'pdf-translate-0.2.0.vsix',
      browser_download_url: ASSET_URL,
    },
  ],
});

const shell = findShell();

describe('install.sh', () => {
  it('exists and is a shell script', () => {
    const source = fs.readFileSync(INSTALL_SH, 'utf8');
    assert.match(source, /^#!\/bin\/sh/);
  });

  it('checks the download really is a VSIX', () => {
    // A zip starts "PK". Without this the script fed a JSON error page to
    // VS Code and let it produce a stack trace several steps later.
    const source = fs.readFileSync(INSTALL_SH, 'utf8');
    assert.match(source, /head -c 2/);
    assert.match(source, /"PK"/);
  });

  it('does not trust the installer CLI exit status alone', () => {
    // `code --install-extension` was seen exiting 0 after printing "Failed
    // Installing Extensions", so the script asks what is installed instead.
    const source = fs.readFileSync(INSTALL_SH, 'utf8');
    assert.match(source, /--list-extensions/);
  });

  (shell ? describe : describe.skip)('the asset URL it extracts', () => {
    it('finds the .vsix in compact JSON, which is what GitHub sends', () => {
      assert.strictEqual(runPipeline(shell as string, COMPACT_JSON), ASSET_URL);
    });

    it('finds it in pretty-printed JSON too', () => {
      const pretty = JSON.stringify(JSON.parse(COMPACT_JSON), null, 2);
      assert.strictEqual(runPipeline(shell as string, pretty), ASSET_URL);
    });

    it('does not mistake a release API URL for the asset', () => {
      // This is the exact failure: the first field of the document is the
      // release's own url, and a positional cut returned it.
      const picked = runPipeline(shell as string, COMPACT_JSON);
      assert.ok(
        !picked.includes('api.github.com'),
        `picked an API URL: ${picked}`
      );
      assert.ok(picked.endsWith('.vsix'), `picked a non-asset: ${picked}`);
    });

    it('comes back empty when the release has no .vsix', () => {
      // Empty is fine; the script checks the shape before downloading.
      const withoutVsix = JSON.stringify({
        url: 'https://api.github.com/repos/x/y/releases/1',
        assets: [
          {
            name: 'notes.txt',
            browser_download_url: 'https://github.com/x/y/releases/1/notes.txt',
          },
        ],
      });
      assert.strictEqual(runPipeline(shell as string, withoutVsix), '');
    });
  });
});
