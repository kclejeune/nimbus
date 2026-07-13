// The copy/paste nix.conf snippet, shared by the unified-endpoint card and
// the per-cache trust section. Upstream signing KEYS are always included:
// redirect-tier paths are served with the upstream's own signature, so a
// client without those keys fails signature verification on them. Upstream
// URLs are opt-in and appended AFTER the nimbus URL, so Nix prefers this
// cache and the redirect/pull-through behavior covers upstream content.

export interface UpstreamRef {
	url: string;
	publicKey: string | null;
}

export function nixConfSnippet(
	url: string,
	publicKey: string | null,
	upstreams: UpstreamRef[],
	includeUpstreamUrls: boolean
): string {
	const substituters = [url, ...(includeUpstreamUrls ? upstreams.map((u) => u.url) : [])];
	const keys = [
		...(publicKey ? [publicKey] : []),
		...upstreams.map((u) => u.publicKey).filter((k): k is string => k !== null)
	];
	const lines = [`extra-substituters = ${[...new Set(substituters)].join(' ')}`];
	if (keys.length > 0) lines.push(`extra-trusted-public-keys = ${[...new Set(keys)].join(' ')}`);
	return lines.join('\n');
}
