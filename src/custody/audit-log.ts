export interface AuditEntry {
  readonly at: Date;
  readonly actor: string;
  readonly action: string;
  readonly withdrawalId?: string;
  readonly userId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditLog {
  append(entry: AuditEntry): void;
  entries(): readonly AuditEntry[];
}

/**
 * Append-only audit trail kept in memory. Entries are copied and frozen on the
 * way in, so neither the caller that appended them nor a reader can rewrite
 * history afterwards.
 */
export class InMemoryAuditLog implements AuditLog {
  readonly #entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    const copy: AuditEntry = {
      // Date is mutable even inside a frozen object, so keep a private copy.
      at: new Date(entry.at.getTime()),
      actor: entry.actor,
      action: entry.action,
      ...(entry.withdrawalId !== undefined && { withdrawalId: entry.withdrawalId }),
      ...(entry.userId !== undefined && { userId: entry.userId }),
      ...(entry.details !== undefined && { details: Object.freeze({ ...entry.details }) }),
    };
    this.#entries.push(Object.freeze(copy));
  }

  entries(): readonly AuditEntry[] {
    return Object.freeze([...this.#entries]);
  }
}
