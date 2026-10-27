// The app uses DOM globals and imports binding types explicitly; avoid loading
// Workers' competing Web API globals just to type these runtime module exports.
declare module 'cloudflare:workers' {
	export const env: App.Platform['env'];
	export const exports: NonNullable<
		import('$lib/server/cache/platform').ExecutionContext['exports']
	>;
	export const waitUntil: App.Platform['ctx']['waitUntil'];
}
