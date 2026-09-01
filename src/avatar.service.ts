import { fetchAvatar as fetchAvatarForYear, fetchCurrentAvatar, UpstreamError } from './tba.service';

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

export type Bindings = Env & {
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
		const fetched =
			year === undefined
				? await fetchCurrentAvatar(teamNumber, env.TBA_AUTH_KEY, currentYear)
				: await fetchAvatarForYear(teamNumber, env.TBA_AUTH_KEY, year);

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
