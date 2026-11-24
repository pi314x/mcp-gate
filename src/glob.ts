/** `*` matches any run of characters (including none); everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}
