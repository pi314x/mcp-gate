import { matchesAny } from './glob.js';

export interface Policy {
  /** Tool names (without the server prefix) that may ever be enabled. `*` is a wildcard. */
  allow: string[];
  /** Tool names that can never be enabled. Wins over `allow`. */
  deny: string[];
  /** Tool names that are enabled only when the caller confirms explicitly. */
  confirm: string[];
}

export type Decision =
  | { verdict: 'allow' }
  | { verdict: 'confirm' }
  | { verdict: 'deny'; reason: string };

export const OPEN_POLICY: Policy = { allow: ['*'], deny: [], confirm: [] };

/** Decides whether a downstream tool may be enabled. Deny first, then the allow-list, then confirmation. */
export function decide(policy: Policy, toolName: string): Decision {
  if (matchesAny(policy.deny, toolName)) return { verdict: 'deny', reason: 'blocked by the deny list' };
  if (!matchesAny(policy.allow, toolName)) return { verdict: 'deny', reason: 'not on the allow list' };
  if (matchesAny(policy.confirm, toolName)) return { verdict: 'confirm' };
  return { verdict: 'allow' };
}
