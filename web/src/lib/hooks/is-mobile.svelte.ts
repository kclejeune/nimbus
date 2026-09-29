import { MediaQuery } from 'svelte/reactivity';

// Below lg the sidebar becomes a sheet: at md widths a docked 240px sidebar
// leaves too little room for the data tables.
const DEFAULT_MOBILE_BREAKPOINT = 1024;

export class IsMobile extends MediaQuery {
	constructor(breakpoint: number = DEFAULT_MOBILE_BREAKPOINT) {
		super(`max-width: ${breakpoint - 1}px`);
	}
}
