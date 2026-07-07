// @ts-nocheck
import { Module } from '../module';
import { isError } from '../errors';
export const decompress = (buf, dstCapacity) => {
	const malloc = Module['_malloc'];
	const free = Module['_free'];
	const src = malloc(buf.byteLength);
	Module.HEAP8.set(buf, src);
	const dst = malloc(dstCapacity);
	try {
		/*
          size_t ZSTD_decompress(void* dst, size_t dstCapacity, const void* src, size_t compressedSize);
          `src` must be the exact concatenation of one or more complete zstd
          frames — trailing garbage fails. Content larger than `dstCapacity`
          fails with dstSize_tooSmall, which doubles as the zstd-bomb guard.
          @return : the number of bytes decompressed into `dst`,
                    or an error code if it fails (which can be tested using ZSTD_isError()).
        */
		const _decompress = Module['_ZSTD_decompress'];
		const sizeOrError = _decompress(dst, dstCapacity, src, buf.byteLength);
		if (isError(sizeOrError)) {
			throw new Error(`Failed to decompress with code ${sizeOrError}`);
		}
		const data = new Uint8Array(Module.HEAPU8.buffer, dst, sizeOrError).slice();
		free(dst, dstCapacity);
		free(src, buf.byteLength);
		return data;
	} catch (e) {
		free(dst, dstCapacity);
		free(src, buf.byteLength);
		throw e;
	}
};
