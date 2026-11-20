import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeClient } from '../src/client.js';

describe('ClaudeClient unit tests', () => {
  it('adds cache_control to system prompt and last tool definition', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    await client.complete({
      system: 'You are an agent.',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'tool_1',
          description: 'first tool',
          input_schema: { type: 'object' },
        },
        {
          name: 'tool_2',
          description: 'second tool',
          input_schema: { type: 'object' },
        },
      ],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];

    // Verify system prompt has cache_control ephemeral
    expect(callArgs.system).toEqual([
      {
        type: 'text',
        text: 'You are an agent.',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // Verify only the last tool has cache_control
    expect(callArgs.tools.length).toBe(2);
    expect(callArgs.tools[0].cache_control).toBeUndefined();
    expect(callArgs.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('retries only 429, 5xx, network with exponential backoff, max 3 attempts', async () => {
    let attempt = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt < 3) {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: 'Success on attempt 3' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 8 },
      });
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      retryDelayMs: 1, // Fast backoff for test
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    const response = await client.complete({
      system: 'system prompt',
      messages: [{ role: 'user', content: 'test retry' }],
    });

    expect(response.content[0]).toEqual({ type: 'text', text: 'Success on attempt 3' });
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('retries on 5xx server error', async () => {
    let attempt = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        throw Object.assign(new Error('Internal Server Error'), { status: 500 });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: 'Success after 500' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      retryDelayMs: 1,
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    const response = await client.complete({
      system: 'system prompt',
      messages: [{ role: 'user', content: 'test retry 500' }],
    });

    expect(response.content[0]).toEqual({ type: 'text', text: 'Success after 500' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries on network connection error', async () => {
    let attempt = 0;
    const mockCreate = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        throw Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' });
      }
      return Promise.resolve({
        content: [{ type: 'text', text: 'Success after network glitch' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      retryDelayMs: 1,
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    const response = await client.complete({
      system: 'system prompt',
      messages: [{ role: 'user', content: 'test retry network' }],
    });

    expect(response.content[0]).toEqual({ type: 'text', text: 'Success after network glitch' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('never retries on 4xx error (e.g. 400 bad request or 401 unauthorized)', async () => {
    const mockCreate = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('Bad Request: Invalid model parameters'), { status: 400 });
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      retryDelayMs: 1,
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    await expect(
      client.complete({
        system: 'system prompt',
        messages: [{ role: 'user', content: 'test 400' }],
      })
    ).rejects.toThrow('Bad Request');

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('stops retrying and rethrows after 3 failed attempts', async () => {
    const mockCreate = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    });

    const client = new ClaudeClient({
      apiKey: 'test-key',
      retryDelayMs: 1,
      clientOverride: {
        messages: { create: mockCreate },
      } as unknown as Anthropic,
    });

    await expect(
      client.complete({
        system: 'system prompt',
        messages: [{ role: 'user', content: 'test max retries' }],
      })
    ).rejects.toThrow('503 Service Unavailable');

    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});
