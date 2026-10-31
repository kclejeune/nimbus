// Run against real native streams; Vitest's Node environment has no
// FixedLengthStream or readAtLeast. --benchmark also compares 64 MiB forwarding.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const { outputFiles } = await build({
	entryPoints: [fileURLToPath(new URL('./fixtures/store-transport-worker.ts', import.meta.url))],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	external: ['node:*'],
	write: false
});
const mf = new Miniflare(
	convertV4MiniflareOptions({
		modules: true,
		script: outputFiles[0].text,
		compatibilityDate: '2026-10-10',
		compatibilityFlags: ['nodejs_compat'],
		cf: false,
		telemetry: { enabled: false }
	})
);
const stats = async () => (await mf.dispatchFetch('https://cache.test/stats')).json();
const stream = async (size, mode = '') =>
	fetch(new URL(`/_nar_v2/fixture.nar?size=${size}&mode=${mode}`, await mf.ready));

try {
	// The completion collector uses native batching into its output buffer.
	// Incorrect size hints must still trim/grow and enforce the byte limit.
	for (const [size, hint] of [
		[65535, 65535],
		[65536, 65536],
		[131089, 131089],
		[131089, 65536],
		[65536, 131072],
		[17, 0]
	]) {
		const response = await stream(size, `collect&hint=${hint}`);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(size, 42));
		const result = await stats();
		assert.equal(result.activeTimers, 0);
		assert.equal(result.timers, 1);
		if (hint === size) assert.ok(result.batchReads <= Math.ceil(size / 65536) + 1);
	}
	assert.equal((await stream(65537, 'collect&hint=65536&limit=65536')).status, 413);
	assert.equal((await stats()).activeTimers, 0);
	for (const size of [65535, 65536, 131071, 131072, 2 * 131072 + 17]) {
		const response = await stream(size);
		assert.equal(response.status, 200);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(size, 42));
		const result = await stats();
		// Miniflare's HTTP frontend strips Content-Length. Check the actual
		// worker response's headers and exercise native length enforcement below.
		assert.equal(result.headersSeen['content-length'], String(size));
		assert.equal(result.activeTimers, 0);
		assert.equal(result.timers, 2);
		if (size < 65536) {
			assert.equal(result.batchReads, 0);
		} else {
			assert.deepEqual(result.readConfig, { min: 65536, capacity: 131072 });
			// Native reads may opportunistically fill more than the minimum.
			assert.ok(result.batchReads >= Math.ceil(size / 131072) + 1);
			assert.ok(result.batchReads <= Math.ceil(size / 65536) + 1);
		}
	}
	const range = await stream(65537, 'range');
	assert.equal(range.status, 206);
	assert.equal(range.headers.get('Content-Range'), 'bytes 0-65536/65538');
	assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.alloc(65537, 42));
	assert.equal((await stats()).activeTimers, 0);
	await assert.rejects(async () => (await stream(131072, 'truncated')).arrayBuffer());
	const truncated = await stats();
	assert.equal(truncated.activeTimers, 0);
	assert.equal(truncated.diagnostic.error, 'Cached response body ended before Content-Length');
	assert.equal(truncated.diagnostic.bytes, 131071);

	await assert.rejects(async () => (await stream(131072, 'error')).arrayBuffer());
	const broken = await stats();
	assert.equal(broken.activeTimers, 0);
	assert.equal(broken.diagnostic.error, 'fixture source disconnected');
	await assert.rejects(async () => (await stream(131072, 'stall')).arrayBuffer());
	const stopped = await stats();
	assert.equal(stopped.activeTimers, 0);
	assert.equal(stopped.cancelled, true);
	assert.equal(stopped.diagnostic.reason, 'body_timeout');
	assert.equal(stopped.diagnostic.bytes, 65536);
	assert.equal(stopped.diagnostic.batchBytes, 65536);
	assert.equal(stopped.diagnostic.bufferBytes, 131072);
	assert.ok(stopped.diagnostic.pendingReadMs >= 15000);

	if (process.argv.includes('--benchmark')) {
		for (const mode of ['collect-plain', 'collect']) {
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				const size = 8 * 1024 * 1024;
				const response = await stream(size, mode);
				assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(size, 42));
				console.log(
					JSON.stringify({
						mode,
						run,
						ms: Math.round(performance.now() - started),
						...(await stats())
					})
				);
			}
		}
		for (const mode of ['native', 'guarded']) {
			for (let run = 0; run < 3; run++) {
				const size = 64 * 1024 * 1024;
				const started = performance.now();
				const response = await stream(size, mode);
				assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(size, 42));
				console.log(
					JSON.stringify({
						mode,
						run,
						ms: Math.round(performance.now() - started),
						...(await stats())
					})
				);
			}
		}
	}
	console.log('Native store transport checks passed.');
} finally {
	await mf.dispose();
}
