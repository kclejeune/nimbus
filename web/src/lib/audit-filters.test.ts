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
	it('reads users, actions and q, deduplicated', () => {
		expect(parse('user=u1&user=u2&user=u1&action=cache.create&q=%20main%20')).toEqual({
			users: ['u1', 'u2'],
			actions: ['cache.create'],
			q: 'main'
		});
	});

	it('accepts families and drops malformed actions', () => {
		expect(parse('action=token.*&action=cache.create').actions).toEqual([
			'token.*',
			'cache.create'
		]);
		expect(parse("action=cache.create' OR 1=1").actions).toEqual([]);
		expect(parse('action=%25').actions).toEqual([]);
	});

	it('treats empty params as no filter', () => {
		const f = parse('user=&action=&q=');
		expect(f).toEqual({ users: [], actions: [], q: '' });
		expect(hasFilters(f)).toBe(false);
	});
});

describe('auditWhere', () => {
	it('is empty without filters', () => {
		expect(auditWhere({ users: [], actions: [], q: '' })).toEqual({ sql: '', binds: [] });
	});

	it('binds every value and escapes LIKE wildcards', () => {
		const { sql, binds } = auditWhere({ users: ['u1'], actions: ['cache.*'], q: '50%_off' });
		expect(sql).toBe(
			"WHERE a.user_id IN (SELECT value FROM json_each(?)) AND a.action LIKE ? ESCAPE '\\' AND (a.target LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')"
		);
		expect(binds).toEqual(['["u1"]', 'cache.%', '%50\\%\\_off%', '%50\\%\\_off%']);
	});

	it('matches system entries by a null user and exact actions by equality', () => {
		expect(auditWhere({ users: [SYSTEM_USER], actions: ['gc.trigger'], q: '' })).toEqual({
			sql: 'WHERE a.user_id IS NULL AND a.action = ?',
			binds: ['gc.trigger']
		});
	});

	it('ORs several users (system included) and several actions', () => {
		expect(
			auditWhere({ users: ['u1', SYSTEM_USER], actions: ['gc.trigger', 'token.*'], q: '' })
		).toEqual({
			sql: "WHERE (a.user_id IN (SELECT value FROM json_each(?)) OR a.user_id IS NULL) AND (a.action = ? OR a.action LIKE ? ESCAPE '\\')",
			binds: ['["u1"]', 'gc.trigger', 'token.%']
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
