// Single source of truth for the app's top-level sections. The sidebar
// renders these and the header derives the current page title from the same
// list, so a section can't be navigable but titled "Overview" (or vice versa).
import {
	Boxes,
	ChartLine,
	CloudDownload,
	FolderSearch,
	KeyRound,
	LayoutDashboard,
	ScrollText,
	Settings,
	Users
} from '@lucide/svelte';

export interface NavItem {
	title: string;
	url: string;
	icon: typeof Boxes;
	adminOnly?: boolean;
	/** Other URL prefixes owned by this section (Team spans /users and /groups). */
	match?: string[];
}

export interface NavGroup {
	/** Omitted for the leading ungrouped items. */
	label?: string;
	items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{ title: 'Overview', url: '/', icon: LayoutDashboard },
			{ title: 'Usage', url: '/usage', icon: ChartLine }
		]
	},
	{
		label: 'Cache',
		items: [
			{ title: 'Caches', url: '/caches', icon: Boxes },
			{ title: 'Paths', url: '/paths', icon: FolderSearch }
		]
	},
	{
		label: 'Access',
		items: [{ title: 'Tokens', url: '/tokens', icon: KeyRound }]
	},
	{
		label: 'Admin',
		items: [
			{ title: 'Upstreams', url: '/upstreams', icon: CloudDownload, adminOnly: true },
			{ title: 'Team', url: '/users', icon: Users, adminOnly: true, match: ['/groups'] },
			{ title: 'Audit', url: '/audit', icon: ScrollText, adminOnly: true },
			{ title: 'Settings', url: '/settings', icon: Settings, adminOnly: true }
		]
	}
];

// Sections reachable only from the user menu still need a header title.
// (Role-hidden sidebar items need no entry: sections match every nav item
// regardless of adminOnly, so /users/[id] still titles as "Team".)
const EXTRA_SECTIONS: { title: string; url: string; match?: string[] }[] = [
	{ title: 'Profile', url: '/account' }
];

const ALL_SECTIONS = [...NAV_GROUPS.flatMap((g) => g.items), ...EXTRA_SECTIONS];

const under = (pathname: string, prefix: string) =>
	pathname === prefix || pathname.startsWith(prefix + '/');

/** Whether `pathname` belongs to the section at `url` (plus its `match` prefixes). */
export function inSection(pathname: string, item: { url: string; match?: string[] }): boolean {
	if (item.url === '/') return pathname === '/';
	return [item.url, ...(item.match ?? [])].some((prefix) => under(pathname, prefix));
}

/** The section owning `pathname`; subpages inherit their section's. */
function sectionFor(pathname: string) {
	return ALL_SECTIONS.find((item) => item.url !== '/' && inSection(pathname, item));
}

/** Title of the section owning `pathname`. */
export function sectionTitle(pathname: string): string {
	return sectionFor(pathname)?.title ?? 'Overview';
}

/** Per-cache tab segments under /caches/[name]. */
const CACHE_TABS: Record<string, string> = {
	connect: 'Connect',
	pins: 'Pins',
	access: 'Access',
	settings: 'Settings'
};

export interface Crumb {
	label: string;
	href: string;
	mono?: boolean;
}

/**
 * Header breadcrumbs for `pathname`. Entity segments (a cache, a user) are
 * labeled from the page's own load data when it has them, so the trail reads
 * "Team / People / Ada Lovelace" rather than an opaque id.
 */
export function breadcrumbs(pathname: string, data: Record<string, unknown>): Crumb[] {
	const section = sectionFor(pathname);
	if (!section) return [{ label: 'Overview', href: '/' }];
	// Team spans two URL roots, each a tab: Team › People|Groups › entity.
	if (section.title === 'Team') {
		const people = under(pathname, '/users');
		const crumbs: Crumb[] = [
			{ label: 'Team', href: '/users' },
			{ label: people ? 'People' : 'Groups', href: people ? '/users' : '/groups' }
		];
		if (pathname.split('/').filter(Boolean).length > 1) {
			if (people) {
				const subject = data.subject as { name?: string; email?: string } | undefined;
				crumbs.push({ label: subject?.name || subject?.email || 'User', href: pathname });
			} else {
				const group = data.group as { name?: string } | undefined;
				crumbs.push({ label: group?.name ?? 'Group', href: pathname });
			}
		}
		return crumbs;
	}
	const crumbs: Crumb[] = [{ label: section.title, href: section.url }];
	const rest = pathname.slice(section.url.length).split('/').filter(Boolean);
	let href = section.url;
	rest.forEach((raw, i) => {
		const seg = decodeURIComponent(raw);
		href += '/' + raw;
		const prev = rest[i - 1];
		if (section.url === '/caches' && i === 0) {
			crumbs.push({ label: seg === 'new' ? 'New cache' : seg, href, mono: seg !== 'new' });
		} else if (section.url === '/caches' && CACHE_TABS[seg]) {
			crumbs.push({ label: CACHE_TABS[seg], href });
		} else if (seg === 'paths') {
			// /caches/[name]/paths is an API endpoint, not a page: fold it into the next crumb.
			return;
		} else if (prev === 'paths') {
			const obj = data.object as { storePath?: string } | undefined;
			const name = obj?.storePath?.replace(/^\/nix\/store\/[0-9a-z]{32}-/, '');
			crumbs.push({ label: name ?? seg.slice(0, 8), href, mono: true });
		} else {
			crumbs.push({ label: seg, href });
		}
	});
	return crumbs;
}
