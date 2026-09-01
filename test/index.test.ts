import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Bindings } from '../src/avatar.service';
import worker from '../src/index';
import { network } from './network';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

beforeEach(async () => {
	const objects = await env.AVATARS.list();
	await Promise.all(objects.objects.map((object) => env.AVATARS.delete(object.key)));
});

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
		expect(document.openapi).toBe('3.0.0');
		expect(Object.keys(document.paths)).toEqual(['/', '/health', '/teams/{filename}']);
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
		expect(new Uint8Array(await first.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		const stored = await env.AVATARS.get('avatars/581.png');
		expect(stored).not.toBeNull();
		await stored?.arrayBuffer();

		const second = await requestAvatar(581);
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

async function requestAvatar(teamNumber: number): Promise<Response> {
	return worker.fetch(
		new Request(`https://avatars.frc.sh/teams/${teamNumber}.png`),
		env as Bindings,
		createExecutionContext(),
	);
}
