// The copy/paste nix.conf snippet, shared by the unified-endpoint card and
// the per-cache trust section. Upstream signing KEYS default to included:
// redirect-tier paths are served with the upstream's own signature, so a
// client without those keys fails signature verification on them. Upstream
// URLs default to excluded and, when included, are appended AFTER the nimbus
// URL so Nix prefers this cache and redirect/pull-through covers upstream
// content. Upstreams flagged nix-default (cache.nixos.org and friends) are
// omitted entirely — they already ship in every Nix installation's config.

export interface UpstreamRef {
	url: string;
	publicKey: string | null;
	nixDefault: boolean;
}

export function nixConfSnippet(
	url: string,
	publicKey: string | null,
	upstreams: UpstreamRef[],
	opts: { includeKeys: boolean; includeUrls: boolean }
): string {
	const relevant = upstreams.filter((u) => !u.nixDefault);
	const substituters = [url, ...(opts.includeUrls ? relevant.map((u) => u.url) : [])];
	const keys = [
		...(publicKey ? [publicKey] : []),
		...(opts.includeKeys
			? relevant.map((u) => u.publicKey).filter((k): k is string => k !== null)
			: [])
	];
	const lines = [`extra-substituters = ${[...new Set(substituters)].join(' ')}`];
	if (keys.length > 0) lines.push(`extra-trusted-public-keys = ${[...new Set(keys)].join(' ')}`);
	return lines.join('\n');
}
