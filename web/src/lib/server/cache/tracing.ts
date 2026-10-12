type Span = { setAttribute(key: string, value: string | number | boolean): unknown };
interface Tracing {
	getActiveSpan?(): Span | undefined;
	enterSpan?<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>;
}

const tracingOf = (ctx: unknown) => (ctx as { tracing?: Tracing } | undefined)?.tracing;

/** Custom spans need tracing enabled in the Worker's observability config;
 * a deployment without it (the template allows that) must still serve. */
export function withSpan<T>(ctx: unknown, name: string, fn: () => Promise<T>): Promise<T> {
	const tracing = tracingOf(ctx);
	if (typeof tracing?.enterSpan !== 'function') return fn();
	return tracing.enterSpan(name, fn);
}

/** Annotate the invocation root before entering the child span. Exporters
 * group HTTP transactions using the root's http.route, not a child's name.
 * Feature detection also supports workerd versions predating getActiveSpan.
 * `template` is routeTemplate()'s `METHOD /path` form. */
export function withRequestSpan<T>(
	ctx: unknown,
	template: string,
	layer: 'gateway' | 'store',
	fn: () => Promise<T>
): Promise<T> {
	const tracing = tracingOf(ctx);
	const route = template.slice(template.indexOf(' ') + 1);
	const annotate = (span?: Span) => {
		span?.setAttribute('http.route', route);
		span?.setAttribute('nimbus.layer', layer);
	};
	const root = tracing?.getActiveSpan?.();
	annotate(root);
	const run = async (span?: Span) => {
		const started = performance.now();
		const result = await fn();
		if (result instanceof Response) {
			const headerMs = performance.now() - started;
			for (const target of [root, span]) {
				target?.setAttribute('nimbus.header_ms', headerMs);
				target?.setAttribute('http.response.status_code', result.status);
				const length = result.headers.get('Content-Length');
				if (length !== null) target?.setAttribute('nimbus.response_bytes', Number(length));
			}
		}
		return result;
	};
	if (typeof tracing?.enterSpan !== 'function') return run();
	return tracing.enterSpan(`${layer} ${template}`, (span) => {
		annotate(span);
		return run(span);
	});
}
