import * as db from './db';
import { candidateTag } from './metadata';
import { narBodyTag, narinfoTag, ROOT_UPSTREAM_TAG_NS } from './store';
import { withR2Retry } from './platform';
import { PURGE_TAG_LIMIT } from './purge';
import { PURGE_INTERVAL_MS } from './purge-queue';

type Env = App.Platform['env'];
// false means durably pending, never permission to advance the cursor.
type Purge = (tags: string[], receipt: string) => Promise<void | boolean>;
// One purge call per page. Persist progress before yielding so a widely
// shared chunk never monopolizes a request or cron run.
const TAGS_PER_OBJECT = 4;
const PAGE_SIZE = Math.floor(PURGE_TAG_LIMIT / TAGS_PER_OBJECT);
const PAGES_PER_RUN = 10;
export const REPAIR_RETIRE_GRACE_MS = 5 * 60 * 1000;

export async function processChunkRepair(
	env: Env,
	key: string,
	purge: Purge
): Promise<number | null> {
	const job = await db.dbFirst<db.ChunkRepair>(
		env.ATTIC_DB.prepare('SELECT * FROM chunk_repair WHERE new_key = ?1').bind(key)
	);
	if (!job) return null;
	if (job.retire_after !== null) {
		if (Date.now() < job.retire_after) return job.retire_after;
		// Every key is minted once, so a retiring key cannot become live again
		// and retrying this deletion is safe. A row still pointing at it means
		// the pointer moved without a journal or was rolled back: keep the
		// object and the job, and let the failure surface.
		if (job.old_key) {
			const live = await db.dbFirst(
				env.ATTIC_DB.prepare('SELECT 1 FROM chunk WHERE remote_file_id = ?1 LIMIT 1').bind(
					job.old_key
				)
			);
			if (live) throw new Error(`Repair retirement still references ${job.old_key}`);
			await withR2Retry(() => env.CACHE_BUCKET.delete(job.old_key!));
		}
		await db.dbRun(env.ATTIC_DB.prepare('DELETE FROM chunk_repair WHERE new_key = ?1').bind(key));
		return null;
	}
	for (let page = 0; page < PAGES_PER_RUN; page++) {
		const refs = await db.objectsReferencingChunk(
			env.ATTIC_DB,
			job.chunk_id,
			job.object_cursor,
			PAGE_SIZE
		);
		if (refs.length === 0) {
			const retireAt = Date.now() + REPAIR_RETIRE_GRACE_MS;
			await db.dbRun(
				env.ATTIC_DB.prepare(
					'UPDATE chunk_repair SET retire_after = COALESCE(retire_after, ?1) WHERE new_key = ?2'
				).bind(retireAt, key)
			);
			return retireAt;
		}
		const tags = new Set<string>();
		for (const ref of refs) {
			tags.add(candidateTag('nar', ref.nar_hash));
			tags.add(narBodyTag(ref.nar_hash));
			tags.add(narinfoTag(ref.cache_name, ref.store_path_hash));
			tags.add(narinfoTag(ROOT_UPSTREAM_TAG_NS, ref.store_path_hash));
		}
		// Failures leave both the cursor and old object intact. This D1 job is
		// itself the retry journal, including failures before calling purge.
		// Bind the receipt to the exact page contents as well as its cursor.
		// A changed page must not reuse an earlier eviction's acknowledgement.
		const receipt = JSON.stringify([job.object_cursor, refs.at(-1)!.id, [...tags].sort()]);
		if ((await purge([...tags], receipt)) === false) return Date.now() + PURGE_INTERVAL_MS;
		job.object_cursor = refs.at(-1)!.id;
		await db.dbRun(
			env.ATTIC_DB.prepare(
				'UPDATE chunk_repair SET object_cursor = MAX(object_cursor, ?1) WHERE new_key = ?2'
			).bind(job.object_cursor, key)
		);
	}
	return Date.now() + PURGE_INTERVAL_MS;
}

/** Hand each due repair job to `process` (run it now, or schedule it). */
export async function replayChunkRepairs(
	env: Env,
	process: (key: string) => Promise<unknown>
): Promise<void> {
	const jobs = (
		await db.dbAll<{ new_key: string }>(
			env.ATTIC_DB.prepare(
				'SELECT new_key FROM chunk_repair WHERE retire_after IS NULL OR retire_after <= ?1 ORDER BY rowid LIMIT 100'
			).bind(Date.now())
		)
	).results;
	for (const job of jobs) {
		try {
			await process(job.new_key);
		} catch (error) {
			console.warn('chunk repair replay pending', { key: job.new_key, error });
		}
	}
}
