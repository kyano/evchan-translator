// EVChan Translator - Retry Utility
// Provides retry logic for async operations

/**
 * Execute an async function with retry on failure.
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {number} [maxRetries] - Maximum retry attempts (default: 1)
 * @param {number} [delayMs] - Delay between retries in ms (default: 300)
 * @returns {Promise<T>} Result of the function
 */
export async function retryAsync(fn, maxRetries = 1, delayMs = 300) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError;
}
