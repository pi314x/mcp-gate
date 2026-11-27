import type { GateConfig } from '../config.js';
import { addressOf, fromAtomic, sameAddress, signPayment, toAtomic, type PaymentPayload, type PaymentRequired, type PaymentRequirements } from './x402.js';

type BuyerConfig = NonNullable<GateConfig['buyer']>;

export type PayDecision =
  | { pay: true; payment: PaymentPayload; amount: bigint; requirements: PaymentRequirements; label: string }
  | { pay: false; reason: string };

/**
 * The agent-side wallet. It pays only in the network and asset pairs it is allowed, only recipients on its list when
 * there is one, and never past a cap: per call, per session and per UTC day. Money is counted when a payment is sent and
 * given back when the seller reports it did not charge, so a refused or failed call does not eat into the caps. The day
 * total lives in this process; a restart resets it, so keep maxPerDay at what you can afford to lose twice.
 */
export class Wallet {
  readonly address: string;
  private day = '';
  private spentToday = 0n;

  constructor(
    private readonly config: BuyerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    this.address = addressOf(config.privateKey);
  }

  private today(): bigint {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spentToday = 0n;
    }
    return this.spentToday;
  }

  get todaySpent(): bigint {
    return this.today();
  }

  /** Picks the first offer this wallet may pay, checks the caps, and signs it. `sessionSpent` is the caller's session total. */
  decide(required: PaymentRequired, sessionSpent: bigint): PayDecision {
    const reasons: string[] = [];
    for (const requirements of required.accepts) {
      const allowed = this.config.allow.find((entry) => entry.network === requirements.network && sameAddress(entry.asset, requirements.asset));
      if (requirements.scheme !== 'exact' || allowed === undefined) {
        reasons.push(`${requirements.scheme} on ${requirements.network} in ${requirements.asset} is not an allowed payment`);
        continue;
      }
      if (this.config.payTo.length > 0 && !this.config.payTo.some((recipient) => sameAddress(recipient, requirements.payTo))) {
        reasons.push(`${requirements.payTo} is not on the wallet's list of recipients`);
        continue;
      }
      let amount: bigint;
      try {
        amount = BigInt(requirements.amount);
      } catch {
        reasons.push('the price is not a whole number of atomic units');
        continue;
      }
      const label = `${fromAtomic(amount, allowed.decimals)} ${allowed.symbol}`;
      const caps: [string, bigint, bigint][] = [
        ['maxPerCall', toAtomic(this.config.maxPerCall, allowed.decimals), 0n],
        ['maxPerSession', toAtomic(this.config.maxPerSession, allowed.decimals), sessionSpent],
        ['maxPerDay', toAtomic(this.config.maxPerDay, allowed.decimals), this.today()]
      ];
      const over = caps.find(([, cap, spent]) => spent + amount > cap);
      if (amount <= 0n) {
        reasons.push('a price of zero or less is not a payment');
        continue;
      }
      if (over !== undefined) {
        const [name, cap, spent] = over;
        return { pay: false, reason: `${label} would go past ${name} (${fromAtomic(cap, allowed.decimals)} ${allowed.symbol}, ${fromAtomic(spent, allowed.decimals)} already spent)` };
      }
      this.spentToday = this.today() + amount;
      return { pay: true, payment: signPayment(this.config.privateKey, required, requirements), amount, requirements, label };
    }
    return { pay: false, reason: reasons.length > 0 ? reasons.join('; ') : 'the seller offered no way to pay' };
  }

  /** The seller did not charge (the tool failed, or settlement did not happen): give the amount back to the caps. */
  refund(amount: bigint): void {
    this.spentToday = this.today() - amount < 0n ? 0n : this.today() - amount;
  }
}
