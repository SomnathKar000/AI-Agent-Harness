import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HarnessClient, HarnessHttpError } from '../src/client.js';

const TOKEN = 'tok-SUPERSECRET-0123456789';

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: http.Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body,
      });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client() {
  return new HarnessClient({ baseUrl, token: TOKEN });
}

function json(status: number, payload: unknown) {
  respond = (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

describe('HarnessClient', () => {
  beforeAll(() => {
    recorded = [];
  });

  it('sends the token as a Bearer header', async () => {
    json(200, { repos: [] });
    await client().listRepos();
    const last = recorded[recorded.length - 1];
    expect(last.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('raises a typed error on a non-2xx and does not leak the token in its message', async () => {
    json(401, { error: 'unauthorized' });
    await expect(client().listRepos()).rejects.toBeInstanceOf(HarnessHttpError);
    try {
      json(401, { error: 'unauthorized' });
      await client().listRepos();
    } catch (err) {
      const e = err as HarnessHttpError;
      expect(e.status).toBe(401);
      expect(e.message).not.toContain('SUPERSECRET');
      expect(JSON.stringify(e)).not.toContain('SUPERSECRET');
      expect(e.stack ?? '').not.toContain('SUPERSECRET');
    }
  });

  it('does not leak the token even when the server echoes it back', async () => {
    json(500, { error: `boom ${TOKEN}` });
    try {
      await client().listRepos();
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPERSECRET');
    }
  });

  it('posts a task with a JSON body', async () => {
    json(200, { task: { id: 't1', status: 'queued' } });
    const out = await client().createTask({ repoId: 'r1', description: 'fix the bug' });
    const last = recorded[recorded.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/tasks');
    expect(JSON.parse(last.body)).toMatchObject({ repoId: 'r1', description: 'fix the bug' });
    expect(out.task.id).toBe('t1');
  });

  it('decides an approval through the API, never the database', async () => {
    json(200, { approval: { id: 'a1', status: 'approved' } });
    await client().decideApproval('a1', true, 'looks good');
    const last = recorded[recorded.length - 1];
    expect(last.method).toBe('POST');
    expect(last.url).toBe('/approvals/a1/decide');
    expect(JSON.parse(last.body)).toMatchObject({ approved: true, note: 'looks good' });
  });

  it('url-encodes ids so a crafted id cannot reach another path', async () => {
    json(200, { task: {} });
    await client().getTask('../../admin');
    const last = recorded[recorded.length - 1];
    expect(last.url).not.toContain('../');
    expect(last.url).toContain('%2F');
  });

  it('surfaces a readable message when the body is not JSON', async () => {
    respond = (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    };
    await expect(client().listRepos()).rejects.toThrow(/502/);
  });
});
