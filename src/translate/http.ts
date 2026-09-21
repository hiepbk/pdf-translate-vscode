import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * A very small request helper built on Node's own `https` module.
 *
 * The extension deliberately has no runtime dependencies, and the webview
 * cannot make these calls itself: its content security policy limits
 * `connect-src` to the webview origin, and the translation endpoints do not
 * send CORS headers anyway. So every network call happens here, in the
 * extension host.
 */

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export function request(
  url: string,
  options: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || 15000;

  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;

    const requestOptions: https.RequestOptions = {
      method,
      headers: Object.assign(
        {
          // Some endpoints reject requests without a browser-ish agent.
          'User-Agent': 'Mozilla/5.0 (compatible; vscode-pdf-translate)',
          'Accept-Encoding': 'identity',
        },
        options.headers || {}
      ),
    };

    const clientRequest = transport.request(parsed, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    clientRequest.setTimeout(timeoutMs, () => {
      clientRequest.destroy(
        new Error(`Request timed out after ${timeoutMs} ms`)
      );
    });

    clientRequest.on('error', reject);

    if (options.body !== undefined) {
      clientRequest.write(options.body);
    }
    clientRequest.end();
  });
}
