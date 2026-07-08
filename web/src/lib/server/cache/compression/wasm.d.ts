// wrangler's CompiledWasm rule turns .wasm imports into precompiled modules.
// Only the wrangler bundle (worker-entry.ts) may import this transitively —
// Vite does not handle it, which is why the cache API dispatch lives in the
// worker entry rather than hooks.server.ts.
declare module '*.wasm' {
	const wasmModule: WebAssembly.Module;
	export default wasmModule;
}
