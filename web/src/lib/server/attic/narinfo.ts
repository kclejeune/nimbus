// narinfo rendering, mirroring the Rust worker's build_narinfo byte-for-byte
// (field order, base32 conversion). The cache's own key always signs the
// narinfo; client-supplied sigs are served only when the cache has no keypair.

import type { ChunkRow, NarRow, ObjectRow } from './db';
import { convertHashToBase32 } from './nix-base32';
import { computeFingerprint, signMessage } from './signing';

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

export async function buildNarInfo(
	object: ObjectRow,
	nar: NarRow,
	chunks: ChunkRow[],
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
