import { sleep } from "./sleep.js";

/**
 * Retries a function with exponential backoff
 * @param fn - The async function to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param initialDelayMs - Initial delay in milliseconds before first retry (default: 1000)
 * @param shouldRetry - Optional function to determine if an error should be retried (default: retry all errors)
 * @returns The result of the function, or throws the last error if all retries fail
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
  shouldRetry?: (error: unknown) => boolean
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }
      
      // Don't retry on the last attempt
      if (attempt < maxRetries) {
        // Exponential backoff: delay = initialDelay * 2^attempt
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }
  }
  
  // All retries exhausted, throw the last error
  throw lastError;
}

/**
 * Determines if an HTTP error status should be retried
 * Retries on: 429 (rate limit), 500-599 (server errors), network errors
 * Does not retry on: 400-499 (client errors except 429)
 */
export function shouldRetryHttpError(error: unknown): boolean {
  // Network errors (fetch failures)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  
  // Check if error has a status property (HTTP response)
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    // Retry on rate limits and server errors
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // Don't retry on client errors (except 429)
    if (status >= 400 && status < 500) {
      return false;
    }
  }
  
  // Default: retry on unknown errors
  return true;
}
