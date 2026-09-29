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
	Users,
	UsersRound
} from '@lucide/svelte';

export interface NavItem {
	title: string;
	url: string;
	icon: typeof Boxes;
	adminOnly?: boolean;
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
			{ title: 'Users', url: '/users', icon: Users, adminOnly: true },
			{ title: 'Groups', url: '/groups', icon: UsersRound, adminOnly: true },
			{ title: 'Audit', url: '/audit', icon: ScrollText, adminOnly: true },
			{ title: 'Settings', url: '/settings', icon: Settings, adminOnly: true }
		]
	}
];

// Sections reachable only from the user menu still need a header title.
// (Role-hidden sidebar items need no entry: sectionTitle matches every nav
// item regardless of adminOnly, so /users/[id] already titles as "Users".)
const EXTRA_SECTIONS: { title: string; url: string }[] = [{ title: 'Account', url: '/account' }];

const ALL_SECTIONS = [...NAV_GROUPS.flatMap((g) => g.items), ...EXTRA_SECTIONS];

/** Title of the section owning `pathname`; subpages inherit their section's. */
export function sectionTitle(pathname: string): string {
	const hit = ALL_SECTIONS.find(
		(item) => item.url !== '/' && (pathname === item.url || pathname.startsWith(item.url + '/'))
	);
	return hit?.title ?? 'Overview';
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
 * "Users / Ada Lovelace" rather than an opaque id.
 */
export function breadcrumbs(pathname: string, data: Record<string, unknown>): Crumb[] {
	const section = ALL_SECTIONS.find(
		(item) => item.url !== '/' && (pathname === item.url || pathname.startsWith(item.url + '/'))
	);
	if (!section) return [{ label: 'Overview', href: '/' }];
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
		} else if (section.url === '/users') {
			const subject = data.subject as { name?: string; email?: string } | undefined;
			crumbs.push({ label: subject?.name || subject?.email || 'User', href });
		} else if (section.url === '/groups') {
			const group = data.group as { name?: string } | undefined;
			crumbs.push({ label: group?.name ?? 'Group', href });
		} else {
			crumbs.push({ label: seg, href });
		}
	});
	return crumbs;
}
