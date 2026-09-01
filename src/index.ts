import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { getAvatar, type Bindings } from './avatar.service';

const JSON_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';
const TEAM_FILENAME_PATTERN = /^(?:[1-9]\d{0,3}|[1-4]\d{4}|50000)\.png$/;
const YEAR_PATTERN = /^\d{4}$/;

const errorSchema = z.object({ error: z.string() }).openapi('Error');
const serviceSchema = z
	.object({
		name: z.string(),
		imageUrlTemplate: z.url(),
		historicalImageUrlTemplate: z.url(),
		source: z.string(),
	})
	.openapi('Service');
const healthSchema = z.object({ status: z.literal('ok') }).openapi('Health');
const teamParamsSchema = z.object({
	filename: z
		.string()
		.regex(TEAM_FILENAME_PATTERN)
		.openapi({
			param: { name: 'filename', in: 'path' },
			example: '581.png',
		}),
});
const historicalTeamParamsSchema = z.object({
	year: z
		.string()
		.regex(YEAR_PATTERN)
		.openapi({
			param: { name: 'year', in: 'path' },
			example: '2024',
			description: 'An FRC season from 1992 through the current year',
		}),
	filename: z
		.string()
		.regex(TEAM_FILENAME_PATTERN)
		.openapi({
			param: { name: 'filename', in: 'path' },
			example: '581.png',
		}),
});

const avatarResponses = {
	200: {
		content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } },
		description: 'The team avatar',
	},
	304: { description: 'The cached avatar is still current' },
	400: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'Invalid team number or year',
	},
	404: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'No avatar is available for the team',
	},
	500: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'The avatar could not be loaded',
	},
	502: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'The avatar source is temporarily unavailable',
	},
} as const;

const rootRoute = createRoute({
	method: 'get',
	path: '/',
	responses: {
		200: {
			content: { 'application/json': { schema: serviceSchema } },
			description: 'Service information',
		},
	},
});

const healthRoute = createRoute({
	method: 'get',
	path: '/health',
	responses: {
		200: {
			content: { 'application/json': { schema: healthSchema } },
			description: 'Service health',
		},
	},
});

const currentAvatarRoute = createRoute({
	method: 'get',
	path: '/teams/{filename}',
	request: { params: teamParamsSchema },
	responses: avatarResponses,
});

const historicalAvatarRoute = createRoute({
	method: 'get',
	path: '/teams/{year}/{filename}',
	request: { params: historicalTeamParamsSchema },
	responses: avatarResponses,
});

const app = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook(result, context) {
		if (!result.success) {
			context.header('Cache-Control', JSON_CACHE_CONTROL);
			return context.json({ error: 'Invalid team number.' }, 400);
		}
	},
});

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

app.openapi(rootRoute, (context) => {
	context.header('Cache-Control', JSON_CACHE_CONTROL);
	return context.json(
		{
			name: 'avatars.frc.sh',
			imageUrlTemplate: `${new URL(context.req.url).origin}/teams/{teamNumber}.png`,
			historicalImageUrlTemplate: `${new URL(context.req.url).origin}/teams/{year}/{teamNumber}.png`,
			source: 'The Blue Alliance',
		},
		200,
	);
});

app.openapi(healthRoute, (context) => {
	context.header('Cache-Control', 'no-store');
	return context.json({ status: 'ok' }, 200);
});

app.openapi(currentAvatarRoute, async (context) => {
	const filename = context.req.valid('param').filename;
	const teamNumber = Number(filename.slice(0, -'.png'.length));
	return getAvatar(context.req.raw, context.env, teamNumber);
});

app.openapi(
	historicalAvatarRoute,
	async (context) => {
		const { filename, year: yearParam } = context.req.valid('param');
		const teamNumber = Number(filename.slice(0, -'.png'.length));
		const year = Number(yearParam);
		const currentYear = new Date().getUTCFullYear();

		if (year < 1992 || year > currentYear) {
			context.header('Cache-Control', JSON_CACHE_CONTROL);
			return context.json({ error: 'Invalid year.' }, 400);
		}

		return getAvatar(context.req.raw, context.env, teamNumber, year);
	},
	(result, context) => {
		if (!result.success) {
			context.header('Cache-Control', JSON_CACHE_CONTROL);
			return context.json({ error: 'Invalid team number or year.' }, 400);
		}
	},
);

app.use('/openapi.json', async (context, next) => {
	await next();
	context.header('Cache-Control', JSON_CACHE_CONTROL);
});

app.doc31('/openapi.json', (context) => ({
	openapi: '3.1.0',
	info: {
		title: 'avatars.frc.sh',
		version: context.env.CF_VERSION_METADATA.id,
		description: 'FIRST Robotics Competition team avatars sourced from The Blue Alliance.',
	},
	servers: [{ url: 'https://avatars.frc.sh' }],
}));

app.notFound((context) => {
	context.header('Cache-Control', JSON_CACHE_CONTROL);
	return context.json({ error: 'Not found.' }, 404);
});

app.onError((error, context) => {
	console.error('Unhandled request error', error);
	context.header('Cache-Control', 'no-store');
	return context.json({ error: 'Internal server error.' }, 500);
});

export default app;
