// EVChan Translator - Retry Utility Tests

import { describe, it, expect, vi } from 'vitest';
import { retryAsync } from '../lib/retry.js';

describe('retryAsync', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    const result = await retryAsync(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on failure then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
    const result = await retryAsync(fn, 1, 0);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retryAsync(fn, 2, 0)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('uses default retry count of 1', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
    const result = await retryAsync(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
