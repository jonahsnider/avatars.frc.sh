import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { getAvatar, type Bindings } from './avatar.service';

const JSON_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';
const MAX_TEAM_NUMBER = 50_000;

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
		allowHeaders: ['If-None-Match'],
		exposeHeaders: ['Content-Length', 'ETag', 'Last-Modified', 'X-Avatar-Year'],
		maxAge: 86_400,
	}),
);

app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));

app.get('/', (context) => {
	context.header('Cache-Control', JSON_CACHE_CONTROL);
	return context.json({
		name: 'FRC Avatars',
		imageUrlTemplate: `${new URL(context.req.url).origin}/teams/{teamNumber}.png`,
		source: 'The Blue Alliance',
	});
});

app.get('/health', (context) => {
	context.header('Cache-Control', 'no-store');
	return context.json({ status: 'ok' });
});

app.get('/teams/:filename{.+\\.png}', async (context) => {
	const filename = context.req.param('filename');
	const teamNumber = parseTeamNumber(filename.slice(0, -'.png'.length));

	if (teamNumber === undefined) {
		context.header('Cache-Control', JSON_CACHE_CONTROL);
		return context.json({ error: 'Invalid team number.' }, 400);
	}

	return getAvatar(context.req.raw, context.env, teamNumber);
});

app.notFound((context) => {
	context.header('Cache-Control', JSON_CACHE_CONTROL);
	return context.json({ error: 'Not found.' }, 404);
});

app.onError((error, context) => {
	console.error('Unhandled request error', error);
	context.header('Cache-Control', 'no-store');
	return context.json({ error: 'Internal server error.' }, 500);
});

function parseTeamNumber(value: string): number | undefined {
	const teamNumber = Number(value);

	if (!Number.isInteger(teamNumber) || teamNumber < 1 || teamNumber > MAX_TEAM_NUMBER) {
		return undefined;
	}

	return String(teamNumber) === value ? teamNumber : undefined;
}

export default app;
