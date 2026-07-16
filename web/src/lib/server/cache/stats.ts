// Instance-wide storage stats shared by the Overview and Monitoring pages.

type D1 = App.Platform['env']['ATTIC_DB'];

export interface InstanceStats {
	caches: number;
	objects: number;
	/** Valid (fully uploaded) NARs. */
	nars: number;
	/** Physical bytes stored, after NAR- and chunk-level dedup. */
	storageBytes: number;
	/** Every object's NAR counted once per reference; the excess over
	 *  storageBytes is what deduplication saves. */
	logicalBytes: number;
}

type Count = { n: number };

/** The five headline counts, batched; pass a replica session — every caller
 *  is a read-only dashboard. */
export async function instanceStats(db: D1): Promise<InstanceStats> {
	const [caches, objects, nars, storage, logical] = await Promise.all([
		db.prepare('SELECT COUNT(*) AS n FROM cache WHERE deleted_at IS NULL').first<Count>(),
		db
			.prepare(
				'SELECT COUNT(*) AS n FROM object o JOIN cache c ON c.id = o.cache_id WHERE c.deleted_at IS NULL'
			)
			.first<Count>(),
		db.prepare("SELECT COUNT(*) AS n FROM nar WHERE state = 'V'").first<Count>(),
		db
			.prepare("SELECT COALESCE(SUM(file_size), 0) AS n FROM chunk WHERE state = 'V'")
			.first<Count>(),
		db
			.prepare(
				'SELECT COALESCE(SUM(sz.bytes), 0) AS n FROM object o ' +
					'JOIN (SELECT cr.nar_id, SUM(ch.file_size) AS bytes FROM chunkref cr ' +
					'JOIN chunk ch ON ch.id = cr.chunk_id GROUP BY cr.nar_id) sz ON sz.nar_id = o.nar_id'
			)
			.first<Count>()
	]);
	return {
		caches: caches?.n ?? 0,
		objects: objects?.n ?? 0,
		nars: nars?.n ?? 0,
		storageBytes: storage?.n ?? 0,
		logicalBytes: logical?.n ?? 0
	};
}
