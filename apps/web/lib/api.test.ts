import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles a successful 204 response without trying to parse JSON', async () => {
    const json = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json
      })
    );

    await expect(api<void>('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('still parses JSON responses normally', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ displayName: '开发者' })
      })
    );

    await expect(api<{ displayName: string }>('/auth/me')).resolves.toEqual({
      displayName: '开发者'
    });
  });
});
