import { keccak256, stringToHex, type Address, type Hex } from 'viem';

export interface SignRequest {
  readonly withdrawalId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly to: Address;
}

export interface SignedTx {
  readonly rawTx: Hex;
  readonly txHash: Hex;
}

/**
 * Holds the hot-wallet keys. Lives behind an interface so the withdrawal flow
 * never touches key material and can be pointed at an HSM or MPC service.
 */
export interface Signer {
  sign(request: SignRequest): Promise<SignedTx>;
}

export interface BroadcastRequest extends SignedTx {
  readonly withdrawalId: string;
  readonly asset: string;
}

/** Pushes an already signed transaction to the network. */
export interface Broadcaster {
  broadcast(request: BroadcastRequest): Promise<void>;
}

/** Test signer: deterministic output, records every request, can be told to fail. */
export class FakeSigner implements Signer {
  readonly requests: SignRequest[] = [];
  #failure: Error | undefined;

  failWith(error: Error = new Error('signer unavailable')): void {
    this.#failure = error;
  }

  recover(): void {
    this.#failure = undefined;
  }

  async sign(request: SignRequest): Promise<SignedTx> {
    this.requests.push(request);
    if (this.#failure) throw this.#failure;
    const rawTx = stringToHex(
      `${request.withdrawalId}|${request.asset}|${request.amount.toString()}|${request.to}`,
    );
    return { rawTx, txHash: keccak256(rawTx) };
  }
}

/** Test broadcaster: records what was sent, can be told to fail. */
export class FakeBroadcaster implements Broadcaster {
  readonly sent: BroadcastRequest[] = [];
  #failure: Error | undefined;

  failWith(error: Error = new Error('node unreachable')): void {
    this.#failure = error;
  }

  recover(): void {
    this.#failure = undefined;
  }

  async broadcast(request: BroadcastRequest): Promise<void> {
    if (this.#failure) throw this.#failure;
    this.sent.push(request);
  }
}
