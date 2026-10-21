function privateIpv4(hostname: string): boolean {
	const parts = hostname.split('.');
	if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255))
		return false;
	const [a, b] = parts.map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

/** Registry entries are dereferenced by anonymous cache reads. Keep their
 * destinations to credential-free public HTTPS origins and standard ports. */
export function validateUpstreamUrl(
	raw: string,
	{ allowQuery = false }: { allowQuery?: boolean } = {}
): { url: string } | { error: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { error: `Invalid upstream URL: ${raw}` };
	}
	// URL preserves an explicit DNS root dot (`localhost.`). Canonicalize it
	// before classifying names so FQDN spelling cannot bypass loopback/local
	// suffix checks.
	const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
	if (parsed.protocol !== 'https:') return { error: 'Upstream URL must use HTTPS.' };
	if (parsed.username || parsed.password)
		return { error: 'Upstream URL must not contain credentials.' };
	if ((!allowQuery && parsed.search) || parsed.hash)
		return { error: 'Upstream URL must not contain a query or fragment.' };
	if (parsed.port && parsed.port !== '443')
		return { error: 'Upstream URL must use the standard HTTPS port.' };
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		host.startsWith('[') ||
		privateIpv4(host)
	) {
		return { error: 'Upstream URL must use a public hostname.' };
	}
	parsed.pathname = parsed.pathname.replace(/\/+$/, '');
	return { url: parsed.toString().replace(/\/$/, '') };
}
