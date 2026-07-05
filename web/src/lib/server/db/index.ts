import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from './schema';

export type Db = ReturnType<typeof getDb>;

/** Build a Drizzle client bound to the request's D1 database. */
export function getDb(d1: D1Database) {
	return drizzle(d1 as never, { schema });
}

export { schema };
