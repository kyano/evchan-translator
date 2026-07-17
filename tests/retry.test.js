// EVChan Translator - Retry Utility Tests

import { describe, it, expect, vi } from 'vitest';
import { retry, retryAsync, calcBackoff } from '../lib/retry.js';

// --- calcBackoff helper tests ---

describe('calcBackoff', () => {
  it('returns base * 2^attempt without jitter', () => {
    expect(calcBackoff(100, 0, 10000, false)).toBe(100);
    expect(calcBackoff(100, 1, 10000, false)).toBe(200);
    expect(calcBackoff(100, 2, 10000, false)).toBe(400);
    expect(calcBackoff(100, 3, 10000, false)).toBe(800);
  });

  it('caps delay at max', () => {
    expect(calcBackoff(100, 0, 150, false)).toBe(100);
    expect(calcBackoff(100, 1, 150, false)).toBe(150);
    expect(calcBackoff(100, 2, 150, false)).toBe(150);
  });

  it('jitter keeps delay in [delay * 0.5, delay]', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // min jitter
    expect(calcBackoff(200, 0, 10000, true)).toBe(100); // 200 * 0.5

    vi.spyOn(Math, 'random').mockReturnValue(1); // max jitter
    expect(calcBackoff(200, 0, 10000, true)).toBe(200); // 200 * 1.0

    vi.restoreAllMocks();
  });
});

// --- retry function tests ---

describe('retry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    const result = await retry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on subsequent attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
    const result = await retry(fn, { maxRetries: 2, backoff: { base: 0, jitter: false } });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, { maxRetries: 2, backoff: { base: 0, jitter: false } })).rejects.toThrow(
      'always fails'
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('exponential backoff timing', async () => {
    const delays = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(() => {
      delays.push(Date.now() - lastCall);
      lastCall = Date.now();
      if (fn.mock.calls.length < 3) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve('ok');
    });

    const result = await retry(fn, {
      maxRetries: 2,
      backoff: { base: 20, jitter: false, max: 10000 },
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // delays[0] is the first call (no delay before it)
    // delays[1] ~ 20ms (base * 2^0), delays[2] ~ 40ms (base * 2^1)
    expect(delays[1]).toBeGreaterThanOrEqual(15);
    expect(delays[1]).toBeLessThanOrEqual(50);
    expect(delays[2]).toBeGreaterThanOrEqual(30);
    expect(delays[2]).toBeLessThanOrEqual(70);
  });

  it('backoff caps at max delay', async () => {
    const delays = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(() => {
      delays.push(Date.now() - lastCall);
      lastCall = Date.now();
      if (fn.mock.calls.length < 4) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve('ok');
    });

    const result = await retry(fn, {
      maxRetries: 3,
      backoff: { base: 20, jitter: false, max: 25 },
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
    // delays[1] ~ 20ms (base * 2^0 = 20, under max)
    // delays[2] ~ 25ms (base * 2^1 = 40, capped at 25)
    // delays[3] ~ 25ms (base * 2^2 = 80, capped at 25)
    expect(delays[1]).toBeGreaterThanOrEqual(15);
    expect(delays[1]).toBeLessThanOrEqual(35);
    expect(delays[2]).toBeGreaterThanOrEqual(15);
    expect(delays[2]).toBeLessThanOrEqual(40);
    expect(delays[3]).toBeGreaterThanOrEqual(15);
    expect(delays[3]).toBeLessThanOrEqual(40);
  });

  it('jitter adds randomness', async () => {
    const delays = [];
    let lastCall = Date.now();

    const fn = vi.fn().mockImplementation(() => {
      delays.push(Date.now() - lastCall);
      lastCall = Date.now();
      if (fn.mock.calls.length < 2) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve('ok');
    });

    const result = await retry(fn, {
      maxRetries: 1,
      backoff: { base: 20, jitter: true, max: 10000 },
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // With jitter, delay should be in [10, 20] (0.5x to 1.0x of base)
    expect(delays[1]).toBeGreaterThanOrEqual(5);
    expect(delays[1]).toBeLessThanOrEqual(35);
  });

  it('shouldRetry predicate rejects certain errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('4xx client error'));
    await expect(
      retry(fn, {
        maxRetries: 3,
        backoff: { base: 0, jitter: false },
        shouldRetry: () => false,
      })
    ).rejects.toThrow('4xx client error');
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it('shouldRetry predicate accepts all errors (default behavior)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
    const result = await retry(fn, {
      maxRetries: 1,
      backoff: { base: 0, jitter: false },
      // shouldRetry defaults to () => true
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('AbortSignal cancellation mid-retry', async () => {
    const controller = new AbortController();

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retry(fn, {
      maxRetries: 3,
      backoff: { base: 10, jitter: false },
      signal: controller.signal,
    });

    // Abort after a short delay (during a retry wait)
    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toThrow('Aborted');
  });

  it('signal already aborted before call', async () => {
    const controller = new AbortController();
    controller.abort();

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      retry(fn, {
        maxRetries: 2,
        backoff: { base: 0, jitter: false },
        signal: controller.signal,
      })
    ).rejects.toThrow('Aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('edge case: maxRetries=0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(retry(fn, { maxRetries: 0, backoff: { base: 0, jitter: false } })).rejects.toThrow(
      'fail'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// --- retryAsync backward compat tests ---

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
