// Must be imported before zstd-lib: the Emscripten glue reads
// globalThis.Module at evaluation time, and Workers can only run WASM that
// was compiled at deploy (no WebAssembly.instantiate from bytes), so the
// module comes from a CompiledWasm import.

import zstdWasmModule from './zstd.wasm';

(globalThis as Record<string, unknown>).Module = {
	instantiateWasm: (
		imports: WebAssembly.Imports,
		successCallback: (instance: WebAssembly.Instance) => void
	) => {
		WebAssembly.instantiate(zstdWasmModule, imports)
			.then((instance) => successCallback(instance))
			.catch((err) => console.error('Failed to instantiate zstd WASM:', err));
		return {};
	}
};
