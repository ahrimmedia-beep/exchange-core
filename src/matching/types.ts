/**
 * Units: prices are quote-asset smallest units per base lot, quantities are
 * base-asset smallest units. Everything is bigint so no rounding ever happens
 * inside the engine.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';

export interface MarketConfig {
  market: string;
  tickSize: bigint;
  lotSize: bigint;
}

export interface Order {
  id: string;
  userId: string;
  side: Side;
  type: OrderType;
  price?: bigint;
  qty: bigint;
  remaining: bigint;
  /** Sequence number of the command that created the order (time priority). */
  seq: number;
}

export interface Fill {
  seq: number;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  /** Always the maker's resting price. */
  price: bigint;
  qty: bigint;
  takerSide: Side;
}

export interface PlaceResult {
  fills: Fill[];
  /** Present when a limit remainder was added to the book. */
  resting?: Order;
  /** Unfilled quantity dropped: market leftover or self-trade prevention. */
  cancelledQty: bigint;
}

export interface PlaceCommand {
  seq: number;
  orderId: string;
  userId: string;
  side: Side;
  type: OrderType;
  price?: bigint;
  qty: bigint;
}

export interface CancelCommand {
  seq: number;
  orderId: string;
}

export type Command =
  | ({ kind: 'place' } & PlaceCommand)
  | ({ kind: 'cancel' } & CancelCommand);

export type BookLevel = [price: bigint, qty: bigint];

export interface BookSnapshot {
  bids: BookLevel[];
  asks: BookLevel[];
}
