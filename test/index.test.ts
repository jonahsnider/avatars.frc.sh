import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Bindings } from '../src/avatar.service';
import worker from '../src/index';
import { network } from './network';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const JPEG_BASE64 =
	'/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=';

beforeEach(async () => {
	const objects = await env.AVATARS.list();
	await Promise.all(objects.objects.map((object) => env.AVATARS.delete(object.key)));
});

afterEach(() => vi.restoreAllMocks());

describe('routing', () => {
	it.each(['0', '0501', '50001', 'not-a-team'])('rejects invalid team number %s', async (teamNumber) => {
		const response = await worker.fetch(
			new Request(`https://avatars.frc.sh/teams/${teamNumber}.png`),
			env as Bindings,
			createExecutionContext(),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid team number.' });
	});

	it.each(['1991', String(new Date().getUTCFullYear() + 1), 'not-a-year'])(
		'rejects invalid avatar year %s',
		async (year) => {
			const response = await worker.fetch(
				new Request(`https://avatars.frc.sh/teams/${year}/581.png`),
				env as Bindings,
				createExecutionContext(),
			);

			expect(response.status).toBe(400);
		},
	);

	it('serves an OpenAPI document for the public routes', async () => {
		const response = await worker.fetch(
			new Request('https://avatars.frc.sh/openapi.json'),
			env as Bindings,
			createExecutionContext(),
		);
		const document = (await response.json()) as {
			openapi: string;
			paths: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		expect(document.openapi).toBe('3.1.0');
		expect(Object.keys(document.paths)).toEqual(['/', '/health', '/teams/{filename}', '/teams/{year}/{filename}']);
		expect(document.paths['/teams/{filename}']).toMatchObject({
			get: {
				parameters: [{ in: 'path', name: 'filename', required: true }],
				responses: {
					200: {
						content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
					},
				},
			},
		});
		expect(document.paths['/teams/{year}/{filename}']).toMatchObject({
			get: {
				parameters: [
					{ in: 'path', name: 'year', required: true },
					{ in: 'path', name: 'filename', required: true },
				],
			},
		});
	});
});

describe('avatar endpoint', () => {
	it('fetches an avatar from TBA and persists it in R2', async () => {
		let requests = 0;
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc581/media/:year', ({ request }) => {
				requests += 1;
				expect(request.headers.get('X-TBA-Auth-Key')).toBe('test-key');
				return HttpResponse.json([{ type: 'avatar', details: { base64Image: PNG_BASE64 } }]);
			}),
		);

		const first = await requestAvatar(581);
		expect(first.status).toBe(200);
		expect(first.headers.get('Content-Type')).toBe('image/png');
		expect(first.headers.get('Cache-Control')?.split(', ')).toEqual(
			expect.arrayContaining(['max-age=86400', 's-maxage=86400']),
		);
		expect(new Uint8Array(await first.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		const stored = await env.AVATARS.get('avatars/581.png');
		expect(stored).not.toBeNull();
		await stored?.arrayBuffer();

		const second = await requestAvatar(581);
		expect(second.status).toBe(200);
		await second.arrayBuffer();
		expect(requests).toBe(1);
	});

	it('normalizes a JPEG avatar from TBA to PNG', async () => {
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc7431/media/:year', () =>
				HttpResponse.json([{ type: 'avatar', details: { base64Image: JPEG_BASE64 } }]),
			),
		);

		const response = await requestAvatar(7431);
		const bytes = new Uint8Array(await response.arrayBuffer());

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(bytes.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

		const stored = await env.AVATARS.get('avatars/7431.png');
		expect(new Uint8Array(await stored!.arrayBuffer()).slice(0, 8)).toEqual(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	});

	it('falls back to the previous year when the current avatar is invalid', async () => {
		const currentYear = new Date().getUTCFullYear();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc7431/media/:year', ({ params }) =>
				HttpResponse.json([
					{
						type: 'avatar',
						details: { base64Image: params.year === String(currentYear) ? 'not base64' : PNG_BASE64 },
					},
				]),
			),
		);

		const response = await requestAvatar(7431);

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Avatar-Year')).toBe(String(currentYear - 1));
		expect(consoleError).toHaveBeenCalledWith(
			'Skipped invalid TBA avatar',
			expect.objectContaining({ teamNumber: 7431, year: currentYear }),
		);
	});

	it('does not fall back when an explicit year has an invalid avatar', async () => {
		let requests = 0;
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc7431/media/:year', () => {
				requests += 1;
				return HttpResponse.json([{ type: 'avatar', details: { base64Image: 'not base64' } }]);
			}),
		);

		const response = await requestAvatar(7431, 2024);

		expect(response.status).toBe(502);
		expect(requests).toBe(1);
	});

	it('fetches and caches an avatar for an explicit year', async () => {
		let requests = 0;
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc581/media/:year', ({ params }) => {
				requests += 1;
				expect(params.year).toBe('2024');
				return HttpResponse.json([{ type: 'avatar', details: { base64Image: PNG_BASE64 } }]);
			}),
		);

		const first = await requestAvatar(581, 2024);
		expect(first.status).toBe(200);
		expect(first.headers.get('X-Avatar-Year')).toBe('2024');
		expect(first.headers.get('Cache-Control')).toContain('s-maxage=2592000');
		await first.arrayBuffer();

		const stored = await env.AVATARS.get('avatars/2024/581.png');
		expect(stored).not.toBeNull();
		await stored?.arrayBuffer();

		const second = await requestAvatar(581, 2024);
		expect(second.status).toBe(200);
		await second.arrayBuffer();
		expect(requests).toBe(1);
	});

	it('negatively caches teams without avatars', async () => {
		let requests = 0;
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc9999/media/:year', () => {
				requests += 1;
				return HttpResponse.json([]);
			}),
		);

		const first = await requestAvatar(9999);
		expect(first.status).toBe(404);
		expect(first.headers.get('Cache-Control')?.split(', ')).toEqual(
			expect.arrayContaining(['max-age=86400', 's-maxage=86400']),
		);
		await first.text();

		const second = await requestAvatar(9999);
		expect(second.status).toBe(404);
		await second.text();
		expect(requests).toBe(2);
		expect(await env.AVATARS.head('missing/9999')).not.toBeNull();
	});

	it('rejects invalid TBA media responses', async () => {
		network.use(
			http.get('https://www.thebluealliance.com/api/v3/team/frc581/media/:year', () =>
				HttpResponse.json([{ type: 'avatar', details: { base64Image: 123 } }]),
			),
		);

		const response = await requestAvatar(581);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'The avatar source is temporarily unavailable.' });
	});

	it('supports conditional requests for stored avatars', async () => {
		const bytes = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));
		const stored = await env.AVATARS.put('avatars/581.png', bytes, {
			customMetadata: {
				sourceYear: '2026',
			},
		});

		const response = await worker.fetch(
			new Request('https://avatars.frc.sh/teams/581.png', {
				headers: { 'If-None-Match': stored.httpEtag },
			}),
			env as Bindings,
			createExecutionContext(),
		);

		expect(response.status).toBe(304);
		expect(await response.text()).toBe('');
	});

	it('derives HEAD responses from the avatar route', async () => {
		const bytes = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));
		await env.AVATARS.put('avatars/581.png', bytes, {
			customMetadata: { sourceYear: '2026' },
		});

		const response = await worker.fetch(
			new Request('https://avatars.frc.sh/teams/581.png', { method: 'HEAD' }),
			env as Bindings,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
		expect(await response.text()).toBe('');
	});
});

async function requestAvatar(teamNumber: number, year?: number): Promise<Response> {
	const path = year === undefined ? `${teamNumber}.png` : `${year}/${teamNumber}.png`;
	return worker.fetch(new Request(`https://avatars.frc.sh/teams/${path}`), env as Bindings, createExecutionContext());
}
