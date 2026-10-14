import { InMemoryAuditLog } from '../custody/audit-log.js';
import { FakeBroadcaster, FakeSigner, type Broadcaster, type Signer } from '../custody/signer.js';
import { withdrawalLedger } from '../custody/withdrawal-ledger-adapter.js';
import { WithdrawalService } from '../custody/withdrawals.js';
import { ExchangeService } from '../exchange/exchange-service.js';
import type { Market } from '../exchange/market.js';
import { InMemoryLedgerStore, Ledger, type AssetRegistry, type LedgerStore } from '../ledger/index.js';
import { toUnits } from '../ledger/money.js';

export const DEFAULT_ASSETS: AssetRegistry = {
  ETH: { decimals: 18 },
  USDT: { decimals: 6 },
};

/** 0.001 ETH lots, 0.01 USDT ticks (expressed per lot), 0.10% maker / 0.20% taker. */
export const DEFAULT_MARKETS: Market[] = [
  {
    market: 'ETH-USDT',
    base: 'ETH',
    quote: 'USDT',
    baseDecimals: 18,
    quoteDecimals: 6,
    lotSize: 10n ** 15n,
    tickSize: 10n,
    makerFeeBps: 10n,
    takerFeeBps: 20n,
  },
];

export interface Core {
  ledger: Ledger;
  exchange: ExchangeService;
  withdrawals: WithdrawalService;
  audit: InMemoryAuditLog;
}

export interface CoreOptions {
  store?: LedgerStore;
  signer?: Signer;
  broadcaster?: Broadcaster;
  now?: () => Date;
}

/**
 * Wires the modules together. Everything defaults to in-memory implementations so the
 * server and the tests run with no database and no network. The fake signer and
 * broadcaster sign nothing and send nothing: in production the Signer is a separate
 * service (HSM or MPC) and is the only component that can reach key material.
 */
export function createCore(options: CoreOptions = {}): Core {
  const ledger = new Ledger(options.store ?? new InMemoryLedgerStore(), DEFAULT_ASSETS);
  const audit = new InMemoryAuditLog();
  const units = (asset: string, v: string) => toUnits(v, DEFAULT_ASSETS[asset]!.decimals);

  return {
    ledger,
    audit,
    exchange: new ExchangeService({ ledger, markets: DEFAULT_MARKETS }),
    withdrawals: new WithdrawalService({
      ledger: withdrawalLedger(ledger),
      signer: options.signer ?? new FakeSigner(),
      broadcaster: options.broadcaster ?? new FakeBroadcaster(),
      audit,
      approvalThreshold: { ETH: units('ETH', '5'), USDT: units('USDT', '10000') },
      dailyLimit: { ETH: units('ETH', '50'), USDT: units('USDT', '100000') },
      ...(options.now && { now: options.now }),
    }),
  };
}
