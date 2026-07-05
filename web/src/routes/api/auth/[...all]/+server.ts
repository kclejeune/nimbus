import { error } from '@sveltejs/kit';
import { createAuth } from '$lib/server/auth/auth';
import type { RequestHandler } from './$types';

const handler: RequestHandler = ({ request, platform }) => {
	if (!platform?.env) throw error(500, 'Platform bindings unavailable');
	return createAuth(platform.env).handler(request);
};

export const GET = handler;
export const POST = handler;
