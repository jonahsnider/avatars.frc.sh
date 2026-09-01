import { fetchLatestAvatar, UpstreamError } from './tba.service';

const AVATAR_REFRESH_MS = 24 * 60 * 60 * 1000;
const MISSING_REFRESH_MS = 6 * 60 * 60 * 1000;

const AVATAR_CACHE_CONTROL =
	'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800';
const STALE_AVATAR_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-if-error=604800';
const MISSING_CACHE_CONTROL = 'public, max-age=300, s-maxage=21600, stale-while-revalidate=3600';

export type Bindings = Env & {
	TBA_AUTH_KEY: string;
};

type AvatarMetadata = {
	sourceYear: string;
};

export async function getAvatar(request: Request, env: Bindings, teamNumber: number): Promise<Response> {
	const avatarKey = `avatars/${teamNumber}.png`;
	const missingKey = `missing/${teamNumber}`;
	const now = Date.now();
	const storedAvatar = await env.AVATARS.get(avatarKey);

	if (storedAvatar && isFresh(storedAvatar, AVATAR_REFRESH_MS, now)) {
		return avatarResponse(request, storedAvatar, AVATAR_CACHE_CONTROL);
	}

	if (!storedAvatar) {
		const missing = await env.AVATARS.head(missingKey);

		if (missing && isFresh(missing, MISSING_REFRESH_MS, now)) {
			return missingResponse(teamNumber);
		}
	}

	try {
		const fetched = await fetchLatestAvatar(teamNumber, env.TBA_AUTH_KEY, new Date(now).getUTCFullYear());

		if (!fetched) {
			await Promise.all([env.AVATARS.delete(avatarKey), env.AVATARS.put(missingKey, '')]);
			return missingResponse(teamNumber);
		}

		const stored = await env.AVATARS.put(avatarKey, fetched.bytes, {
			httpMetadata: {
				contentType: 'image/png',
				cacheControl: AVATAR_CACHE_CONTROL,
			},
			customMetadata: {
				sourceYear: String(fetched.year),
			} satisfies AvatarMetadata,
		});
		await env.AVATARS.delete(missingKey);

		return bytesResponse(request, fetched.bytes, stored, fetched.year, AVATAR_CACHE_CONTROL);
	} catch (error) {
		console.error('Failed to refresh avatar', { teamNumber, error });

		if (storedAvatar) {
			return avatarResponse(request, storedAvatar, STALE_AVATAR_CACHE_CONTROL);
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

function missingResponse(teamNumber: number): Response {
	return Response.json(
		{ error: `No avatar is available for team ${teamNumber}.` },
		{ status: 404, headers: { 'Cache-Control': MISSING_CACHE_CONTROL } },
	);
}
