# exchange-core

The core of a centralized crypto exchange, written in TypeScript: a double-entry ledger, a matching engine, an on-chain deposit watcher, a withdrawal pipeline and a Fastify API with a WebSocket feed.

It is a focused, tested core, not a full product. Every module runs and is covered by tests that need no database and no network.

## The problem

A P2P escrow app is simple to account for: funds sit in a contract per deal and the chain is the ledger. A custodial exchange is different. Users deposit into wallets the exchange controls, trade against each other off chain, and withdraw later. From that point the exchange's own database is the source of truth for who owns what, and it has to stay correct under retries, crashes, concurrent requests and chain reorganizations.

This repository shows how to make that move without breaking the accounting:

- money is never created or lost: every movement is a balanced journal entry;
- no order can enter the book unless it is fully funded;
- a retried request or a re-scanned block never moves money twice;
- a deposit is credited only after enough confirmations, and a reorg cannot double-credit it;
- hot-wallet keys live behind one narrow interface that nothing else touches.

## What is done

| Module | What it does |
|---|---|
| `src/ledger` | Double-entry ledger. Accounts per user, asset and bucket (`available`, `locked`) plus `fees:<asset>` and `custody:<asset>`. Deposit, lock, unlock, trade settlement, withdrawal lock, release and completion. Idempotent by key, rejects overdrafts. In-memory store and a Postgres store with row locks. Invariant checker. |
| `src/matching` | Matching engine per market. Price-time priority, limit and market orders, partial fills, cancel, self-trade prevention, tick and lot checks. Every command goes to an append-only log; `replay` rebuilds the same book and fills. |
| `src/exchange` | `ExchangeService`: connects the engine to the ledger. Locks funds before the book, settles each fill in one entry, returns unspent funds, emits trades and book deltas. |
| `src/custody` | Deposit watcher for EVM chains (ERC-20 `Transfer` logs via viem) with confirmations and reorg rollback, HD deposit addresses, and a withdrawal state machine with risk checks, admin approval, a separate signer and an audit log. |
| `src/api` | Fastify server: orders, cancel, order book, balances, withdrawals, admin approval, WebSocket stream. JSON schema validation and `Idempotency-Key` support. |

121 tests: unit tests per module, a seeded property test for the ledger, a replay-equality test for the engine, reorg scenarios on a fake chain, API tests through `app.inject` and a WebSocket test. One Postgres test runs only when `DATABASE_URL` is set.

## How it fits together

```mermaid
flowchart LR
    Client([Client]) -->|REST + WebSocket| API[Fastify API]
    API --> EX[ExchangeService]
    EX -->|1. lock funds| L[(Ledger)]
    EX -->|2. place / cancel| ME[Matching engine]
    ME -->|append| LOG[(Command log)]
    ME -->|fills| EX
    EX -->|3. settle each fill| L
    EX -->|trades, book deltas| API

    Chain[(EVM chain)] -->|blocks, Transfer logs| DW[Deposit watcher]
    DW -->|credit after N confirmations| L

    API -->|request, approve| WS[Withdrawal service]
    WS -->|lock, settle, refund| L
    WS -->|sign| SG[Signer: isolated, holds keys]
    WS -->|broadcast| Chain
```

## Key design decisions

**Money is a bigint in the smallest unit.** Wei for ETH, 1e-6 for USDT. Floats never appear on the money path. Decimal strings exist only at the API edge, and parsing rejects extra precision instead of rounding it (`src/ledger/money.ts`). Ajv type coercion is switched off, so a JSON number like `0.1` is rejected, not converted. In Postgres amounts are `NUMERIC(78,0)`, wide enough for any `uint256`.

**Double-entry ledger.** Each operation is one journal entry whose postings sum to zero per asset. Balances are a cache of the postings, and `checkInvariants` proves it: postings per asset sum to zero, every cached balance equals the sum of its postings, and no user or fee account is negative. `custody:<asset>` is a contra account, so `-balance(custody:X)` is exactly what the hot wallet should hold on chain. Reconciliation with the chain becomes one comparison.

**Overdraft checks live in the store, inside the transaction.** The Postgres store inserts the entry header first (a unique idempotency key makes a concurrent retry wait and then see a duplicate), then locks the affected balance rows with `SELECT ... FOR UPDATE` in account id order to avoid deadlocks, checks, and writes. A `CHECK` constraint backs this up, and a trigger makes postings append-only.

**Lock before book.** `ExchangeService` reserves the worst-case cost before the engine sees an order: notional at the limit price plus the higher fee rate for buys, the exact sweep cost plus taker fee for market buys, the base amount for sells. If the lock fails the book is untouched. So every resting order is funded and every fill can settle. Fees round down: rounding up could make the sum of per-fill fees exceed what was locked.

**One fill, one entry.** Buyer, seller and fee legs settle in a single journal entry, so there is no moment where one side paid and the other did not. The trade id comes from the command sequence number, so re-running settlement after a crash is a no-op.

**Deterministic replay.** Commands get a sequence number and are written to the command log before they run. The engine has no clocks and no randomness, so replaying the log rebuilds the same book and the same fills. The tests compare a live run against a replay over a busy sequence of orders, market orders, cancels and self-trades. Commands for one market run through a promise queue, because ledger calls are async and two orders must never interleave between "compute lock" and "enter the book".

**Confirmations and reorg rollback.** The deposit watcher keeps recent block hashes. When a new block's `parentHash` does not match, it walks back to the fork point, voids pending deposits from orphaned blocks and re-scans. Credits happen only at N confirmations, with the idempotency key `chainId:txHash:logIndex`, so a transaction that reappears in the new fork is not credited twice. Logs are fetched by block hash, not number, so they always belong to the header that was checked. The cursor is saved after each step, so a restart resumes where it stopped.

**Isolated signer.** The withdrawal service never sees keys. It calls a `Signer` interface; in production that is a separate service (HSM or MPC) with its own access rules. Withdrawals at or above a per-asset threshold wait for an admin, an admin cannot approve their own withdrawal, frozen users cannot withdraw, and every state change is written to an audit log. A failed or rejected withdrawal returns the funds through the ledger.

**Idempotency keys everywhere money moves.** Ledger entries, trade settlement, deposit credits, withdrawal steps and the `Idempotency-Key` header on `POST /orders` and `POST /withdrawals` (required for withdrawals). Reusing a key with different content is an error, not a silent replay.

## Selected code

| File | What it shows |
|---|---|
| [`src/ledger/ledger.ts`](src/ledger/ledger.ts) | Business operations as balanced journal entries, trade settlement in one entry |
| [`src/ledger/pg-store.ts`](src/ledger/pg-store.ts) | Postgres transaction: idempotency, `FOR UPDATE` in stable order, overdraft check |
| [`sql/schema.sql`](sql/schema.sql) | Schema with `NUMERIC(78,0)`, no-overdraft constraint, append-only postings |
| [`src/ledger/invariants.ts`](src/ledger/invariants.ts) | Invariant checker used by tests and suitable for a periodic audit job |
| [`tests/ledger/ledger.property.test.ts`](tests/ledger/ledger.property.test.ts) | Seeded random operations, invariants checked along the way |
| [`src/matching/engine.ts`](src/matching/engine.ts) | Price-time priority book, partial fills, self-trade prevention |
| [`src/matching/command-log.ts`](src/matching/command-log.ts) | Append-only command log and deterministic replay |
| [`src/exchange/exchange-service.ts`](src/exchange/exchange-service.ts) | Lock before book, settlement per fill, release of unspent funds, per-market queue |
| [`src/exchange/market.ts`](src/exchange/market.ts) | Exact notional and fee math, price conversion between API and engine units |
| [`src/custody/deposit-watcher.ts`](src/custody/deposit-watcher.ts) | Confirmations, reorg detection and rollback, exactly-once credits, resumable cursor |
| [`src/custody/viem-chain-reader.ts`](src/custody/viem-chain-reader.ts) | ERC-20 `Transfer` logs through viem, fetched by block hash |
| [`src/custody/withdrawals.ts`](src/custody/withdrawals.ts) | Withdrawal state machine, risk checks, approval, refunds, audit trail |
| [`src/api/app.ts`](src/api/app.ts) | Fastify routes, schema validation, error mapping, WebSocket stream |
| [`src/api/idempotency.ts`](src/api/idempotency.ts) | Idempotency-Key handling, including retries that arrive while the first attempt runs |

## How to run

Requires Node 22+ and pnpm.

```bash
pnpm i
pnpm test         # all tests, offline
pnpm typecheck
pnpm dev          # API on http://127.0.0.1:3000 with two demo users, alice and bob
```

Try it:

```bash
curl -s localhost:3000/accounts/alice/balances -H 'x-user-id: alice'

curl -s -X POST localhost:3000/orders -H 'x-user-id: bob' -H 'content-type: application/json' \
  -d '{"market":"ETH-USDT","side":"sell","type":"limit","price":"2500","quantity":"1"}'

curl -s -X POST localhost:3000/orders -H 'x-user-id: alice' -H 'idempotency-key: order-1' \
  -H 'content-type: application/json' \
  -d '{"market":"ETH-USDT","side":"buy","type":"limit","price":"2500","quantity":"0.4"}'

curl -s localhost:3000/markets/ETH-USDT/book
```

WebSocket feed: connect to `ws://127.0.0.1:3000/ws?market=ETH-USDT`. It sends a book snapshot, then `book` deltas (absolute size per price level) and `trade` messages.

The `x-user-id` header is a demo stand-in for authentication. Admin routes accept the user id `admin`.

Optional Postgres integration test:

```bash
docker compose up -d
DATABASE_URL=postgres://exchange:exchange@localhost:5432/exchange pnpm test
```

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/orders` | `{market, side, type, price?, quantity}`, decimal strings. Optional `Idempotency-Key`. |
| `DELETE` | `/orders/:id` | Owner only. Unlocks the unfilled part. |
| `GET` | `/markets/:market/book` | Aggregated depth, `?depth=1..999` |
| `GET` | `/accounts/:user/balances` | Own balances only (or admin) |
| `POST` | `/withdrawals` | `{asset, amount, to}`. `Idempotency-Key` required. |
| `POST` | `/admin/withdrawals/:id/approve` | Admin only, cannot approve own withdrawal |
| `GET` | `/ws?market=` | WebSocket: snapshot, book deltas, trades |

## Tech stack

TypeScript (strict), Node.js 22, Fastify 5, `@fastify/websocket`, viem, PostgreSQL with `pg`, Vitest, tsx, pnpm, GitHub Actions.

## Limitations and what a production version would add

- **Keys:** MPC or HSM signing, hot and cold wallet split, sweeping from deposit addresses, withdrawal address allowlists. Deposit addresses should be derived from an xpub on a watch-only service so the watcher never holds a seed.
- **Chains:** the watcher reads ERC-20 transfers only. Native ETH needs transaction or trace scanning. More chains (Bitcoin, Tron, Solana) need their own readers behind the same interface. Gas and network fees for withdrawals are not modelled.
- **Durability:** the command log, order state, withdrawal records and watcher cursor are in memory here. Production would keep them in Postgres (or Kafka for the command log) and run a recovery step on start: replay the log, re-run settlement (idempotent), reconcile locks.
- **Compliance:** KYC and AML screening, travel rule, sanctions checks on withdrawal addresses, per-tier limits.
- **Fiat rails:** bank deposits and payouts, card and payment providers.
- **Scale:** one process per market is fine for an MVP. At scale the matching engine moves to a dedicated service fed by a durable log, with a tree-based book and snapshots to bound replay time.
- **Product:** real authentication and roles, order types beyond limit and market (stop, post-only, IOC/FOK flags), fee tiers, rate limits, private WebSocket channels for user orders.

## My role

Designed and built end to end by Eugene Akhrimienko.

## License

All rights reserved. Published for viewing only, see [LICENSE](LICENSE).
