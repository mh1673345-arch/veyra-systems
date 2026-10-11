/**
 * Rate limiting behind an interface so the store can be swapped without
 * touching the routes.
 *
 * Today there is only a memory implementation, which is correct for a single
 * process and honest about its limits: counters are per-instance and reset on
 * restart. A multi-instance deployment needs a shared store — implement
 * RateLimiter against Redis and return it from createRateLimiter(). Redis is
 * deliberately NOT added here, because the infrastructure doesn't exist yet
 * and an unused dependency would only look like protection.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry, when blocked. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  readonly name: string;
  consume(key: string): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
}

interface Entry {
  count: number;
  firstAt: number;
}

export class MemoryRateLimiter implements RateLimiter {
  readonly name = "memory";
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: RateLimitOptions) {}

  async consume(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.firstAt > this.options.windowMs) {
      this.entries.set(key, { count: 1, firstAt: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    entry.count += 1;

    if (entry.count > this.options.maxAttempts) {
      const retryAfterMs = this.options.windowMs - (now - entry.firstAt);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  return new MemoryRateLimiter(options);
}
