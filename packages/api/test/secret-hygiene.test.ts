import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@harness/db';
import { setupTestDb, buildTestServer, auth, TEST_TOKEN, seedRepo, seedTask, type TestServer } from './helpers.js';

describe('The API never hands back or logs a credential', () => {
  let db: Database;
  let server: TestServer;
  const logLines: string[] = [];

  beforeAll(async () => {
    db = await setupTestDb();
    server = await buildTestServer(db, {
      logger: {
        level: 'info',
        redact: ['req.headers.authorization', 'headers.authorization', 'token'],
        // Capture everything the logger emits so the assertions see real output.
        stream: {
          write(chunk: string): void {
            logLines.push(chunk);
          },
        },
      } as never,
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('does not echo the token in any response body', async () => {
    const repoId = await seedRepo(db);
    const taskId = await seedTask(db, repoId);

    for (const url of ['/repos', '/tasks', `/tasks/${taskId}`, '/approvals']) {
      const res = await server.app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(TEST_TOKEN);
    }
  });

  it('does not echo the token in an error body', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks/does-not-exist',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(TEST_TOKEN);
  });

  it('does not echo the token back in the 401 it returns for a wrong token', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: auth('a-wrong-but-distinctive-token'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('a-wrong-but-distinctive-token');
  });

  it('never writes an Authorization header value into the log', async () => {
    await server.app.inject({ method: 'GET', url: '/tasks', headers: auth() });
    const all = logLines.join('\n');
    expect(all).not.toContain(TEST_TOKEN);
  });

  it('never writes the Anthropic key into the log or a response', async () => {
    const fakeKey = 'sk-ant-test-key-should-never-appear';
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = fakeKey;
    try {
      const res = await server.app.inject({ method: 'GET', url: '/tasks', headers: auth() });
      expect(res.body).not.toContain(fakeKey);
      expect(logLines.join('\n')).not.toContain(fakeKey);
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });
});
