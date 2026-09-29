/** Response of GET /search, the ⌘K palette's server lookup. */
export interface SearchResults {
	caches: { name: string; isPublic: boolean }[];
	paths: { storePath: string; hash: string; cache: string }[];
	users: { id: string; name: string; email: string }[];
	groups: { id: string; name: string }[];
}
