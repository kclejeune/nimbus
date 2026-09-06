import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from './test-db';
import {
	claimOrphanChunks,
	publishChunk,
	releaseChunkLocksById,
	settleChunks,
	stageChunk,
	tryLockChunk,
	type NewChunk
} from './db';

describe('chunk ownership and GC', () => {
	const fixture = testDatabase();
	const chunk: NewChunk = {
		state: 'P',
		chunk_hash: 'sha256:raw',
		chunk_size: 10,
		file_hash: 'compressed',
		file_size: 5,
		compression: 'zstd',
		remote_file: JSON.stringify({ key: 'chunk/raw' }),
		remote_file_id: 'chunk/raw'
	};
	afterEach(() => fixture.sqlite.exec('DELETE FROM chunk'));
	it('allows identical pending retries but rejects a live conflicting encoding', async () => {
		const a = await stageChunk(fixture.db, chunk);
		const b = await stageChunk(fixture.db, chunk);
		expect(a!.id).toBe(b!.id);
		expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()!.holders_count).toBe(2);
		expect(await stageChunk(fixture.db, { ...chunk, file_hash: 'other' })).toBeNull();
		await publishChunk(fixture.db, a!.id);
		expect(await stageChunk(fixture.db, { ...chunk, file_hash: 'other' })).toMatchObject({
			id: a!.id,
			state: 'V',
			file_hash: 'compressed'
		});
	});
	it('takes over an abandoned pending row from another encoder', async () => {
		const a = await stageChunk(fixture.db, chunk);
		await releaseChunkLocksById(fixture.db, [a!.id]);
		fixture.sqlite.exec("UPDATE chunk SET created_at = datetime('now', '-2 hours')");
		const other = { ...chunk, file_hash: 'other', file_size: 7 };
		expect(await stageChunk(fixture.db, other)).toMatchObject({
			id: a!.id,
			state: 'P',
			file_hash: 'other',
			file_size: 7
		});
		// Held, and back inside the reaper's grace period.
		expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()!.holders_count).toBe(1);
		expect(await claimOrphanChunks(fixture.db)).toEqual([]);
	});
	it('takes over a pending row whose holder died, once its hold has aged', async () => {
		const a = await stageChunk(fixture.db, chunk);
		const other = { ...chunk, file_hash: 'other' };
		expect(await stageChunk(fixture.db, other)).toBeNull();
		fixture.sqlite.exec("UPDATE chunk SET held_at = datetime('now', '-2 hours')");
		expect(await stageChunk(fixture.db, other)).toMatchObject({ id: a!.id, file_hash: 'other' });
	});
	it('settles fresh and shared rows in one batch', async () => {
		const a = await stageChunk(fixture.db, chunk);
		await settleChunks(fixture.db, [{ id: a!.id, publish: true }]);
		expect(fixture.sqlite.prepare('SELECT state, holders_count FROM chunk').get()).toMatchObject({
			state: 'V',
			holders_count: 0
		});
		await settleChunks(fixture.db, [{ id: a!.id, publish: true }]);
		expect(fixture.sqlite.prepare('SELECT holders_count FROM chunk').get()!.holders_count).toBe(0);
	});
	it('protects held chunks and prevents adoption after GC claims an orphan', async () => {
		const row = await stageChunk(fixture.db, chunk);
		fixture.sqlite.exec("UPDATE chunk SET created_at = datetime('now', '-2 hours')");
		expect(await claimOrphanChunks(fixture.db)).toEqual([]);
		await releaseChunkLocksById(fixture.db, [row!.id]);
		expect(await claimOrphanChunks(fixture.db)).toEqual([
			{ id: row!.id, remote_file: chunk.remote_file }
		]);
		expect(await stageChunk(fixture.db, chunk)).toBeNull();
		expect(await tryLockChunk(fixture.db, chunk.chunk_hash, chunk.compression)).toBeNull();
		await publishChunk(fixture.db, row!.id);
		expect(fixture.sqlite.prepare('SELECT state FROM chunk').get()!.state).toBe('D');
		// A failed R2 delete can be retried by the next GC run...
		expect(await claimOrphanChunks(fixture.db)).toHaveLength(1);
		// ...and an upload may take the row back once the claim has aged.
		fixture.sqlite.exec("UPDATE chunk SET held_at = datetime('now', '-2 hours')");
		expect(await stageChunk(fixture.db, chunk)).toMatchObject({ id: row!.id, state: 'P' });
	});
});
