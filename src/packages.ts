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

/**
 * The public scope: the SDK and anything else given away. Readable by anyone
 * straight from the registry, and never entitlement-checked.
 */
export const PUBLIC_SCOPE = '@gl3/';

const CATALOG_NAME = /^@gl3(-plugins)?\/[a-z0-9][a-z0-9._-]*$/;

/**
 * A package name allowed in the website's catalogue: either GL3 scope.
 *
 * Deliberately separate from `isSellablePackage`. The catalogue is a display
 * list and spans both scopes; entitlement checks are a security boundary and
 * must keep rejecting the free scope.
 */
export function isCatalogPackage(name: string): boolean {
  return CATALOG_NAME.test(name);
}

/**
 * True for names in the paid scope.
 *
 * Derived rather than stored, so it cannot drift from the name. The assumption
 * is that everything under the paid scope is paid, which Verdaccio's
 * `public_packages` setting could falsify by freeing a name inside that scope
 * without renaming it. That list is empty today.
 */
export function isPaidPackage(name: string): boolean {
  return name.startsWith(SCOPE);
}
