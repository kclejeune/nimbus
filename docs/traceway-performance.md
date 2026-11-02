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
It creates one email channel, six objectives and eight rules, without sending
a test message. A server without SLO support fails before any writes. If a
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

The November 1 investigation could list rules with the installed CLI, but its
`traceway:read` session returned 401 for channel discovery and 404 for
`/api/slos`. Traceway's agent route allowlist deliberately excludes creating
channels, rules and SLOs even for write credentials. These operations require a
dashboard session. The maintainer Nix package pins Traceway 2.0.7; if that
dashboard also lacks span SLOs, update Traceway before applying this plan rather
than substituting outer request durations. No live configuration has been
changed by preparing these files.

References: [Traceway SLOs](https://docs.tracewayapp.com/learn/slos) and
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

An explicit D1 overload pauses **speculative** primary hedges for two seconds
after the last observed rejection in an isolate. Normal replica reads, retries,
primary-required reads and error-driven failover retain their policies. The
existing one-active-hedge and one-start-per-second limits still apply.
`nimbus.d1_hedge_wait` records `reason=overload`; compare overload warnings,
primary hedge wins, gateway tails and failed requests together. Reducing primary
load can increase latency for a read whose replica remains slow during cooldown.
`nimbus.d1_hedge.replicaOverloaded` distinguishes overload-driven failover from
other replica failures. An unconstrained read may itself have used the primary,
so an overload result does not establish which database instance was unhealthy.
Upload/write overloads also pause speculative read hedges in the same isolate;
this shared pressure signal is deliberate, while foreground retry policies and
error-driven failover remain unchanged.

## Compare upload concurrency without deduplication bias

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
