import type { CallToolResult } from '@modelcontextprotocol/client';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

/**
 * x402 v2 over MCP (specs/transports-v2/mcp.md in x402-foundation/x402): a paid tool answers an unpaid call with an
 * `isError` result carrying `PaymentRequired`; the client retries with the payment in `params._meta["x402/payment"]`;
 * the server verifies, runs the tool, settles, and returns the receipt in `result._meta["x402/payment-response"]`.
 * Only the `exact` scheme on EVM networks with an EIP-3009 token (USDC) is implemented.
 */
export const X402_VERSION = 2;
export const META_PAYMENT = 'x402/payment';
export const META_RESPONSE = 'x402/payment-response';
export const META_PRICE = 'x402/price';

export interface PaymentRequirements {
  scheme: 'exact';
  /** CAIP-2, e.g. eip155:8453 (Base) or eip155:84532 (Base Sepolia). */
  network: string;
  /** Atomic units of the asset, as a decimal string. */
  amount: string;
  /** The EIP-3009 token contract. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the token. */
  extra: { name: string; version: string };
}

export interface Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: Resource;
  accepts: PaymentRequirements[];
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: Resource;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: Authorization };
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

/** The resource a paid MCP tool is sold as. */
export const toolResource = (tool: string): string => `mcp://tool/${tool}`;

export function chainIdOf(network: string): bigint {
  const match = /^eip155:(\d+)$/.exec(network);
  if (match === null) throw new Error(`only EVM networks (eip155:<chainId>) are supported, not "${network}"`);
  return BigInt(match[1]!);
}

/** "0.002" with 6 decimals is 2000. Exact decimal arithmetic: money never goes through a float. */
export function toAtomic(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (match === null) throw new Error(`"${amount}" is not a plain decimal amount`);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function fromAtomic(atomic: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (atomic % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${atomic / unit}${fraction === '' ? '' : `.${fraction}`}`;
}

const keccak = (...parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return keccak_256(joined);
};

const strip0x = (hex: string): string => (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex);

function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 2n ** 256n) throw new Error('value does not fit in uint256');
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

function addressWord(address: string): Uint8Array {
  const hex = strip0x(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`"${address}" is not an address`);
  return hexToBytes(hex.padStart(64, '0'));
}

function bytes32(hex: string): Uint8Array {
  const clean = strip0x(hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('nonce must be 32 bytes of hex');
  return hexToBytes(clean);
}

const DOMAIN_TYPE = keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TRANSFER_TYPE = keccak_256(
  utf8ToBytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')
);

/** The EIP-712 digest an EIP-3009 `transferWithAuthorization` is signed over. */
export function authorizationDigest(requirements: PaymentRequirements, authorization: Authorization): Uint8Array {
  const domain = keccak(
    DOMAIN_TYPE,
    keccak_256(utf8ToBytes(requirements.extra.name)),
    keccak_256(utf8ToBytes(requirements.extra.version)),
    word(chainIdOf(requirements.network)),
    addressWord(requirements.asset)
  );
  const struct = keccak(
    TRANSFER_TYPE,
    addressWord(authorization.from),
    addressWord(authorization.to),
    word(BigInt(authorization.value)),
    word(BigInt(authorization.validAfter)),
    word(BigInt(authorization.validBefore)),
    bytes32(authorization.nonce)
  );
  return keccak(new Uint8Array([0x19, 0x01]), domain, struct);
}

const addressFromPublicKey = (uncompressed: Uint8Array): string => `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;

export function addressOf(privateKey: string): string {
  return addressFromPublicKey(secp256k1.getPublicKey(hexToBytes(strip0x(privateKey)), false));
}

/** Signs an EIP-3009 authorization for exactly the required amount, valid from a little before now until the timeout. */
export function signPayment(
  privateKey: string,
  required: PaymentRequired,
  requirements: PaymentRequirements,
  options: { nowSeconds?: number; nonce?: string } = {}
): PaymentPayload {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: addressOf(privateKey),
    to: requirements.payTo,
    value: requirements.amount,
    // A little slack for clock skew between this host and the chain.
    validAfter: String(now - 60),
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce: options.nonce ?? `0x${bytesToHex(randomBytes(32))}`
  };
  const signature = secp256k1.sign(authorizationDigest(requirements, authorization), hexToBytes(strip0x(privateKey)));
  const v = (signature.recovery + 27).toString(16).padStart(2, '0');
  return {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: requirements,
    payload: { signature: `0x${signature.toCompactHex()}${v}`, authorization }
  };
}

/** The address that signed an authorization, or undefined when the signature does not recover. */
export function recoverSigner(requirements: PaymentRequirements, authorization: Authorization, signature: string): string | undefined {
  try {
    const raw = strip0x(signature);
    if (!/^[0-9a-fA-F]{130}$/.test(raw)) return undefined;
    const v = Number.parseInt(raw.slice(128), 16);
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return undefined;
    const sig = secp256k1.Signature.fromCompact(raw.slice(0, 128)).addRecoveryBit(recovery);
    return addressFromPublicKey(sig.recoverPublicKey(authorizationDigest(requirements, authorization)).toRawBytes(false));
  } catch {
    return undefined;
  }
}

export const sameAddress = (a: string, b: string): boolean => strip0x(a).toLowerCase() === strip0x(b).toLowerCase();

/** The tool result that asks for payment, in both shapes the transport spec requires. */
export function paymentRequiredResult(required: PaymentRequired): CallToolResult {
  return {
    isError: true,
    structuredContent: required as unknown as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(required) }]
  };
}

/** The PaymentRequired a tool result carries, if it is one. */
export function readPaymentRequired(result: CallToolResult): PaymentRequired | undefined {
  if (result.isError !== true) return undefined;
  let candidate: unknown = result.structuredContent;
  if (candidate === undefined) {
    const text = result.content?.find((part) => part.type === 'text');
    try {
      candidate = text !== undefined && 'text' in text ? JSON.parse(String(text.text)) : undefined;
    } catch {
      return undefined;
    }
  }
  const required = candidate as Partial<PaymentRequired> | undefined;
  if (required?.x402Version !== X402_VERSION || !Array.isArray(required.accepts) || typeof required.resource?.url !== 'string') return undefined;
  return required as PaymentRequired;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/** An x402 facilitator over HTTP: POST {url}/verify and {url}/settle with the v2 request body. */
export function httpFacilitator(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Facilitator {
  const post = async <T>(path: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<T> => {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`facilitator ${path} answered HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    verify: (payload, requirements) => post('verify', payload, requirements),
    settle: (payload, requirements) => post('settle', payload, requirements)
  };
}
