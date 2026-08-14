/** Only the GL3 scope is sold, so nothing outside it is a valid entitlement. */
export const SCOPE = '@gl3/';

const EXACT = /^@gl3\/[a-z0-9][a-z0-9._-]*$/;

export type PackagePattern = { kind: 'exact'; value: string } | { kind: 'scope'; value: string };

/**
 * Parses the `package` field of an entitlement. Two shapes are allowed: an
 * exact name (`@gl3/plugin-a`) or the scope wildcard (`@gl3/*`) for an
 * all-access plan. Keeping it to these two means authorization is a plain
 * equality lookup rather than pattern matching at request time.
 */
export function parsePattern(value: string): PackagePattern | null {
  if (value === `${SCOPE}*`) {
    return { kind: 'scope', value };
  }
  if (EXACT.test(value)) {
    return { kind: 'exact', value };
  }
  return null;
}

/** Validates a package name being requested from the registry. */
export function isSellablePackage(name: string): boolean {
  return EXACT.test(name);
}

/**
 * The set of entitlement rows that would grant access to `packageName`: the
 * name itself, or the scope wildcard.
 */
export function grantingPatterns(packageName: string): string[] {
  return [packageName, `${SCOPE}*`];
}
