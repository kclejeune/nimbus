import { describe, expect, it } from 'vitest';
import {
	auditWhere,
	groupActions,
	hasFilters,
	parseAuditFilters,
	SYSTEM_USER,
	targetRef
} from './audit-filters';

const parse = (qs: string) => parseAuditFilters(new URLSearchParams(qs));

describe('parseAuditFilters', () => {
	it('reads user, action and q', () => {
		expect(parse('user=u1&action=cache.create&q=%20main%20')).toEqual({
			user: 'u1',
			action: 'cache.create',
			q: 'main'
		});
	});

	it('accepts families and drops malformed actions', () => {
		expect(parse('action=token.*').action).toBe('token.*');
		expect(parse("action=cache.create' OR 1=1").action).toBeNull();
		expect(parse('action=%25').action).toBeNull();
	});

	it('treats empty params as no filter', () => {
		const f = parse('user=&action=&q=');
		expect(f).toEqual({ user: null, action: null, q: '' });
		expect(hasFilters(f)).toBe(false);
	});
});

describe('auditWhere', () => {
	it('is empty without filters', () => {
		expect(auditWhere({ user: null, action: null, q: '' })).toEqual({ sql: '', binds: [] });
	});

	it('binds every value and escapes LIKE wildcards', () => {
		const { sql, binds } = auditWhere({ user: 'u1', action: 'cache.*', q: '50%_off' });
		expect(sql).toBe(
			"WHERE a.user_id = ? AND a.action LIKE ? ESCAPE '\\' AND (a.target LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')"
		);
		expect(binds).toEqual(['u1', 'cache.%', '%50\\%\\_off%', '%50\\%\\_off%']);
	});

	it('matches system entries by a null user and exact actions by equality', () => {
		expect(auditWhere({ user: SYSTEM_USER, action: 'gc.trigger', q: '' })).toEqual({
			sql: 'WHERE a.user_id IS NULL AND a.action = ?',
			binds: ['gc.trigger']
		});
	});
});

describe('groupActions', () => {
	it('groups by family, sorted', () => {
		expect(groupActions(['token.revoke', 'cache.create', 'token.issue'])).toEqual([
			{ family: 'cache', actions: ['cache.create'] },
			{ family: 'token', actions: ['token.issue', 'token.revoke'] }
		]);
	});
});

describe('targetRef', () => {
	it('maps targets to the entity their action names', () => {
		expect(targetRef('cache.rename', 'main')).toEqual({ kind: 'cache', key: 'main' });
		expect(targetRef('path.destroy', 'ci/abc')).toEqual({ kind: 'cache', key: 'ci' });
		expect(targetRef('user.activate', 'u1')).toEqual({ kind: 'user', key: 'u1' });
		expect(targetRef('group.member.add', 'g1')).toEqual({ kind: 'group', key: 'g1' });
		expect(targetRef('token.issue', 'jti')).toEqual({ kind: 'token', key: 'jti' });
	});

	it('leaves unresolvable targets alone', () => {
		expect(targetRef('grant.create', 'grant-id')).toBeNull();
		expect(targetRef('upstream.add', 'https://cache.nixos.org')).toBeNull();
		expect(targetRef('gc.trigger', null)).toBeNull();
	});
});
