import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Gate } from '../src/gate.js';
import {
  META_PAYMENT,
  META_PRICE,
  META_RESPONSE,
  addressOf,
  fromAtomic,
  readPaymentRequired,
  recoverSigner,
  sameAddress,
  signPayment,
  toAtomic,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequired
} from '../src/pay/x402.js';
import { createGateServer } from '../src/server.js';
import { fakeServer, textOf } from './helpers.js';

// Well-known development keys (Hardhat accounts #0 and #1). They never hold real funds.
const BUYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Hardhat account #1's address: the seller is paid here, so OTHER_KEY's address is the recipient.
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// Hardhat account #2: someone who is neither the buyer nor the recipient.
const STRANGER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NETWORK = 'eip155:84532';

/** Plays an x402 facilitator: checks the signature by recovering its signer, the payer's balance, and moves the money. */
function fakeFacilitator(balances: Map<string, bigint> = new Map([[addressOf(BUYER_KEY).toLowerCase(), 1_000_000n]])) {
  const calls = { verify: 0, settle: 0 };
  const settled: { from: string; to: string; value: bigint }[] = [];
  const state = { invalid: undefined as string | undefined, unreachable: false };
  const facilitator: Facilitator = {
    async verify(payload, requirements) {
      calls.verify += 1;
      if (state.unreachable) throw new Error('connect ECONNREFUSED');
      if (state.invalid !== undefined) return { isValid: false, invalidReason: state.invalid };
      const { authorization, signature } = payload.payload;
      const signer = recoverSigner(requirements, authorization, signature);
      if (signer === undefined || !sameAddress(signer, authorization.from)) return { isValid: false, invalidReason: 'invalid_signature' };
      if ((balances.get(authorization.from.toLowerCase()) ?? 0n) < BigInt(authorization.value)) return { isValid: false, invalidReason: 'insufficient_funds' };
      return { isValid: true, payer: authorization.from };
    },
    async settle(payload) {
      calls.settle += 1;
      const { from, to, value } = payload.payload.authorization;
      balances.set(from.toLowerCase(), (balances.get(from.toLowerCase()) ?? 0n) - BigInt(value));
      settled.push({ from, to, value: BigInt(value) });
      return { success: true, transaction: `0x${'1'.repeat(64)}`, network: NETWORK, payer: from };
    }
  };
  return { facilitator, calls, settled, state, balances };
}

const POOLS = {
  analyze_pool: {
    description: 'Deep on-chain safety analysis of one pool',
    schema: z.object({ pair: z.string().optional(), fail: z.boolean().optional() }),
    run: (args: Record<string, unknown>) => {
      if (args.fail === true) throw new Error('rpc down');
      return JSON.stringify({ pair: args.pair ?? '0xpair', score: 82, verdict: 'PROMISING' });
    }
  },
  list_pools: { description: 'List analyzed pools (free preview)' },
  start_trading: { description: 'Start the autotrader' }
};

const SELLER = { payTo: PAY_TO, network: NETWORK, asset: USDC, facilitatorUrl: 'https://facilitator.invalid' };

interface Opened {
  client: Client;
  gate: Gate;
  close(): Promise<void>;
}

const opened: Opened[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0).reverse()) await handle.close();
});

async function connect(gate: Gate): Promise<Opened> {
  const session = gate.createSession();
  const server = createGateServer(gate, session);
  session.setNotifier(() => void server.sendToolListChanged().catch(() => undefined));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const handle = {
    client,
    gate,
    async close() {
      await client.close();
      await server.close();
    }
  };
  opened.push(handle);
  return handle;
}

/** The paywall: a gate in front of a "pools" server, selling analyze_pool for 0.002 USDC. */
async function sellerGate(options: { facilitator?: Facilitator; policy?: Record<string, unknown>; now?: () => number } = {}) {
  const config = parseConfig({
    servers: { pools: { command: 'unused', pricing: { analyze_pool: '0.002' }, policy: options.policy ?? { allow: ['analyze_pool', 'list_pools'] } } },
    gate: { autoEnable: ['pools__*'] },
    seller: SELLER
  });
  const gate = new Gate(config, { pools: fakeServer(POOLS).connector }, undefined, undefined, {
    facilitator: options.facilitator ?? fakeFacilitator().facilitator,
    ...(options.now !== undefined && { now: options.now })
  });
  await gate.start();
  opened.push({ client: undefined as never, gate, close: () => gate.close() });
  return gate;
}

/** The agent side: a gate whose downstream "market" is the seller gate, paying from BUYER_KEY within caps. */
async function buyerGate(seller: Gate, buyer: Record<string, unknown> = {}, today?: () => Date) {
  const sellerUnit = () => {
    const session = seller.createSession();
    const server = createGateServer(seller, session);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return clientSide;
  };
  const config = parseConfig(
    {
      servers: { market: { command: 'unused' } },
      gate: { autoEnable: ['market__*'] },
      buyer: {
        privateKey: '${TEST_WALLET_KEY}',
        allow: [{ network: NETWORK, asset: USDC }],
        maxPerCall: '0.01',
        maxPerSession: '0.05',
        maxPerDay: '0.10',
        ...buyer
      }
    },
    { TEST_WALLET_KEY: BUYER_KEY }
  );
  const gate = new Gate(config, { market: sellerUnit }, undefined, undefined, { ...(today !== undefined && { today }) });
  await gate.start();
  opened.push({ client: undefined as never, gate, close: () => gate.close() });
  return connect(gate);
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
  client.callTool({ name, arguments: args, ...(meta !== undefined && { _meta: meta }) });

describe('amounts', () => {
  it('converts exactly, never through a float', () => {
    expect(toAtomic('0.002', 6)).toBe(2000n);
    expect(toAtomic('1', 6)).toBe(1_000_000n);
    expect(fromAtomic(toAtomic('0.1', 6) + toAtomic('0.2', 6), 6)).toBe('0.3');
    expect(fromAtomic(2000n, 6)).toBe('0.002');
    expect(() => toAtomic('0.0000001', 6)).toThrow(/more than 6 decimals/);
    expect(() => toAtomic('-1', 6)).toThrow(/not a plain decimal/);
  });
});

describe('the seller gate (paywall)', () => {
  it('answers an unpaid call with the x402 v2 PaymentRequired result, in both shapes the MCP transport spec requires', async () => {
    const { client } = await connect(await sellerGate());
    const result = await call(client, 'pools__analyze_pool');
    expect(result.isError).toBe(true);
    const required = result.structuredContent as unknown as PaymentRequired;
    expect(required).toMatchObject({
      x402Version: 2,
      resource: { url: 'mcp://tool/pools__analyze_pool' },
      accepts: [{ scheme: 'exact', network: NETWORK, amount: '2000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }]
    });
    expect(JSON.parse(textOf(result))).toEqual(required);
  });

  it('advertises the price in tools/list and leaves free tools alone', async () => {
    const { client } = await connect(await sellerGate());
    const { tools } = await client.listTools();
    const paid = tools.find((tool) => tool.name === 'pools__analyze_pool')!;
    expect(paid.description).toMatch(/\[Paid tool: 0\.002 per call, via x402\.\]$/);
    expect((paid._meta?.[META_PRICE] as { accepts: unknown[] }).accepts).toHaveLength(1);
    const free = tools.find((tool) => tool.name === 'pools__list_pools')!;
    expect(free._meta).toBeUndefined();
    expect(free.description).not.toMatch(/Paid/);
  });

  it('runs the tool for a valid payment, settles it, and returns the receipt', async () => {
    const fake = fakeFacilitator();
    const seller = await sellerGate({ facilitator: fake.facilitator });
    const { client } = await connect(seller);
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    const payment = signPayment(BUYER_KEY, required, required.accepts[0]!);
    const result = await call(client, 'pools__analyze_pool', { pair: '0xabc' }, { [META_PAYMENT]: payment });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ pair: '0xabc', verdict: 'PROMISING' });
    expect(result._meta?.[META_RESPONSE]).toMatchObject({ success: true, network: NETWORK });
    expect(fake.settled).toEqual([{ from: addressOf(BUYER_KEY), to: PAY_TO, value: 2000n }]);
    expect(seller.seller!.sales).toEqual([{ tool: 'pools__analyze_pool', amount: 2000n, settled: true }]);
  });

  it('accepts a payment once: the same signature cannot buy a second call', async () => {
    const fake = fakeFacilitator();
    const { client } = await connect(await sellerGate({ facilitator: fake.facilitator }));
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    const payment = signPayment(BUYER_KEY, required, required.accepts[0]!);
    await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment });
    const again = await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment });
    expect(readPaymentRequired(again as never)?.error).toBe('nonce_already_used');
    expect(fake.calls.settle).toBe(1);
  });

  it.each([
    ['a lower amount than the price', (p: PaymentPayload) => ({ ...p, accepted: { ...p.accepted, amount: '1' } }), 'requirements_mismatch'],
    ['another recipient', (p: PaymentPayload) => ({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, to: addressOf(STRANGER_KEY) } } }), 'invalid_recipient'],
    ['a signature by someone other than the payer it names', (p: PaymentPayload) => ({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, from: addressOf(OTHER_KEY) } } }), 'invalid_signature'],
    ['another tool', (p: PaymentPayload) => ({ ...p, resource: { url: 'mcp://tool/pools__list_pools' } }), 'wrong_resource'],
    ['garbage', () => ({ hello: 'world' }) as unknown as PaymentPayload, 'invalid_payload']
  ])('refuses a payment with %s, before asking the facilitator', async (_label, tamper, reason) => {
    const fake = fakeFacilitator();
    const { client } = await connect(await sellerGate({ facilitator: fake.facilitator }));
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    const payment = tamper(signPayment(BUYER_KEY, required, required.accepts[0]!));
    const result = await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment });
    expect(readPaymentRequired(result as never)?.error).toBe(reason);
    expect(fake.calls.verify).toBe(0);
  });

  it('refuses an expired authorization', async () => {
    let now = Math.floor(Date.now() / 1000);
    const { client } = await connect(await sellerGate({ now: () => now }));
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    const payment = signPayment(BUYER_KEY, required, required.accepts[0]!, { nowSeconds: now });
    now += 3600;
    expect(readPaymentRequired((await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment })) as never)?.error).toBe('expired');
  });

  it('does not charge for a tool that failed: the authorization is never settled', async () => {
    const fake = fakeFacilitator();
    const seller = await sellerGate({ facilitator: fake.facilitator });
    const { client } = await connect(seller);
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    const result = await call(client, 'pools__analyze_pool', { fail: true }, { [META_PAYMENT]: signPayment(BUYER_KEY, required, required.accepts[0]!) });
    expect(result.isError).toBe(true);
    expect(result._meta?.[META_RESPONSE]).toMatchObject({ success: false, errorReason: 'tool_failed_not_charged' });
    expect(fake.calls.settle).toBe(0);
  });

  it('turns a facilitator rejection or outage into PaymentRequired with the reason, and does not run the tool', async () => {
    const fake = fakeFacilitator();
    const { client } = await connect(await sellerGate({ facilitator: fake.facilitator }));
    const required = readPaymentRequired((await call(client, 'pools__analyze_pool')) as never)!;
    fake.state.invalid = 'insufficient_funds';
    expect(readPaymentRequired((await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: signPayment(BUYER_KEY, required, required.accepts[0]!) })) as never)?.error).toBe('insufficient_funds');
    fake.state.invalid = undefined;
    fake.state.unreachable = true;
    const payment = signPayment(BUYER_KEY, required, required.accepts[0]!);
    expect(readPaymentRequired((await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment })) as never)?.error).toBe('facilitator_unreachable');
    // An outage is not the buyer's fault: the same payment may be tried again once the facilitator is back.
    fake.state.unreachable = false;
    expect((await call(client, 'pools__analyze_pool', {}, { [META_PAYMENT]: payment })).isError).not.toBe(true);
    expect(fake.calls.settle).toBe(1);
  });

  it('is a storefront: customers see the tools for sale, never the gate controls, and cannot call them', async () => {
    const { client } = await connect(await sellerGate());
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['pools__analyze_pool', 'pools__list_pools']);
    for (const control of ['gate_enable_tools', 'gate_list_servers', 'gate_route']) {
      const result = await call(client, control, { tools: ['pools__*'], task: 'x' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`Unknown tool: ${control}`);
    }
  });

  it('lets deny win over price: a tool the policy denies is not for sale', async () => {
    const { client } = await connect(await sellerGate({ policy: { allow: ['*'], deny: ['analyze_pool'] } }));
    const result = await call(client, 'pools__analyze_pool');
    expect(result.isError).toBe(true);
    expect(readPaymentRequired(result as never)).toBeUndefined();
  });
});

describe('the buyer gate (wallet), end to end against a seller gate', () => {
  it('pays a paid tool automatically, inside its caps, and hands the agent the result', async () => {
    const fake = fakeFacilitator();
    const seller = await sellerGate({ facilitator: fake.facilitator });
    const agent = await buyerGate(seller);
    const result = await call(agent.client, 'market__pools__analyze_pool', { pair: '0xbeef' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ pair: '0xbeef', score: 82 });
    expect(fake.settled).toEqual([{ from: addressOf(BUYER_KEY), to: PAY_TO, value: 2000n }]);
    expect(agent.gate.wallet!.todaySpent).toBe(2000n);
  });

  it('shows the agent the price before it calls', async () => {
    const agent = await buyerGate(await sellerGate());
    const { tools } = await agent.client.listTools();
    const paid = tools.find((tool) => tool.name === 'market__pools__analyze_pool')!;
    expect(paid.description).toMatch(/Paid tool: 0\.002 per call/);
    expect(tools.find((tool) => tool.name === 'market__pools__list_pools')!.description).not.toMatch(/Paid/);
  });

  it('refuses, and signs nothing, when the price is over maxPerCall', async () => {
    const fake = fakeFacilitator();
    const agent = await buyerGate(await sellerGate({ facilitator: fake.facilitator }), { maxPerCall: '0.001', maxPerSession: '0.05', maxPerDay: '0.1' });
    const result = await call(agent.client, 'market__pools__analyze_pool');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/did not pay: 0\.002 USDC would go past maxPerCall \(0\.001 USDC/);
    expect(fake.calls.verify).toBe(0);
    expect(agent.gate.wallet!.todaySpent).toBe(0n);
  });

  it('stops at maxPerSession, and a new session starts again from zero until maxPerDay', async () => {
    const seller = await sellerGate();
    const agent = await buyerGate(seller, { maxPerCall: '0.002', maxPerSession: '0.004', maxPerDay: '0.006' });
    for (let i = 0; i < 2; i += 1) expect((await call(agent.client, 'market__pools__analyze_pool')).isError).not.toBe(true);
    expect(textOf(await call(agent.client, 'market__pools__analyze_pool'))).toMatch(/past maxPerSession/);
    const second = await connect(agent.gate);
    expect((await call(second.client, 'market__pools__analyze_pool')).isError).not.toBe(true);
    expect(textOf(await call(second.client, 'market__pools__analyze_pool'))).toMatch(/past maxPerDay/);
  });

  it('resets the day cap on the next UTC day', async () => {
    let day = new Date('2026-11-27T23:59:00Z');
    const agent = await buyerGate(await sellerGate(), { maxPerCall: '0.002', maxPerSession: '0.002', maxPerDay: '0.002' }, () => day);
    expect((await call(agent.client, 'market__pools__analyze_pool')).isError).not.toBe(true);
    // A fresh session has spent nothing, so only the day cap can stop it.
    const later = await connect(agent.gate);
    expect(textOf(await call(later.client, 'market__pools__analyze_pool'))).toMatch(/past maxPerDay/);
    day = new Date('2026-11-28T00:01:00Z');
    expect((await call(later.client, 'market__pools__analyze_pool')).isError).not.toBe(true);
  });

  it('pays only in allowed networks and assets, and only listed recipients', async () => {
    const wrongNetwork = await buyerGate(await sellerGate(), { allow: [{ network: 'eip155:8453', asset: USDC }] });
    expect(textOf(await call(wrongNetwork.client, 'market__pools__analyze_pool'))).toMatch(/not an allowed payment/);
    const wrongRecipient = await buyerGate(await sellerGate(), { payTo: [addressOf(STRANGER_KEY)] });
    expect(textOf(await call(wrongRecipient.client, 'market__pools__analyze_pool'))).toMatch(/not on the wallet's list of recipients/);
  });

  it('gives the money back to the caps when the seller did not charge because the tool failed', async () => {
    const agent = await buyerGate(await sellerGate());
    const result = await call(agent.client, 'market__pools__analyze_pool', { fail: true });
    expect(result.isError).toBe(true);
    expect(agent.gate.wallet!.todaySpent).toBe(0n);
  });

  it('gives the money back and says so when the seller rejects the payment', async () => {
    const fake = fakeFacilitator(new Map());
    const agent = await buyerGate(await sellerGate({ facilitator: fake.facilitator }));
    const result = await call(agent.client, 'market__pools__analyze_pool');
    expect(textOf(result)).toMatch(/refused the payment of 0\.002 USDC \(insufficient_funds\); nothing was paid/);
    expect(agent.gate.wallet!.todaySpent).toBe(0n);
  });

  it('never puts the private key in anything it returns', async () => {
    const agent = await buyerGate(await sellerGate(), { maxPerCall: '0.001', maxPerSession: '0.05', maxPerDay: '0.1' });
    const everything = JSON.stringify([await call(agent.client, 'market__pools__analyze_pool'), await agent.client.listTools(), await call(agent.client, 'gate_status')]);
    expect(everything).not.toContain(BUYER_KEY.slice(2));
  });
});

describe('payment configuration', () => {
  it('needs a seller section for priced tools', () => {
    expect(() => parseConfig({ servers: { pools: { command: 'x', pricing: { analyze_pool: '0.002' } } } })).toThrow(/priced tools need a seller section/);
  });

  it('checks the private key after interpolation, names a missing variable, and never repeats the value', () => {
    const buyer = { privateKey: '${KEY}', allow: [{ network: NETWORK, asset: USDC }], maxPerCall: '0.01', maxPerSession: '0.05', maxPerDay: '0.1' };
    expect(() => parseConfig({ buyer }, {})).toThrow(/environment variable KEY is not set/);
    try {
      parseConfig({ buyer }, { KEY: 'not-a-key-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/buyer\.privateKey/);
      expect((error as Error).message).not.toContain('not-a-key-secret-value');
    }
    expect(parseConfig({ buyer }, { KEY: BUYER_KEY }).buyer?.privateKey).toBe(BUYER_KEY);
  });

  it('requires caps that nest: per call <= per session <= per day', () => {
    const buyer = { privateKey: BUYER_KEY, allow: [{ network: NETWORK, asset: USDC }], maxPerCall: '1', maxPerSession: '0.5', maxPerDay: '2' };
    expect(() => parseConfig({ buyer })).toThrow(/maxPerCall <= maxPerSession <= maxPerDay/);
  });

  it('accepts only EVM networks in CAIP-2 form and real addresses', () => {
    expect(() => parseConfig({ seller: { ...SELLER, network: 'base' } })).toThrow(/CAIP-2/);
    expect(() => parseConfig({ seller: { ...SELLER, payTo: '0x123' } })).toThrow(/20-byte address/);
  });
});
