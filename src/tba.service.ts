import {
	HttpError,
	pipeline,
	withBaseUrl,
	withHeaders,
	withHttpError,
	withJsonResponse,
	withTimeout,
} from 'fetch-extras';

const TBA_API_URL = 'https://www.thebluealliance.com/api/v3';
const TBA_TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 1024 * 1024;

type TbaMedia = {
	type?: unknown;
	details?: {
		base64Image?: unknown;
	};
};

export class UpstreamError extends Error {}

export async function fetchLatestAvatar(
	teamNumber: number,
	authKey: string,
	currentYear: number,
): Promise<{ bytes: Uint8Array; year: number } | undefined> {
	const tbaFetch = pipeline(
		fetch,
		withTimeout(TBA_TIMEOUT_MS),
		withBaseUrl(TBA_API_URL),
		withHeaders({ 'X-TBA-Auth-Key': authKey }),
		withHttpError(),
		withJsonResponse(),
	);

	for (const year of [currentYear, currentYear - 1]) {
		let body: unknown;
		try {
			body = await tbaFetch(`team/frc${teamNumber}/media/${year}`);
		} catch (error) {
			if (error instanceof HttpError && error.response.status === 404) {
				continue;
			}

			if (error instanceof HttpError) {
				throw new UpstreamError(`TBA returned ${error.response.status}.`, { cause: error });
			}

			throw error;
		}

		if (!Array.isArray(body)) {
			throw new UpstreamError('TBA returned an invalid media response.');
		}

		const avatar = body.find(
			(media): media is TbaMedia =>
				typeof media === 'object' && media !== null && (media as TbaMedia).type === 'avatar',
		);
		const encoded = avatar?.details?.base64Image;

		if (typeof encoded === 'string') {
			return { bytes: decodePng(encoded), year };
		}
	}

	return undefined;
}

function decodePng(encoded: string): Uint8Array {
	if (encoded.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4) {
		throw new UpstreamError('TBA avatar exceeds the size limit.');
	}

	let decoded: string;
	try {
		decoded = atob(encoded);
	} catch {
		throw new UpstreamError('TBA avatar is not valid base64.');
	}

	if (decoded.length > MAX_AVATAR_BYTES) {
		throw new UpstreamError('TBA avatar exceeds the size limit.');
	}

	const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

	if (!pngSignature.every((value, index) => bytes[index] === value)) {
		throw new UpstreamError('TBA avatar is not a PNG.');
	}

	return bytes;
}
