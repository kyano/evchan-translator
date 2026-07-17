// EVChan Translator - Retry Utility
// Provides retry logic for async operations

/**
 * Calculate backoff delay with optional jitter.
 * @param {number} base - Base delay in ms
 * @param {number} attempt - 0-indexed retry attempt
 * @param {number} maxDelay - Maximum delay cap
 * @param {boolean} jitter - Whether to add random jitter
 * @returns {number} Delay in ms
 */
export function calcBackoff(base, attempt, maxDelay, jitter) {
  let delay = Math.min(base * Math.pow(2, attempt), maxDelay);
  if (jitter) {
    delay *= 0.5 + Math.random() * 0.5;
  }
  return delay;
}

/**
 * Wait for the specified delay, respecting abort signals.
 * @param {number} ms - Delay in milliseconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>}
 */
async function wait(ms, signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (ms === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}

/**
 * Execute an async function with retry on failure.
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {object} [options] - Options
 * @param {number} [options.maxRetries=2] - Number of retry attempts (total calls = 1 + maxRetries)
 * @param {object} [options.backoff] - Backoff configuration
 * @param {number} [options.backoff.base=300] - Base delay in ms
 * @param {number} [options.backoff.max=5000] - Maximum delay in ms
 * @param {boolean} [options.backoff.jitter=true] - Add random jitter
 * @param {(error: Error, attempt: number) => boolean} [options.shouldRetry] - Predicate to decide if retry should occur. Default: always retry.
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel mid-retry
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  const {
    maxRetries = 2,
    backoff: { base = 300, max: maxDelay = 5000, jitter = true } = {},
    shouldRetry = () => true,
    signal,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        break;
      }

      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const delay = calcBackoff(base, attempt, maxDelay, jitter);
      await wait(delay, signal);
    }
  }

  throw lastError;
}

/**
 * Execute an async function with retry on failure.
 * @deprecated Use retry(fn, { maxRetries, backoff: { base: delayMs } }) instead
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {number} [maxRetries] - Maximum retry attempts (default: 1)
 * @param {number} [delayMs] - Delay between retries in ms (default: 300)
 * @returns {Promise<T>} Result of the function
 */
export async function retryAsync(fn, maxRetries = 1, delayMs = 300) {
  return retry(fn, {
    maxRetries,
    backoff: { base: delayMs, max: delayMs, jitter: false },
  });
}
