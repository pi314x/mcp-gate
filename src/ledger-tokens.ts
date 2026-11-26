// Canonical copy. Layers without a token counter of their own copy this file byte for byte to src/ledger-tokens.ts.
// It is the "heuristic-v1" estimator of lean-context (src/tokens.ts), and ctx-ledger's conformance test fails when the
// two disagree on a sample text, so the counter name in a ledger line means the same thing in every layer.
// An estimate, not the model's tokenizer: never present it as billing.
export const LEDGER_COUNTER = 'heuristic-v1';

const SEGMENT = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+|[ \t]+|\r?\n|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+|[\u0080-\uffff]/g;

export function countTokens(text: string): number {
  let tokens = 0;
  SEGMENT.lastIndex = 0;
  for (let match = SEGMENT.exec(text); match !== null; match = SEGMENT.exec(text)) {
    const segment = match[0];
    const first = segment.charCodeAt(0);
    if (first === 32 || first === 9) {
      if (segment.length > 1) tokens += Math.ceil(segment.length / 4);
    } else if (first === 10 || first === 13) {
      tokens += 1;
    } else if (first >= 48 && first <= 57) {
      tokens += Math.ceil(segment.length / 3);
    } else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += Math.ceil(segment.length / 6);
    } else if (first < 128) {
      tokens += Math.ceil(segment.length / 2);
    } else {
      tokens += 1;
    }
  }
  return tokens;
}
