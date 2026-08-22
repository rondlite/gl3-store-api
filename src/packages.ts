/**
 * Only the premium scope is sold: '@gl3-plugins/' carries paid plugins, while
 * '@gl3/' is the public engine-core scope (plugin-sdk, shared) and is readable
 * by anyone straight from the registry's packages rules - it never reaches
 * this service. Nothing outside the premium scope is a valid entitlement.
 */
export const SCOPE = '@gl3-plugins/';

const EXACT = /^@gl3-plugins\/[a-z0-9][a-z0-9._-]*$/;

export type PackagePattern = { kind: 'exact'; value: string } | { kind: 'scope'; value: string };

/**
 * Parses the `package` field of an entitlement. Two shapes are allowed: an
 * exact name (`@gl3-plugins/fixer`) or the scope wildcard (`@gl3-plugins/*`) for an
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
