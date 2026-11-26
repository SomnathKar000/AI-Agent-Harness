import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@harness/db';
import { setupTestDb, buildTestServer, auth, type TestServer } from './helpers.js';

describe('Repo routes', () => {
  let db: Database;
  let server: TestServer;

  beforeAll(async () => {
    db = await setupTestDb();
    server = await buildTestServer(db);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('creates a repo and returns it', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/repos',
      headers: auth(),
      payload: { name: 'created-repo', localPath: '/tmp/created-repo', testCommand: 'pnpm test' },
    });
    expect(res.statusCode).toBe(201);
    const { repo } = res.json();
    expect(repo.name).toBe('created-repo');
    expect(repo.defaultBranch).toBe('main');
    expect(repo.testCommand).toBe('pnpm test');

    const listed = await server.app.inject({ method: 'GET', url: '/repos', headers: auth() });
    expect(listed.json().repos.some((r: { id: string }) => r.id === repo.id)).toBe(true);
  });

  it.each([
    ['an empty body', {}],
    ['a missing localPath', { name: 'x' }],
    ['an empty name', { name: '   ', localPath: '/tmp/x' }],
    ['an unknown field', { name: 'x', localPath: '/tmp/x', rogue: 'value' }],
    ['a non-string name', { name: 42, localPath: '/tmp/x' }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/repos',
      headers: auth(),
      payload: payload as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/repos/not-a-real-repo',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
