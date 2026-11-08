# Performance objectives and alerting

[traceway-performance.json](traceway-performance.json) contains the proposed
Traceway SLO and alert API bodies. These are **not applied automatically on a
Nimbus deploy**. They do not change Traceway's built-in impact badges.

Supply the email destination locally using `TRACEWAY_ALERT_RECIPIENT`; the plan
does not store a personal recipient. The existing maintainer Nix configuration
already sets `SMTP_FROM=noreply+traceway@kclj.io`; the notification channel does
not override the sender.

## Measure headers separately from transfers

Use the `gateway GET /:hash.narinfo` and `gateway GET /nar/:file` child spans,
service `nimbus`, attribute `nimbus.layer=gateway`. Their durations end when the
Worker returns its Response. The outer invocation can include streaming and
background work: one observed download had an 11 ms gateway span and an 18.9 s
outer duration. Do not apply the same latency target to both.

The initial objectives, independently for each route, are:

| Objective                 | Target                            | Notification                                                                        |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Response headers          | 95% within 500 ms                 | Info after the allowed slow share is exceeded over both 1 hour and 15 minutes       |
| Header tail               | 99% within 1.5 s                  | Warning after the allowed slow share is exceeded over both 30 minutes and 5 minutes |
| Severe header degradation | Same tail objective               | Critical at 14.4x budget burn over both 1 hour and 5 minutes                        |
| Availability              | 99.9% of responses below HTTP 500 | Critical at 14.4x budget burn over both 1 hour and 5 minutes                        |

For the 99% latency target, 1x burn means 1% of requests exceed 1.5 s and
14.4x means 14.4% do. For 99.9% availability, 14.4x corresponds to 1.44%
server errors. These are burn-rate conditions, not configurable replacements
for Traceway's Good/Medium/High/Critical badge boundaries.

Traceway's span SLOs use retained, sampled traces. A quiet window or a small
sample cannot establish a stable percentile; compare against the header timing
logs and use longer windows when needed. Availability does not detect a body
failure after a 200 response: also investigate `nimbus.store_transport`,
`nimbus.stream` errors and captured exceptions. Content-addressed 404s are normal
and must not be treated as availability failures.

No fixed latency objective is proposed for CDC completion yet. Payload and
chunk counts vary too much. Compare similar compressed bytes, chunk counts,
colos and concurrency; inspect `cdcRead`, R2 time and admission separately.

## Apply to a Traceway project

To generate an installer for your signed-in Traceway dashboard:

```sh
TRACEWAY_ALERT_RECIPIENT=you@example.net node web/scripts/traceway-alerts.mjs 2295639f-73fa-43d3-a439-23a18b19c51b > /tmp/nimbus-traceway-install.js
```

Open `https://traceway.kclj.io`, sign in, and run the generated file's contents
in the browser developer console. Generation is offline and reads no
credentials. The recipient appears only in the generated local file; keep it
out of version control. The installer uses the dashboard's existing session only against
that origin, checks channel/SLO/rule access before writing, reuses matching
configuration by name, and refuses to overwrite differing existing settings.
It previews all six objectives against the last 24 hours and refuses to create
configuration if any objective matches no events. It then creates one email
channel, six objectives and eight rules, without sending a test message.
A server without SLO support fails before any configuration writes. If a
later request fails, earlier successful creates remain; rerunning reuses them.

The manual equivalent is:

1. Select the Nimbus project in Traceway and choose an existing notification
   channel. Keep optimization messages informational; route critical messages to
   a destination appropriate for incidents.
2. Confirm the installed server supports **span SLOs** and `slo_burn_rate` rules.
   Preview each objective against the last 24 hours before enabling it. Do not
   substitute outer endpoint duration when span SLOs are unavailable.
3. Create the six objectives under **SLOs**, using each `objectives[].body` in
   the JSON file. For authenticated API automation the route is
   `POST /api/slos?projectId=PROJECT_ID`; record each returned id by its `key`.
4. Under **Alerts**, create the eight rules using `rules[].body`. Set the
   channel, resolve each `sloKey` to `config.sloId`, and retain the explicit
   severity and cooldown. The API route is
   `POST /api/notification-rules?projectId=PROJECT_ID`; `channelId` belongs at the
   top level of the request body. Reconcile by name rather than creating
   duplicates on a second application.

The November 1 and November 3 investigations could list rules with the installed CLI, but its
`traceway:read` session returned 401 for channel discovery and 404 for
`/api/slos`. Traceway's agent route allowlist deliberately excludes creating
channels, rules and SLOs even for write credentials. These operations require a
dashboard session. Traceway 2.0.8 added SLOs; the November 3 preflight was against
the older 2.0.7 server. Update the server before applying this plan, then use a
signed-in dashboard session rather than an agent credential. Keep the latency
objectives on gateway child spans. No live configuration has been
changed by preparing these files.

References: [Traceway 2.0.8](https://github.com/tracewayapp/traceway/releases/tag/backend%2Fv2.0.8), [Traceway SLOs](https://docs.tracewayapp.com/learn/slos) and
[alert rules](https://docs.tracewayapp.com/learn/alerts).

## Measure D1 burst mitigation after deployment

Overlapping candidate/configuration fills share completed values through
request-local polling, with a 15-second abandoned-leader lease. Later calls
reload; there is no extra isolate cache TTL. Candidate fill timestamps are
shared with the result and every caller still passes backend admission.
Once store transport recovery marks a request as bypassing the cache, its
metadata reads also bypass coalescing. A ten-second header timeout therefore
starts an independent origin read even if the failed loopback left behind an
unsettled 15-second lease. The lease remains an abandoned-leader backstop for
normal fills, not a delay imposed on the uncached recovery attempt.
A mutation clears its key, so existing waiters and later callers reload. As with
other edge fills, replication and in-flight work can still race a purge.

Timing logs expose `metadataReads.origin` and `metadataReads.coalesced`. Compare
those counts per route and version to determine whether same-key bursts are
common enough for coalescing to matter. They count logical fills, not SQL
statements or a global cache hit rate.
The historical 1-in-942 hit count concerned a gateway memo in a different
workload; it is not a measurement of overlapping origin fills. Production benefit
from this coalescer remains unproven. Reconsider keeping it if the new counters
show little useful sharing.
The configuration fill also uses one shared key across different path hashes;
its overlap is not estimated by the historical per-path gateway memo statistic.

Anonymous envelope refills can reuse tagged candidate metadata within its
existing `stale-while-revalidate` window instead of forcing an additional D1
read while the edge refreshes it. The original fill timestamp is preserved.
An envelope built from stale membership is `no-store`, so it cannot renew that
membership's lifetime. Current visibility is still checked in the gateway;
stale empty membership is confirmed before an upstream miss or failure becomes
the answer. Missing/future timestamps and entries outside the permitted reuse
window still reload. Upstream trust configuration remains strictly fresh.
Child spans distinguish `candidate snapshot loopback`, `narinfo body loopback`
and `upstream configuration loopback`. On envelope fills, sampled latency logs
also separate membership (`candidateLoopback`) from body resolution (`store`).
Use these to locate remaining waits before changing required-read deadlines.

An explicit D1 overload pauses speculative and overload-driven primary attempts
for two seconds after the last observed rejection in an isolate. Connection
failures can still fail over promptly. A settled overload failure waits only
within its five-second read retry window; occupied primary capacity still
returns the replica's failure. The existing one-active-hedge and
one-start-per-second limits remain.
`nimbus.d1_hedge_wait` records `reason=overload`; compare overload warnings,
primary hedge wins, gateway tails and failed requests together. Reducing primary
load can increase latency for a read whose replica remains slow during cooldown.
`nimbus.d1_hedge.replicaOverloaded` distinguishes overload-driven failover from
other replica failures. An unconstrained read may itself have used the primary,
so an overload result does not establish which database instance was unhealthy.
Upload/write overloads also pause read hedges in the same isolate; this shared
pressure signal is deliberate.

Queue-overload retries back off by 250/500/1000 ms plus up to an equal amount
of jitter. Other transient failures retain 40/80/160 ms plus jitter. Replica
and primary SELECTs share at most two **additional** attempts within five
seconds; their initial statements are not limited, so a multi-query config read
can still complete. The losing read cannot schedule more retries after a winner
returns. The window bounds retry scheduling, not D1 execution: a binding call
already in flight is not cancelled, and a successful result can arrive later.
Uncached loopback recovery still starts an independent logical read.

`D1_ERROR: internal error; reference = ...` is recoverable only inside that
SELECT-only scope. Unsafe writes, including hold releases, remain single-attempt.
Both download-touch statements are also single-attempt: their best-effort work
must not add a retry burst when reads are already under pressure.
Retention loopbacks have a separate one-second header deadline and never
recover a failed loopback with another origin read. A failed touch backs off
all touch keys in that isolate for five seconds; explicit D1 overload also
defers touch work in both the gateway and origin. Required reads keep their
ten-second transport deadline and recovery policy. The internal touch request
stamps a deadline that is checked before the probe and again before UPDATE,
together with cancellation and overload: a delayed/abandoned probe must not
start a late primary write, even if the RPC ignores abort. Already-issued D1
operations still cannot be cancelled.
`nimbus.store_transport` labels skipped best-effort recovery with
`recovery=skipped`; `nimbus.retention_touch` records the start of a shared
backoff, not every skipped download. The one- and five-second values are
starting policies, not measured optima. Retention remains best-effort: a
deferred access may only be recorded by a later successful download.
`nimbus.d1_retry` records the scheduled next `attempt`, `delayMs`, error and
shared `readRetries` reservations. `nimbus.d1_hedge.readRetries` reports that
same budget use. A scheduled retry may be suppressed if another attempt wins;
use D1 statement counters and spans to count executed work.

The CLI shares upload concurrency and pressure feedback across its requests,
including chunks and retries: eight requests maximum, halved toward one after
429/503 responses, with a shared cooldown and gradual recovery. A failed
preflight also pauses uploads. This is per client, while the Worker cooldown is
per isolate; neither is a database-wide admission limit. The maintainer CI sets
two path-upload jobs separately from Nix's build-job count. Compare completion
throughput, narinfo failures, queue-overload events and retry counts together;
the initial limits and delays are tunable starting values.

## Compare upload concurrency without deduplication bias

Upload diagnostics are independent of retained trace sampling:

- `nimbus.upload_admission` records every refusal and successful waits of at
  least one second. It includes the requested reservation, wait limit, and
  memory state before and after waiting. `kind` distinguishes path, chunk and
  completion admission.
- `nimbus.upload_chunk` distinguishes CDC R2 `get` (including retries) from
  compressed `body` reads. Operations taking at least one second emit a final
  record; a pending operation emits at five seconds and every fifteen seconds
  afterward. Failures, missing objects and invalid bodies also emit a record.
  Intentional read-ahead cancellation is labelled `cancelled`.
- Body records include cumulative compressed `bytes`, `expectedBytes` and
  `idleMs` since the last successful source read, alongside the NAR hash and
  zero-based chunk index. Progress measures storage reads, not client transfer.
- Every record includes a process-local `memory.isolate` identifier so
  contention can be correlated across requests sharing the budget. Reserved
  bytes, active reservations and live queued callers describe admission, not
  measured heap usage. `prefetchBytes` and `prefetchActive` are the speculative
  subset; they stop counting a buffer once the foreground consumer takes it.

For a slow completion, correlate its trace and chunk indices, then compare
admission failures with the same isolate identifier. A slow body that keeps
advancing bytes differs from an idle read; a long `get` precedes body transfer.
Per-operation durations, `cdcRead` and R2 totals can overlap and must not be
summed into request wall time. The diagnostics do not change memory limits,
admission waits, read-ahead, client concurrency or storage timeouts.

Do not push the same closure twice to the same instance and interpret the
second, deduplicated push as a concurrency improvement. Different cache names
also share global NAR/chunk storage and are not independent benchmark targets.

Use two isolated staging stacks with fresh, separate D1 and R2 state, the same
Worker version, configuration and placement, and the same client/closure:

```sh
nimbus push staging-jobs2:bench --jobs 2 --ignore-upstream-cache-filter /nix/store/STORE-PATH
nimbus push staging-jobs5:bench --jobs 5 --ignore-upstream-cache-filter /nix/store/STORE-PATH
```

The two server aliases must be configured in the CLI before running. Provision
and reset only disposable staging resources, outside this procedure. Alternate
run order with equivalent fresh state for multiple trials. Record total push
wall time as well as per-completion headers, compressed bytes/chunks, D1 retry
and hedge outcomes, R2 time, admission waits and `upload.prefetchedChunks`.
The default stays at five jobs until those measurements show a useful tradeoff.

## Correlating cold reads and interrupted downloads

A `store loopback headers` span records `nimbus.store_request_id` and the
returned status. Requests that take at least 500 ms emit `nimbus.store_headers`
with that `requestId`, header time, edge cache status and age. The matching
`nimbus.store` entry log carries the same ID when CachedStore executes. This
connects gateway wait time to origin entry even when an inner trace was not
retained; an edge hit has no store invocation. IDs travel in an internal header
and do not change the cache URL or cache policy. Transport failures retain
`nimbus.store_transport` diagnostics and one uncached recovery attempt for
pipeline-generated 502/520 responses; origin admission refusals remain intact.

Download body errors include range headers, observed request-abort state and
its reason alongside byte/read progress. Explicit downstream cancellations emit
`nimbus.body.cancel`. Store chunk-pump events carry request-abort context and the
actual chunk source. Workers Caching strips Range before calling CachedStore,
so the gateway body event is the useful range record. A network disconnect
without an observed abort remains unexplained; do not infer that storage or
the client caused it, or restart an already-delivered compressed byte stream.

Traceway's non-stream impact score includes successful requests that exceed
its Apdex latency bound. Its volume-based explanation must describe these as
slow or failing requests, rather than HTTP errors. Use request-list HTTP status
statistics and gateway header timings to distinguish latency from availability.
