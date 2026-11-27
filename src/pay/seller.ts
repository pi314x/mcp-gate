import type { CallToolResult } from '@modelcontextprotocol/client';
import type { GateConfig } from '../config.js';
import {
  META_PAYMENT,
  META_RESPONSE,
  X402_VERSION,
  paymentRequiredResult,
  recoverSigner,
  sameAddress,
  toAtomic,
  toolResource,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse
} from './x402.js';

type SellerConfig = NonNullable<GateConfig['seller']>;

export interface SaleRecord {
  tool: string;
  amount: bigint;
  settled: boolean;
}

/**
 * The paywall: a priced tool runs only after a payment for exactly its price verified, and the payment is settled only
 * after the tool succeeded, so a failing tool costs the buyer nothing. A payment is accepted once: its nonce is
 * remembered until the authorization expires, so the same signature cannot buy two calls while it waits to settle.
 */
export class Seller {
  private readonly seen = new Map<string, number>();
  readonly sales: SaleRecord[] = [];

  constructor(
    private readonly config: SellerConfig,
    private readonly prices: Map<string, string>,
    private readonly facilitator: Facilitator,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  priced(tool: string): boolean {
    return this.prices.has(tool);
  }

  requirementsFor(tool: string): PaymentRequirements | undefined {
    const price = this.prices.get(tool);
    if (price === undefined) return undefined;
    return {
      scheme: 'exact',
      network: this.config.network,
      amount: toAtomic(price, this.config.decimals).toString(),
      asset: this.config.asset,
      payTo: this.config.payTo,
      maxTimeoutSeconds: this.config.maxTimeoutSeconds,
      extra: { name: this.config.assetName, version: this.config.assetVersion }
    };
  }

  /** What the tool listing advertises, so a buyer knows the price before it calls. */
  priceMeta(tool: string): Record<string, unknown> | undefined {
    const requirements = this.requirementsFor(tool);
    return requirements === undefined ? undefined : { accepts: [requirements], price: this.prices.get(tool), resource: toolResource(tool) };
  }

  private required(tool: string, requirements: PaymentRequirements, error?: string): CallToolResult {
    const required: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error !== undefined && { error }),
      resource: { url: toolResource(tool), description: `one call to ${tool}`, mimeType: 'application/json' },
      accepts: [requirements]
    };
    return paymentRequiredResult(required);
  }

  /** The reason a payment does not buy this call, checked here before the facilitator is asked. */
  private problem(tool: string, payment: PaymentPayload, requirements: PaymentRequirements): string | undefined {
    if (payment?.x402Version !== X402_VERSION || payment.payload?.authorization === undefined || typeof payment.payload.signature !== 'string') {
      return 'invalid_payload';
    }
    const { accepted } = payment;
    const authorization = payment.payload.authorization;
    if (payment.resource?.url !== toolResource(tool)) return 'wrong_resource';
    if (
      accepted?.scheme !== requirements.scheme ||
      accepted.network !== requirements.network ||
      accepted.amount !== requirements.amount ||
      !sameAddress(accepted.asset, requirements.asset) ||
      !sameAddress(accepted.payTo, requirements.payTo)
    ) {
      return 'requirements_mismatch';
    }
    if (authorization.value !== requirements.amount) return 'invalid_amount';
    if (!sameAddress(authorization.to, requirements.payTo)) return 'invalid_recipient';
    const now = this.now();
    if (Number(authorization.validBefore) <= now) return 'expired';
    if (Number(authorization.validAfter) > now) return 'not_yet_valid';
    const signer = recoverSigner(requirements, authorization, payment.payload.signature);
    if (signer === undefined || !sameAddress(signer, authorization.from)) return 'invalid_signature';
    if (this.seen.has(authorization.nonce.toLowerCase())) return 'nonce_already_used';
    return undefined;
  }

  async handle(tool: string, meta: Record<string, unknown> | undefined, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const requirements = this.requirementsFor(tool);
    if (requirements === undefined) return run();
    const payment = meta?.[META_PAYMENT] as PaymentPayload | undefined;
    if (payment === undefined) return this.required(tool, requirements);

    this.forgetExpired();
    const problem = this.problem(tool, payment, requirements);
    if (problem !== undefined) return this.required(tool, requirements, problem);
    const nonce = payment.payload.authorization.nonce.toLowerCase();
    this.seen.set(nonce, Number(payment.payload.authorization.validBefore));

    let verified;
    try {
      verified = await this.facilitator.verify(payment, requirements);
    } catch {
      this.seen.delete(nonce);
      return this.required(tool, requirements, 'facilitator_unreachable');
    }
    if (!verified.isValid) return this.required(tool, requirements, verified.invalidReason ?? 'payment_invalid');

    const result = await run();
    const amount = BigInt(requirements.amount);
    if (result.isError === true) {
      // The authorization is never settled, so it lapses: the buyer pays nothing for a call that failed.
      this.sales.push({ tool, amount, settled: false });
      return withResponse(result, { success: false, errorReason: 'tool_failed_not_charged', network: requirements.network });
    }
    let settled: SettleResponse;
    try {
      settled = await this.facilitator.settle(payment, requirements);
    } catch (error) {
      settled = { success: false, errorReason: `settlement_failed: ${error instanceof Error ? error.message : String(error)}`, network: requirements.network };
    }
    this.sales.push({ tool, amount, settled: settled.success });
    return withResponse(result, settled);
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [nonce, validBefore] of this.seen) if (validBefore <= now) this.seen.delete(nonce);
  }
}

const withResponse = (result: CallToolResult, response: SettleResponse): CallToolResult => ({
  ...result,
  _meta: { ...(result._meta ?? {}), [META_RESPONSE]: response }
});
