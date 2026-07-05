// narinfo rendering, mirroring the Rust worker's build_narinfo byte-for-byte
// (field order, base32 conversion, server-side signing when the object carries
// no client signatures).

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
	firstChunk: ChunkRow | undefined,
	keypair: string | null
): Promise<string> {
	const lines: string[] = [];

	lines.push(`StorePath: ${object.store_path}`);

	const hashForUrl = nar.nar_hash.startsWith('sha256:') ? nar.nar_hash.slice(7) : nar.nar_hash;
	lines.push(`URL: nar/${hashForUrl}.nar${compressionExtension(nar.compression)}`);
	lines.push(`Compression: ${nar.compression}`);

	if (firstChunk?.file_hash && HEX64.test(firstChunk.file_hash)) {
		lines.push(`FileHash: ${convertHashToBase32(`sha256:${firstChunk.file_hash}`)}`);
	}
	if (firstChunk?.file_size != null) {
		lines.push(`FileSize: ${firstChunk.file_size}`);
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

	const sigs = parseJsonArray(object.sigs);
	for (const sig of sigs) {
		lines.push(`Sig: ${sig}`);
	}
	if (sigs.length === 0 && keypair) {
		try {
			const fingerprint = computeFingerprint(
				object.store_path,
				nar.nar_hash,
				nar.nar_size,
				references
			);
			lines.push(`Sig: ${await signMessage(keypair, fingerprint)}`);
		} catch (e) {
			// Unsigned narinfo is still valid; don't fail the response.
			console.warn(`Failed to sign narinfo: ${e}`);
		}
	}

	if (object.ca) {
		lines.push(`CA: ${object.ca}`);
	}

	return lines.join('\n') + '\n';
}
