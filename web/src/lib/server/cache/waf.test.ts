import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the deployed WAF admits repair requests and preserves API family boundaries', () => {
	// Exercise the actual deployment payload without credentials or API calls.
	const script = fileURLToPath(new URL('../../../../scripts/deploy-waf.mjs', import.meta.url));
	const policy = JSON.parse(
		execFileSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8' })
	);
	const rule = policy.customRules.find(
		(r: { description: string }) => r.description === 'cache: junk shapes and unsupported API paths'
	);
	const shapes = rule.expression.match(/and not \((.*?)\)\) or /)?.[1];
	expect(shapes).toBeTruthy();
	const permitted = [
		...shapes.matchAll(
			/http\.request\.uri\.path eq "([^"]+)"|starts_with\(http\.request\.uri\.path, "([^"]+)"\)/g
		)
	];
	const admits = (url: string) => {
		const path = new URL(url, 'https://cache.test').pathname;
		return permitted.some(([, exact, prefix]) =>
			exact ? path === exact : path.startsWith(prefix)
		);
	};
	expect(admits('/_api/v1/cache-integrity/kclejeune')).toBe(true);
	for (const operation of ['check', 'purge-plan', 'purge-apply', 'purge-replay'])
		expect(admits('/_api/v1/cache-integrity/kclejeune/' + operation)).toBe(true);
	expect(admits('/_api/v1/cache-integrity/kclejeune?after=00000000000000000000000000000001')).toBe(
		true
	);
	expect(admits('/_api/v1/cache-integrity')).toBe(false);
	expect(admits('/_api/v1/cache-integrityevil/kclejeune')).toBe(false);
	expect(admits('/_api/v1/unknown/kclejeune')).toBe(false);
});
