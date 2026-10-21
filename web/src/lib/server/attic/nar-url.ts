/** Nix resolves a narinfo's URL against the binary cache's directory URL.
 * Use the same resolution for passthrough responses and pull-through ingest. */
import { validateUpstreamUrl } from '../cache/upstream-url';

export function resolveNarUrl(upstream: string, value: string): string | null {
	try {
		const url = new URL(value, `${upstream.replace(/\/+$/, '')}/`);
		const checked = validateUpstreamUrl(url.href, { allowQuery: true });
		return 'url' in checked ? checked.url : null;
	} catch {
		return null;
	}
}

/** The download URL is outside the signed Nix fingerprint. Preserve every
 * other field, including signatures, while avoiding a gateway NAR redirect. */
export function absoluteNarinfoUrl(text: string, upstream: string): string {
	return text.replace(/^URL: ([^\r\n]+)(\r?)$/gm, (line, value: string, cr: string) => {
		const url = resolveNarUrl(upstream, value.trim());
		return url ? `URL: ${url}${cr}` : line;
	});
}
