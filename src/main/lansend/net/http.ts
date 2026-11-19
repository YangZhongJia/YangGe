/**
 * HTTP transport surface.
 *
 * Why a second transport at all: the raw-TCP protocol is faster, but three
 * audiences cannot use it — iOS apps that must transfer in the background
 * (only `URLSession` background tasks survive suspension), browsers, and
 * networks that block arbitrary TCP ports but allow 443/80.
 *
 * It is a thin adapter, not a second protocol: the same transfer ids, file
 * ids, chunk bitmaps and range semantics, expressed as HTTP. A peer can mix
 * transports within one transfer because the state lives in the session, not
 * in the connection.
 *
 * Endpoints:
 *   GET  /ls/v1/info                     -> this device's PeerInfo
 *   POST /ls/v1/offer                    -> accept or refuse, returns a resume bitmap
 *   GET  /ls/v1/range?...                -> 206 Partial Content, raw bytes
 *   POST /ls/v1/done                     -> finalize (commit part files)
 *   GET  /                               -> minimal upload page for browsers
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WirePeerInfo } from '../crypto/identity';
import type { FileEntry } from '../protocol/types';
import { withResolvers } from '../util/promise';

export interface HttpOfferRequest {
  readonly transferId: string;
  readonly files: readonly FileEntry[];
  readonly totalBytes: number;
  readonly from: string;
}

export interface HttpOfferResponse {
  readonly accepted: boolean;
  readonly reason: string | null;
  /** Per file, the base64 bitmap of chunks already on disk (for resume). */
  readonly bitmaps: Record<string, string>;
  readonly chunkSize: number;
}

/** What the HTTP layer needs from the service. */
export interface HttpTransportHost {
  readonly info: () => WirePeerInfo;
  /** Accepts an offer; returns the resume bitmaps so the client can skip them. */
  readonly onOffer: (request: HttpOfferRequest) => Promise<HttpOfferResponse>;
  /** Resolves a byte range for a transfer, or null when unknown. */
  readonly onRange: (params: {
    transferId: string;
    fileId: string;
    offset: number;
    length: number;
  }) => Promise<{ path: string; size: number; sha256: string | null } | null>;
  /** Writes a browser-uploaded chunk at its offset. */
  readonly onUpload: (params: {
    transferId: string;
    fileId: string;
    offset: number;
    body: Buffer;
  }) => Promise<void>;
  readonly onDone: (transferId: string, ok: boolean) => Promise<void>;
  readonly onError?: (scope: string, error: Error) => void;
}

export class HttpTransport {
  readonly #host: HttpTransportHost;
  #server: Server | null = null;
  #port = 0;

  constructor(host: HttpTransportHost) {
    this.#host = host;
  }

  get port(): number {
    return this.#port;
  }

  get listening(): boolean {
    return this.#server?.listening === true;
  }

  async start(port: number, host?: string): Promise<number> {
    if (this.#server !== null) throw new Error('http transport already started');
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((error: Error) => {
        this.#host.onError?.('http', error);
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    });
    this.#server = server;
    const bound = await new Promise<number>((resolve, reject) => {
      const { promise, resolve: done } = withResolvers<number>();
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        done(address !== null && typeof address !== 'string' ? (address as AddressInfo).port : port);
      });
      return promise.then(resolve, reject);
    });
    this.#port = bound;
    return bound;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    // `close()` alone waits for idle keep-alive sockets, which would hold the
    // process open for the client's keep-alive timeout. Closing connections
    // explicitly makes shutdown immediate and predictable.
    const { promise, resolve } = withResolvers<void>();
    server.close(() => resolve());
    // `closeAllConnections` is Node 18.2+; YangGe's Electron 22 runs Node 16,
    // where `close()` already destroys idle keep-alive sockets, so the extra
    // call is only a fast path on newer runtimes.
    const withCloser = server as unknown as { closeAllConnections?: () => void };
    withCloser.closeAllConnections?.();
    await promise;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Browsers preflight cross-origin requests; the API is read-only for
    // ranges and idempotent for offers, so a permissive policy is safe here.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ls/v1/info') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.#host.info()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ls/v1/offer') {
      const body = await readJson(req);
      const parsed = parseOffer(body);
      if (parsed === null) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad-offer' }));
        return;
      }
      const answer = await this.#host.onOffer(parsed);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ls/v1/range') {
      await this.#serveRange(url, req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ls/v1/upload') {
      await this.#receiveChunk(url, req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ls/v1/done') {
      const body = await readJson(req);
      const transferId = typeof body['transferId'] === 'string' ? body['transferId'] : '';
      const ok = body['ok'] === true;
      if (transferId.length === 0) {
        res.writeHead(400).end();
        return;
      }
      await this.#host.onDone(transferId, ok);
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(UPLOAD_PAGE);
      return;
    }

    res.writeHead(404).end();
  }

  /**
   * Streams a byte range.
   *
   * `206` with `Content-Range` is what makes `URLSession` background downloads
   * resumable: the client sends `Range:` and the OS can retry a partial
   * download itself.
   */
  async #serveRange(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transferId = url.searchParams.get('transfer') ?? '';
    const fileId = url.searchParams.get('file') ?? '';
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const length = Number(url.searchParams.get('length') ?? '0');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad-range' }));
      return;
    }

    const target = await this.#host.onRange({ transferId, fileId, offset, length });
    if (target === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }));
      return;
    }

    const info = await stat(target.path).catch(() => null);
    if (info === null || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    // Re-check the size on every request: the client's offset arithmetic is
    // based on the offer, and a file replaced meanwhile must not be served.
    if (info.size !== target.size) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'size-changed' }));
      return;
    }

    const end = Math.min(offset + length, info.size) - 1;
    if (offset > end) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    const count = end - offset + 1;

    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(count),
      'content-range': `bytes ${offset}-${end}/${info.size}`,
      'accept-ranges': 'bytes',
      // A digest per range would be a second pass; the whole-file hash is
      // verified by the session after every range lands.
      ...(target.sha256 !== null && offset === 0 && count === info.size
        ? { etag: `"${target.sha256}"` }
        : {}),
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // `res.on('close')` fires on a normal finish too, so it must not be the
    // completion signal — listening to it destroyed the stream mid-response
    // and the client hung waiting for bytes that never came.
    const { promise, resolve } = withResolvers<void>();
    const stream = createReadStream(target.path, {
      start: offset,
      end,
      highWaterMark: 1024 * 1024,
    });
    const done = (): void => {
      stream.destroy();
      resolve();
    };
    stream.on('error', () => {
      res.destroy();
      done();
    });
    // A real client disconnect is the case where `close` arrives before
    // `finish`; `res.writableFinished` tells the two apart.
    res.on('close', () => {
      if (!res.writableFinished) done();
    });
    res.on('finish', done);
    stream.pipe(res);
    await promise;
  }

  /**
   * Accepts one uploaded chunk.
   *
   * Browsers cannot do positional writes, so they slice the File in the page
   * and POST each slice with its offset. The body is buffered because a chunk
   * is bounded (8 MiB in the page) and the write needs a contiguous buffer.
   */
  async #receiveChunk(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transferId = url.searchParams.get('transfer') ?? '';
    const fileId = url.searchParams.get('file') ?? '';
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const length = Number(url.searchParams.get('length') ?? '0');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad-range' }));
      return;
    }

    const { promise, resolve, reject } = withResolvers<Buffer>();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > length) {
        reject(new Error('chunk-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', reject);

    const body = await promise;
    if (body.length !== length) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'length-mismatch' }));
      return;
    }
    await this.#host.onUpload({ transferId, fileId, offset, body });
    res.writeHead(204).end();
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = withResolvers<Record<string, unknown>>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    // An offer is small; anything larger is a bug or an attack.
    if (size > 4 * 1024 * 1024) {
      reject(new Error('body-too-large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new Error('bad-json'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    } catch (error) {
      reject(error as Error);
    }
  });
  req.on('error', reject);
  return promise;
}

function parseOffer(body: Record<string, unknown>): HttpOfferRequest | null {
  const transferId = body['transferId'];
  const from = body['from'];
  const totalBytes = body['totalBytes'];
  const files = body['files'];
  if (typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(transferId)) return null;
  if (typeof from !== 'string' || from.length === 0) return null;
  if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) return null;
  if (!Array.isArray(files) || files.length === 0) return null;

  const parsed: FileEntry[] = [];
  for (const raw of files) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const fileId = entry['fileId'];
    const relativePath = entry['relativePath'];
    const size = entry['size'];
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fileId)) return null;
    if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
    const mtime = typeof entry['mtime'] === 'number' ? entry['mtime'] : null;
    const sha256 = typeof entry['sha256'] === 'string' ? entry['sha256'] : null;
    parsed.push({
      fileId,
      name: typeof entry['name'] === 'string' ? entry['name'] : relativePath.split('/').pop() ?? relativePath,
      relativePath,
      size,
      mtime,
      sha256,
    });
  }
  return { transferId, files: parsed, totalBytes, from };
}

/** Digest helper for the upload page's progress display. */
export function httpRangeDigest(path: string, offset: number, length: number): Promise<string> {
  const { promise, resolve, reject } = withResolvers<string>();
  const hash = createHash('sha256');
  const stream = createReadStream(path, { start: offset, end: offset + length - 1 });
  stream.on('data', (chunk) => hash.update(chunk));
  stream.once('error', reject);
  stream.once('end', () => resolve(hash.digest('hex')));
  return promise;
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lansend</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 640px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.hint { color: #888; margin: 0 0 20px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  input[type=text] { flex: 1; padding: 8px; border: 1px solid #8884; border-radius: 6px; font: inherit; }
  button { padding: 8px 14px; border-radius: 6px; border: 0; background: #2b6; color: #fff; font: inherit; cursor: pointer; }
  #log { font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; margin-top: 16px; color: #666; }
</style>
</head>
<body>
<h1>lansend</h1>
<p class="hint">在同一局域网的电脑上运行 <code>lansend serve</code>，把 IP 填进下面即可收发文件。</p>
<div class="row"><input id="host" type="text" placeholder="192.168.1.23:53318"></div>
<div class="row">
  <button id="info">查看设备</button>
  <button id="send">发送文件</button>
  <input id="file" type="file" multiple hidden>
</div>
<div id="log"></div>
<script>
const log = (s) => { document.getElementById('log').textContent += s + "\\n"; };
const base = () => {
  const v = document.getElementById('host').value.trim();
  return v ? \`http://\${v}\` : location.origin;
};
document.getElementById('info').onclick = async () => {
  try {
    const r = await fetch(base() + '/ls/v1/info');
    const j = await r.json();
    log(\`设备：\${j.alias} (\${j.platform}) 版本 \${j.version}\`);
  } catch (e) { log('失败：' + e.message); }
};
document.getElementById('send').onclick = () => document.getElementById('file').click();
document.getElementById('file').onchange = async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const transferId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const entries = files.map((f, i) => ({
    fileId: 'f' + (i + 1), name: f.name, relativePath: f.name, size: f.size, mtime: f.lastModified, sha256: null,
  }));
  const totalBytes = entries.reduce((a, f) => a + f.size, 0);
  try {
    const r = await fetch(base() + '/ls/v1/offer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transferId, from: 'browser', files: entries, totalBytes }),
    });
    const answer = await r.json();
    if (!answer.accepted) { log('被拒绝：' + answer.reason); return; }
    log('已接受，开始传输…');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const CHUNK = 8 * 1024 * 1024;
      for (let offset = 0; offset < f.size; offset += CHUNK) {
        const length = Math.min(CHUNK, f.size - offset);
        const body = f.slice(offset, offset + length);
        const q = \`transfer=\${transferId}&file=\${entries[i].fileId}&offset=\${offset}&length=\${length}\`;
        const up = await fetch(base() + '/ls/v1/upload?' + q, { method: 'POST', body });
        if (!up.ok) { log('上传失败：' + up.status); return; }
        log(\`\${f.name} \${Math.min(offset + length, f.size)}/\${f.size}\`);
      }
    }
    await fetch(base() + '/ls/v1/done', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transferId, ok: true }),
    });
    log('完成');
  } catch (err) { log('失败：' + err.message); }
};
</script>
</body>
</html>`;
