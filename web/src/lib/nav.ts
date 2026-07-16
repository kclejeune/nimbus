// Single source of truth for the app's top-level sections. The sidebar
// renders these and the header derives the current page title from the same
// list, so a section can't be navigable but titled "Overview" (or vice versa).
import {
	Boxes,
	ChartLine,
	CloudDownload,
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

export const NAV_ITEMS: NavItem[] = [
	{ title: 'Overview', url: '/', icon: LayoutDashboard },
	{ title: 'Caches', url: '/caches', icon: Boxes },
	{ title: 'Upstreams', url: '/upstreams', icon: CloudDownload, adminOnly: true },
	{ title: 'Monitoring', url: '/monitoring', icon: ChartLine },
	{ title: 'Tokens', url: '/tokens', icon: KeyRound },
	{ title: 'Users', url: '/users', icon: Users, adminOnly: true },
	{ title: 'Groups', url: '/groups', icon: UsersRound, adminOnly: true },
	{ title: 'Audit', url: '/audit', icon: ScrollText, adminOnly: true },
	{ title: 'Settings', url: '/settings', icon: Settings }
];

/** Title of the section owning `pathname`; subpages inherit their section's. */
export function sectionTitle(pathname: string): string {
	const hit = NAV_ITEMS.find(
		(item) => item.url !== '/' && (pathname === item.url || pathname.startsWith(item.url + '/'))
	);
	return hit?.title ?? 'Overview';
}
