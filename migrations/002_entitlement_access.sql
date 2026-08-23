-- Separates an entitlement that may download tarballs from one that may only read
-- package metadata. The storefront reads the plugin catalogue with a 'metadata'
-- grant, so a leak of its token cannot yield a single paid tarball.
--
-- Named 'access' rather than 'kind' because packages.ts already exports
-- PackagePattern.kind ('exact' | 'scope') and service.ts imports it -- two
-- unrelated things called kind in one file is a trap.
--
-- Existing rows become 'download', which is what they already meant.
alter table entitlements add column access text not null default 'download'
  check (access in ('download', 'metadata'));
