-- The package directory the website renders: the paid plugins premium unlocks,
-- and the public scope developers build against.
--
-- `position` is the only curated column -- it is set through the admin routes and
-- is nobody else's to write. Everything from `version` down is a cache of what
-- the registry last returned: overwritten wholesale by the refresher, and safe
-- to lose. Losing it costs one refresh cycle, not data.
create table catalog_packages (
  package     text primary key,
  position    integer not null,
  added_at    timestamptz not null default now(),
  version     text,
  description text,
  keywords    text[],
  license     text,
  readme      text,
  fetched_at  timestamptz,
  fetch_error text
);

-- Ordering is (position, package) rather than position alone so two rows sharing
-- a position still produce a stable list instead of an arbitrary one.
create index catalog_packages_position_idx on catalog_packages (position, package);
