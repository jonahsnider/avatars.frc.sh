import {
	HttpError,
	SchemaValidationError,
	pipeline,
	withBaseUrl,
	withHeaders,
	withHttpError,
	withJsonResponse,
	withTimeout,
} from 'fetch-extras';
import * as z from 'zod/mini';

const TBA_API_URL = 'https://www.thebluealliance.com/api/v3';
const TBA_TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 1024 * 1024;

const tbaMediaSchema = z.array(
	z.object({
		type: z.string(),
		details: z.object({
			base64Image: z.optional(z.string()),
		}),
	}),
);

export class UpstreamError extends Error {
	override name = 'UpstreamError';
}
export class InvalidAvatarError extends UpstreamError {
	override name = 'InvalidAvatarError';
}

export async function fetchAvatar(
	teamNumber: number,
	authKey: string,
	year: number,
): Promise<{ bytes: Uint8Array; year: number } | undefined> {
	const tbaFetch = pipeline(
		fetch,
		withTimeout(TBA_TIMEOUT_MS),
		withBaseUrl(TBA_API_URL),
		withHeaders({ 'X-TBA-Auth-Key': authKey }),
		withHttpError(),
		withJsonResponse({ schema: tbaMediaSchema }),
	);

	let body: z.infer<typeof tbaMediaSchema>;
	try {
		body = await tbaFetch(`team/frc${teamNumber}/media/${year}`);
	} catch (error) {
		if (error instanceof HttpError && error.response.status === 404) {
			return undefined;
		}

		if (error instanceof HttpError) {
			throw new UpstreamError(`TBA returned ${error.response.status}.`, { cause: error });
		}

		if (error instanceof SchemaValidationError || error instanceof SyntaxError) {
			throw new UpstreamError('TBA returned an invalid media response.', { cause: error });
		}

		throw error;
	}

	const avatar = body.find((media) => media.type === 'avatar');
	const encoded = avatar?.details?.base64Image;
	return encoded === undefined ? undefined : { bytes: decodeAvatar(encoded), year };
}

function decodeAvatar(encoded: string): Uint8Array {
	if (encoded.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4) {
		throw new InvalidAvatarError('TBA avatar exceeds the size limit.');
	}

	let decoded: string;
	try {
		decoded = atob(encoded);
	} catch {
		throw new InvalidAvatarError('TBA avatar is not valid base64.');
	}

	if (decoded.length > MAX_AVATAR_BYTES) {
		throw new InvalidAvatarError('TBA avatar exceeds the size limit.');
	}

	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
