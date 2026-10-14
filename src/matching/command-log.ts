import { MatchingEngine, OrderRejected } from './engine.js';
import type { Command, Fill, MarketConfig, Order, PlaceResult } from './types.js';

/**
 * Ordered, append-only record of every command sent to the engine. The engine
 * is a pure function of this log: replaying it rebuilds the same book and the
 * same fills, which is what makes crash recovery and audits possible.
 */
export interface CommandLog {
  append(cmd: Command): void;
  all(): Command[];
}

export class InMemoryCommandLog implements CommandLog {
  private readonly commands: Command[] = [];

  append(cmd: Command): void {
    this.commands.push({ ...cmd });
  }

  all(): Command[] {
    return this.commands.map((cmd) => ({ ...cmd }));
  }
}

export type ApplyResult =
  | { kind: 'place'; result: PlaceResult }
  | { kind: 'cancel'; cancelled: Order | null };

export function applyCommand(engine: MatchingEngine, cmd: Command): ApplyResult {
  if (cmd.kind === 'cancel') {
    return { kind: 'cancel', cancelled: engine.cancel(cmd.seq, cmd.orderId) };
  }
  return { kind: 'place', result: engine.place(cmd) };
}

/**
 * Rebuilds an engine from scratch. The log is written ahead of execution, so it
 * may hold commands the live engine rejected; validation depends only on engine
 * state, so replay rejects exactly the same commands and skips them. Any other
 * error is a bug and is rethrown.
 */
export function replay(
  log: CommandLog,
  config: MarketConfig,
): { engine: MatchingEngine; fills: Fill[] } {
  const engine = new MatchingEngine(config);
  const fills: Fill[] = [];
  for (const cmd of log.all()) {
    try {
      const applied = applyCommand(engine, cmd);
      if (applied.kind === 'place') fills.push(...applied.result.fills);
    } catch (err) {
      if (err instanceof OrderRejected) continue;
      throw err;
    }
  }
  return { engine, fills };
}
