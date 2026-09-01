import { captureException } from '@sentry/cloudflare';
import { fetchAvatar as fetchAvatarForYear, InvalidAvatarError, UpstreamError } from './tba.service';

const CURRENT_AVATAR_REFRESH_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_AVATAR_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const CURRENT_MISSING_REFRESH_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_MISSING_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

const CURRENT_AVATAR_CACHE_CONTROL =
	'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800';
const HISTORICAL_AVATAR_CACHE_CONTROL =
	'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800, stale-if-error=31536000';
const CURRENT_MISSING_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400';
const HISTORICAL_MISSING_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';
const MAX_AVATAR_BYTES = 1024 * 1024;

export type Bindings = Env & {
	SENTRY_DSN: string;
	TBA_AUTH_KEY: string;
};

type AvatarMetadata = {
	sourceYear: string;
};

export async function getAvatar(request: Request, env: Bindings, teamNumber: number, year?: number): Promise<Response> {
	const keySuffix = year === undefined ? String(teamNumber) : `${year}/${teamNumber}`;
	const avatarKey = `avatars/${keySuffix}.png`;
	const missingKey = `missing/${keySuffix}`;
	const now = Date.now();
	const currentYear = new Date(now).getUTCFullYear();
	const isHistorical = year !== undefined && year < currentYear;
	const avatarRefreshMs = isHistorical ? HISTORICAL_AVATAR_REFRESH_MS : CURRENT_AVATAR_REFRESH_MS;
	const missingRefreshMs = isHistorical ? HISTORICAL_MISSING_REFRESH_MS : CURRENT_MISSING_REFRESH_MS;
	const avatarCacheControl = isHistorical ? HISTORICAL_AVATAR_CACHE_CONTROL : CURRENT_AVATAR_CACHE_CONTROL;
	const missingCacheControl = isHistorical ? HISTORICAL_MISSING_CACHE_CONTROL : CURRENT_MISSING_CACHE_CONTROL;
	const storedAvatar = await env.AVATARS.get(avatarKey);

	if (storedAvatar && isFresh(storedAvatar, avatarRefreshMs, now)) {
		return avatarResponse(request, storedAvatar, avatarCacheControl);
	}

	if (!storedAvatar) {
		const missing = await env.AVATARS.head(missingKey);

		if (missing && isFresh(missing, missingRefreshMs, now)) {
			return missingResponse(teamNumber, missingCacheControl, year);
		}
	}

	try {
		const fetched = await fetchNormalizedAvatar(env, teamNumber, currentYear, year);

		if (!fetched) {
			await Promise.all([env.AVATARS.delete(avatarKey), env.AVATARS.put(missingKey, '')]);
			return missingResponse(teamNumber, missingCacheControl, year);
		}

		const stored = await env.AVATARS.put(avatarKey, fetched.bytes, {
			httpMetadata: {
				contentType: 'image/png',
				cacheControl: avatarCacheControl,
			},
			customMetadata: {
				sourceYear: String(fetched.year),
			} satisfies AvatarMetadata,
		});
		await env.AVATARS.delete(missingKey);

		return bytesResponse(request, fetched.bytes, stored, fetched.year, avatarCacheControl);
	} catch (error) {
		console.error('Failed to refresh avatar', { teamNumber, year, error });
		captureException(error, { extra: { teamNumber, year } });

		if (storedAvatar) {
			return avatarResponse(request, storedAvatar, avatarCacheControl);
		}

		if (error instanceof UpstreamError) {
			return Response.json(
				{ error: 'The avatar source is temporarily unavailable.' },
				{ status: 502, headers: { 'Cache-Control': 'no-store' } },
			);
		}

		return Response.json(
			{ error: 'Unable to load avatar.' },
			{ status: 500, headers: { 'Cache-Control': 'no-store' } },
		);
	}
}

async function fetchNormalizedAvatar(
	env: Bindings,
	teamNumber: number,
	currentYear: number,
	requestedYear?: number,
): Promise<{ bytes: Uint8Array; year: number } | undefined> {
	const years = requestedYear === undefined ? [currentYear, currentYear - 1] : [requestedYear];
	const invalidAvatars: { error: InvalidAvatarError; year: number }[] = [];

	for (const year of years) {
		try {
			const fetched = await fetchAvatarForYear(teamNumber, env.TBA_AUTH_KEY, year);

			if (!fetched) {
				continue;
			}

			const bytes = await normalizePng(fetched.bytes, env.IMAGES);
			for (const invalid of invalidAvatars) {
				reportInvalidAvatar(invalid.error, teamNumber, invalid.year);
			}
			return { bytes, year: fetched.year };
		} catch (error) {
			if (requestedYear === undefined && error instanceof InvalidAvatarError) {
				invalidAvatars.push({ error, year });
				continue;
			}

			throw error;
		}
	}

	if (invalidAvatars.length > 0) {
		for (const invalid of invalidAvatars.slice(0, -1)) {
			reportInvalidAvatar(invalid.error, teamNumber, invalid.year);
		}
		throw invalidAvatars.at(-1)!.error;
	}

	return undefined;
}

async function normalizePng(bytes: Uint8Array, images: ImagesBinding): Promise<Uint8Array> {
	try {
		const info = await images.info(bytesToStream(bytes));

		if (info.format === 'image/png') {
			return bytes;
		}

		const transformed = await images.input(bytesToStream(bytes)).output({ format: 'image/png' });
		const normalized = new Uint8Array(await transformed.response().arrayBuffer());

		if (normalized.byteLength > MAX_AVATAR_BYTES) {
			throw new InvalidAvatarError('Normalized TBA avatar exceeds the size limit.');
		}

		return normalized;
	} catch (error) {
		if (error instanceof InvalidAvatarError) {
			throw error;
		}

		throw new InvalidAvatarError('TBA avatar could not be converted to PNG.', { cause: error });
	}
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Response(bytes).body!;
}

function reportInvalidAvatar(error: InvalidAvatarError, teamNumber: number, year: number): void {
	console.error('Skipped invalid TBA avatar', { teamNumber, year, error });
	captureException(error, { extra: { teamNumber, year } });
}

function isFresh(object: Pick<R2Object, 'uploaded'>, ttl: number, now: number): boolean {
	const uploadedAt = object.uploaded.getTime();
	return uploadedAt <= now && now - uploadedAt < ttl;
}

function avatarResponse(request: Request, avatar: R2ObjectBody, cacheControl: string): Response {
	if (request.method === 'HEAD' || request.headers.get('If-None-Match') === avatar.httpEtag) {
		void avatar.body.cancel();
	}

	const sourceYear = Number(avatar.customMetadata?.sourceYear);
	return bytesResponse(request, avatar.body, avatar, sourceYear, cacheControl);
}

function bytesResponse(
	request: Request,
	body: BodyInit,
	object: Pick<R2Object, 'httpEtag' | 'uploaded' | 'size'>,
	sourceYear: number,
	cacheControl: string,
): Response {
	if (request.headers.get('If-None-Match') === object.httpEtag) {
		return new Response(null, {
			status: 304,
			headers: imageHeaders(object, sourceYear, cacheControl),
		});
	}

	return new Response(request.method === 'HEAD' ? null : body, {
		headers: imageHeaders(object, sourceYear, cacheControl),
	});
}

function imageHeaders(
	object: Pick<R2Object, 'httpEtag' | 'uploaded' | 'size'>,
	sourceYear: number,
	cacheControl: string,
): HeadersInit {
	return {
		'Cache-Control': cacheControl,
		'Content-Length': String(object.size),
		'Content-Type': 'image/png',
		ETag: object.httpEtag,
		'Last-Modified': object.uploaded.toUTCString(),
		'X-Avatar-Year': String(sourceYear),
	};
}

function missingResponse(teamNumber: number, cacheControl: string, year?: number): Response {
	const yearDescription = year === undefined ? '' : ` in ${year}`;
	return Response.json(
		{ error: `No avatar is available for team ${teamNumber}${yearDescription}.` },
		{ status: 404, headers: { 'Cache-Control': cacheControl } },
	);
}
