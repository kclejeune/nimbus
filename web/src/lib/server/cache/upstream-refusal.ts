/** Reasons stay low-cardinality; identifiers belong in log fields, never metrics. */
export type UpstreamRefusalReason =
	| 'probe_budget'
	| 'upstream_unavailable'
	| 'http_status'
	| 'invalid_narinfo'
	| 'signature'
	| 'network_or_timeout'
	| 'circuit_open'
	| 'signing'
	| 'lookup_error';

export function upstreamRefusal(
	reason: UpstreamRefusalReason,
	details: Record<string, unknown> = {}
): void {
	console.warn(JSON.stringify({ event: 'nimbus.upstream_refusal', reason, ...details }));
}
