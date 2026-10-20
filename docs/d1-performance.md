# D1 maintenance query audit

Audit date: 2026-10-20. Production diagnostics were read-only; the purge
benchmarks executed SELECTs, not deletions.

From `web/`, inspect the queries that dominate total reads and SQL time:

```sh
npx wrangler d1 insights attic --config=wrangler.local.jsonc --time-period=1d --sort-by=reads --limit=20 --json
npx wrangler d1 insights attic --config=wrangler.local.jsonc --time-period=1d --sort-by=time --limit=20 --json
```

Wrangler 4.149.0 rejects `d1 analyze` as an unknown subcommand. For a specific
query, use `EXPLAIN QUERY PLAN` through `d1 execute --remote --command`.
SQL `ANALYZE` updates planner statistics; the nightly Worker already runs it
after GC. The production `sqlite_stat1` rows cover the existing object,
reference, and upstream-verdict indexes. The fixes also work without statistics.

## Purge scaling

The original recursive query scanned the materialized reference graph once per
affected object. It also scanned the approval JSON once per cache object when
statistics were missing. The corrected query:

- Gives materialized child hashes TEXT affinity so SQLite builds an automatic
  covering index for reverse traversal.
- Fixes join order so each frontier object or approval row performs an indexed
  lookup, including the forward protection walk.
- Computes eligible objects once inside the apply transaction, recording their
  IDs and invalidation metadata in the existing operation journal. The three
  deletion statements reuse that snapshot.

The real-schema regression covers a 10,000-object chain, both before and after
`ANALYZE`: planning, full pin protection, and removal of every object/reference.
It also verifies indexed traversal and primary-key approval lookups.

For the same seven-path production plan, rows read fell from 12,759,960 to
3,965,441 (69%). This is a scan reduction, not a latency win for that small
case: the two observations were 5.60s and 9.29s respectively. Building a
temporary index over the full 1,238,554-edge graph has a startup cost; its
benefit is avoiding quadratic work as the affected closure grows. Apply now
pays that graph/index-build cost once per transaction instead of three times.

## Permanent index decision

No new permanent indexes are warranted by this sample. The important lookups
already use existing indexes:

- `object(cache_id, store_path_hash)` from the UNIQUE constraint, and the
  integer primary key, serve child resolution and reviewed-object validation.
- `upstream_check(upstream_id, store_path_hash)` from the primary key serves
  both parts of batched verdict lookups; `EXPLAIN` confirms it uses both keys.
- `object_ref(child_id)` and `object_ref(ref_hash)` serve graph maintenance and
  integrity discovery. Integrity discovery explicitly preserves hash ordering
  so pagination can stop early.

The one-day insights sample showed integrity discovery reading 5.00M rows
over 29 executions, and batched upstream verdict queries reading 0.93M over
167 executions. Several other apparent outliers were one-off diagnostic
queries. A new unresolved-reference index would cover 698,606 of 1,238,554
edges (56%), duplicate existing access paths, and add publication/GC write
costs for an infrequent maintenance operation. An additional verdict
freshness/state index would also add costs on every verdict refresh without
helping these already indexed point lookups.

Revisit this decision if maintenance becomes frequent or production telemetry
shows these queries dominating normal traffic. Cloudflare documents how to
[verify index usage and weigh read savings against write costs](https://developers.cloudflare.com/d1/best-practices/use-indexes/).
