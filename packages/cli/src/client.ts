import type { CliConfig } from './config.js';

/**
 * The only way the CLI reaches the harness (hard rule 1): HTTP to the API. No database
 * handle, no queue, no sandbox.
 *
 * The token travels in an Authorization header and nowhere else — not in a URL, not in a
 * query string, and never in an error message, including when the server echoes it back.
 */

export class HarnessHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string
  ) {
    super(`request failed with ${status}: ${detail}`);
    this.name = 'HarnessHttpError';
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

const MAX_DETAIL_CHARS = 500;

export class HarnessClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: CliConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  /**
   * Strips the token out of anything we are about to show a human. The server should
   * never echo it, but a proxy or a misconfigured handler might.
   */
  scrub(text: string): string {
    if (this.token.length === 0) return text;
    return text.split(this.token).join('[REDACTED]');
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method: options.method ?? 'GET', headers, body, signal: options.signal });
    } catch (err) {
      throw new Error(
        this.scrub(`could not reach the harness API at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`)
      );
    }

    const text = await res.text();
    if (!res.ok) {
      const detail = this.scrub(text).slice(0, MAX_DETAIL_CHARS);
      throw new HarnessHttpError(res.status, detail || res.statusText);
    }

    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(this.scrub(`the API returned a body that is not JSON: ${text.slice(0, MAX_DETAIL_CHARS)}`));
    }
  }

  // --- repos -------------------------------------------------------------
  listRepos(): Promise<{ repos: unknown[] }> {
    return this.request('/repos');
  }

  createRepo(input: Record<string, unknown>): Promise<{ repo: { id: string } }> {
    return this.request('/repos', { method: 'POST', body: input });
  }

  // --- tasks -------------------------------------------------------------
  listTasks(query?: { status?: string; limit?: number }): Promise<{ tasks: unknown[] }> {
    return this.request('/tasks', { query: query as Record<string, string | number | undefined> });
  }

  createTask(input: { repoId: string; description: string; [k: string]: unknown }): Promise<{
    task: { id: string; status: string };
  }> {
    return this.request('/tasks', { method: 'POST', body: input });
  }

  getTask(id: string): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(id)}`);
  }

  cancelTask(id: string): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  retryTask(id: string): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  }

  // --- approvals ---------------------------------------------------------
  listApprovals(query?: { status?: string; taskId?: string }): Promise<{ approvals: unknown[] }> {
    return this.request('/approvals', { query });
  }

  decideApproval(id: string, approved: boolean, note?: string): Promise<Record<string, unknown>> {
    return this.request(`/approvals/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      body: note === undefined ? { approved } : { approved, note },
    });
  }

  /** Server-sent events from GET /tasks/:id/logs, yielded line by line. */
  async *streamLogs(id: string, signal?: AbortSignal): AsyncGenerator<string> {
    const url = new URL(`${this.baseUrl}/tasks/${encodeURIComponent(id)}/logs`);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = this.scrub(await res.text()).slice(0, MAX_DETAIL_CHARS);
      throw new HarnessHttpError(res.status, detail || res.statusText);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) yield this.scrub(line);
      }
    }
  }
}
