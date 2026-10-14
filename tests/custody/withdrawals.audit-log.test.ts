import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '../../src/custody/audit-log.js';

describe('InMemoryAuditLog', () => {
  it('keeps entries in append order', () => {
    const log = new InMemoryAuditLog();
    log.append({ at: new Date(1), actor: 'a', action: 'first' });
    log.append({ at: new Date(2), actor: 'b', action: 'second' });

    expect(log.entries().map((e) => e.action)).toEqual(['first', 'second']);
  });

  it('cannot be rewritten through appended or returned objects', () => {
    const log = new InMemoryAuditLog();
    const at = new Date('2026-01-01T00:00:00Z');
    const details = { amount: '5' };
    log.append({ at, actor: 'admin', action: 'user.frozen', details });

    at.setFullYear(2000);
    details.amount = '500';
    const [entry] = log.entries();

    expect(entry?.at.getUTCFullYear()).toBe(2026);
    expect(entry?.details).toEqual({ amount: '5' });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.details)).toBe(true);
    expect(Object.isFrozen(log.entries())).toBe(true);
    expect(() => (log.entries() as unknown[]).push({})).toThrow();
  });
});
