export interface StoredResponse {
  status: number;
  body: unknown;
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  constructor(key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request`);
  }
}

/**
 * Remembers the response to each (user, route, Idempotency-Key) so a client that retries
 * after a timeout gets the original answer instead of a second order or withdrawal.
 *
 * The promise is stored before the handler runs, so a retry that arrives while the first
 * attempt is still in flight waits for it rather than racing it. Failed attempts are not
 * kept: a rejected order or withdrawal changed nothing, so running it again is safe and
 * lets the client retry after fixing the cause. In-memory and unbounded here; production
 * would keep this in Postgres or Redis with a TTL of about 24 hours.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, { fingerprint: string; response: Promise<StoredResponse> }>();

  async run(
    scope: string,
    key: string,
    fingerprint: string,
    handler: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    const id = `${scope}\u0000${key}`;
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyKeyReusedError(key);
      return { ...(await existing.response), replayed: true };
    }

    const response = handler();
    this.entries.set(id, { fingerprint, response });
    try {
      const result = await response;
      if (result.status >= 500) this.entries.delete(id);
      return { ...result, replayed: false };
    } catch (err) {
      this.entries.delete(id);
      throw err;
    }
  }
}
