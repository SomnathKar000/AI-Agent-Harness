import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { main } from '../src/main.js';

const TOKEN = 'tok-SUPERSECRET-0123456789';

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('main', () => {
  it('exits 2 with a clear message when HARNESS_TOKEN is missing', async () => {
    const err: string[] = [];
    const code = await main(['node', 'harness', 'repo', 'list'], {
      env: {},
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/HARNESS_TOKEN/);
  });

  it('sends the bearer token and prints the result', async () => {
    let seenAuth: string | undefined;
    await withServer(
      (req, res) => {
        seenAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ repos: [{ id: 'r1', name: 'demo', localPath: '/tmp/demo' }] }));
      },
      async (baseUrl) => {
        const out: string[] = [];
        const code = await main(['node', 'harness', 'repo', 'list'], {
          env: { HARNESS_TOKEN: TOKEN, HARNESS_URL: baseUrl },
          out: (l) => out.push(l),
          err: () => {},
        });
        expect(code).toBe(0);
        expect(seenAuth).toBe(`Bearer ${TOKEN}`);
        expect(out.join('\n')).toContain('demo');
      }
    );
  });

  it('wires the scrubber: a token echoed back by the server is never printed', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream said ${TOKEN}` }));
      },
      async (baseUrl) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await main(['node', 'harness', 'repo', 'list'], {
          env: { HARNESS_TOKEN: TOKEN, HARNESS_URL: baseUrl },
          out: (l) => out.push(l),
          err: (l) => err.push(l),
        });
        expect(code).toBe(1);
        const printed = [...out, ...err].join('\n');
        expect(printed).not.toContain('SUPERSECRET');
        expect(printed).toContain('[REDACTED]');
      }
    );
  });

  it('a connection refused is reported without leaking the token', async () => {
    const err: string[] = [];
    const code = await main(['node', 'harness', 'repo', 'list'], {
      // Port 1 is not listening.
      env: { HARNESS_TOKEN: TOKEN, HARNESS_URL: 'http://127.0.0.1:1' },
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).not.toContain('SUPERSECRET');
  });
});
