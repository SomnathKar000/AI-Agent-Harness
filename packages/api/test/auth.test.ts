import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@harness/db';
import {
  setupTestDb,
  buildTestServer,
  auth,
  TEST_TOKEN,
  seedRepo,
  type TestServer,
} from './helpers.js';

/**
 * Default-deny at the transport edge. The hook is registered on the instance, not per
 * route, so a route added later cannot forget it — the coverage test below is what keeps
 * that true.
 */
describe('Bearer token authentication', () => {
  let db: Database;
  let server: TestServer;

  beforeAll(async () => {
    db = await setupTestDb();
    server = await buildTestServer(db);
  });

  afterAll(async () => {
    await server?.close();
  });

  const ROUTES: { method: 'GET' | 'POST'; url: string; payload?: unknown }[] = [
    { method: 'GET', url: '/repos' },
    { method: 'POST', url: '/repos', payload: { name: 'x', localPath: '/tmp/x' } },
    { method: 'GET', url: '/tasks' },
    { method: 'POST', url: '/tasks', payload: { repoId: 'r', title: 't', description: 'd' } },
    { method: 'GET', url: '/tasks/some-id' },
    { method: 'GET', url: '/tasks/some-id/logs' },
    { method: 'POST', url: '/tasks/some-id/cancel' },
    { method: 'POST', url: '/tasks/some-id/retry' },
    { method: 'GET', url: '/approvals' },
    { method: 'POST', url: '/approvals/some-id/decide', payload: { approved: true } },
  ];

  it.each(ROUTES)('$method $url is 401 without an Authorization header', async (route) => {
    const res = await server.app.inject({
      method: route.method,
      url: route.url,
      payload: route.payload as never,
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)('$method $url is 401 with a wrong token', async (route) => {
    const res = await server.app.inject({
      method: route.method,
      url: route.url,
      headers: auth('completely-wrong-token-value'),
      payload: route.payload as never,
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['a bare scheme', { authorization: 'Bearer' }],
    ['a scheme with no value', { authorization: 'Bearer ' }],
    ['the wrong scheme', { authorization: `Basic ${TEST_TOKEN}` }],
    ['no scheme', { authorization: TEST_TOKEN }],
    ['an empty header', { authorization: '' }],
    ['a token one character short', { authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}` }],
    ['a token one character long', { authorization: `Bearer ${TEST_TOKEN}x` }],
    ['a token differing in one character', {
      authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}X`,
    }],
    ['a lowercase scheme', { authorization: `bearer ${TEST_TOKEN}` }],
  ])('rejects %s', async (_label, headers) => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: headers as Record<string, string>,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/tasks', headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it('every registered route is covered by the auth hook', async () => {
    // Enumerate what Fastify actually has, so a future route cannot opt out silently.
    const printed = server.app.printRoutes({ commonPrefix: false });
    const urls = Array.from(printed.matchAll(/(\/[\w:/.*-]*)\s+\((.+?)\)/g)).map((m) => ({
      url: m[1],
      methods: m[2].split(',').map((s) => s.trim()),
    }));
    expect(urls.length).toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const { url, methods } of urls) {
      for (const method of methods) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        const concrete = url.replace(/:[A-Za-z]+/g, 'probe-id');
        const res = await server.app.inject({
          method: method as 'GET' | 'POST',
          url: concrete,
          payload: method === 'POST' ? {} : undefined,
        });
        if (res.statusCode !== 401) {
          uncovered.push(`${method} ${concrete} -> ${res.statusCode}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('an authenticated request still reaches the handler', async () => {
    await seedRepo(db);
    const res = await server.app.inject({ method: 'GET', url: '/repos', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().repos)).toBe(true);
  });
});
