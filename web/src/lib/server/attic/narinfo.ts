// narinfo rendering, mirroring the Rust worker's build_narinfo byte-for-byte
// (field order, base32 conversion). The cache's own key always signs the
// narinfo; client-supplied sigs are served only when the cache has no keypair.

import { convertHashToBase32 } from './nix-base32';
import { computeFingerprint, signMessage, verifySignature } from './signing';

// Protocol-level input shapes; the cache engine's DB rows satisfy these
// structurally (this module must not depend on the storage layer).
export interface NarInfoObject {
	store_path: string;
	/** JSON-encoded string array. */
	refs: string;
	system: string | null;
	deriver: string | null;
	/** JSON-encoded string array. */
	sigs: string;
	ca: string | null;
}

export interface NarInfoNar {
	nar_hash: string;
	nar_size: number;
	compression: string;
}

export interface NarInfoChunk {
	file_hash: string | null;
	file_size: number | null;
}

export function compressionExtension(compression: string): string {
	switch (compression) {
		case 'zstd':
			return '.zst';
		case 'brotli':
		case 'br':
			return '.br';
		case 'gzip':
		case 'gz':
			return '.gz';
		case 'xz':
			return '.xz';
		default:
			return '';
	}
}

function parseJsonArray(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** The narinfo fields a signature covers, the signatures themselves, and the
 * transport fields pull-through ingestion needs. */
export interface ParsedNarInfo {
	storePath: string;
	narHash: string;
	narSize: number;
	references: string[];
	sigs: string[];
	/** NAR file path relative to the cache root (e.g. "nar/<hash>.nar.zst"). */
	url: string | null;
	compression: string | null;
	fileHash: string | null;
	fileSize: number | null;
	system: string | null;
	deriver: string | null;
	ca: string | null;
}

/**
 * Parse the signature-relevant fields out of a narinfo document. Returns null
 * when a field the fingerprint needs is missing or malformed.
 */
export function parseNarInfo(text: string): ParsedNarInfo | null {
	const fields = new Map<string, string>();
	const sigs: string[] = [];
	for (const line of text.split('\n')) {
		const colon = line.indexOf(': ');
		if (colon === -1) continue;
		const key = line.slice(0, colon);
		const value = line.slice(colon + 2).trim();
		if (key === 'Sig') sigs.push(value);
		else if (!fields.has(key)) fields.set(key, value);
	}
	const storePath = fields.get('StorePath');
	const narHash = fields.get('NarHash');
	const narSize = Number(fields.get('NarSize'));
	if (!storePath || !narHash || !Number.isFinite(narSize)) return null;
	const references = (fields.get('References') ?? '').split(' ').filter(Boolean);
	const fileSizeRaw = fields.get('FileSize');
	const fileSize = fileSizeRaw != null ? Number(fileSizeRaw) : null;
	return {
		storePath,
		narHash,
		narSize,
		references,
		sigs,
		url: fields.get('URL') ?? null,
		compression: fields.get('Compression') ?? null,
		fileHash: fields.get('FileHash') ?? null,
		fileSize: Number.isFinite(fileSize as number) ? fileSize : null,
		system: fields.get('System') ?? null,
		deriver: fields.get('Deriver') ?? null,
		ca: fields.get('CA') ?? null
	};
}

/**
 * Whether any signature on a narinfo document verifies against the given
 * public key. Used to gate upstream passthrough on the configured trust root.
 */
export async function narInfoSignatureValid(text: string, publicKey: string): Promise<boolean> {
	return parsedNarInfoSignatureValid(parseNarInfo(text), publicKey);
}

/** narInfoSignatureValid for callers that already hold the parsed document. */
export async function parsedNarInfoSignatureValid(
	parsed: ParsedNarInfo | null,
	publicKey: string
): Promise<boolean> {
	if (!parsed) return false;
	const fingerprint = computeFingerprint(
		parsed.storePath,
		parsed.narHash,
		parsed.narSize,
		parsed.references
	);
	for (const sig of parsed.sigs) {
		if (await verifySignature(publicKey, sig, fingerprint)) return true;
	}
	return false;
}

export async function buildNarInfo(
	object: NarInfoObject,
	nar: NarInfoNar,
	chunks: NarInfoChunk[],
	keypair: string | null
): Promise<string> {
	const lines: string[] = [];

	lines.push(`StorePath: ${object.store_path}`);

	const hashForUrl = nar.nar_hash.startsWith('sha256:') ? nar.nar_hash.slice(7) : nar.nar_hash;
	lines.push(`URL: nar/${hashForUrl}.nar${compressionExtension(nar.compression)}`);
	lines.push(`Compression: ${nar.compression}`);

	// FileHash only describes a single stored file; a multi-chunk NAR is served
	// as a concatenation, so only the total FileSize is meaningful there.
	const firstChunk = chunks.length === 1 ? chunks[0] : undefined;
	if (firstChunk?.file_hash && HEX64.test(firstChunk.file_hash)) {
		lines.push(`FileHash: ${convertHashToBase32(`sha256:${firstChunk.file_hash}`)}`);
	}
	const fileSize =
		chunks.length > 0 && chunks.every((c) => c.file_size != null)
			? chunks.reduce((sum, c) => sum + (c.file_size ?? 0), 0)
			: firstChunk?.file_size;
	if (fileSize != null) {
		lines.push(`FileSize: ${fileSize}`);
	}

	if (HEX64.test(hashForUrl)) {
		lines.push(`NarHash: ${convertHashToBase32(`sha256:${hashForUrl}`)}`);
	} else {
		// 52-char values are already base32; anything else passes through for debuggability.
		lines.push(`NarHash: sha256:${hashForUrl}`);
	}
	lines.push(`NarSize: ${nar.nar_size}`);

	const references = parseJsonArray(object.refs);
	if (references.length > 0) {
		lines.push(`References: ${references.join(' ')}`);
	}
	if (object.system) {
		lines.push(`System: ${object.system}`);
	}
	if (object.deriver) {
		lines.push(`Deriver: ${object.deriver}`);
	}

	// Always sign with the cache's own key, dropping any client-supplied sigs:
	// pushed paths often carry signatures from foreign keys (e.g. an upstream
	// cache), but clients only trust this cache's public key.
	const storedSigs = () => parseJsonArray(object.sigs).map((sig) => `Sig: ${sig}`);
	if (keypair) {
		try {
			const fingerprint = computeFingerprint(
				object.store_path,
				nar.nar_hash,
				nar.nar_size,
				references
			);
			lines.push(`Sig: ${await signMessage(keypair, fingerprint)}`);
		} catch (e) {
			// Unsigned narinfo is still valid; fall back to any stored sigs.
			console.warn(`Failed to sign narinfo: ${e}`);
			lines.push(...storedSigs());
		}
	} else {
		lines.push(...storedSigs());
	}

	if (object.ca) {
		lines.push(`CA: ${object.ca}`);
	}

	return lines.join('\n') + '\n';
}
