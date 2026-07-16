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
			{ title: 'Monitoring', url: '/monitoring', icon: ChartLine }
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
