# avatars.frc.sh

A small public API for FRC team avatars published by [The Blue Alliance](https://www.thebluealliance.com/). Avatars are fetched on demand, persisted in Cloudflare R2, and served through Cloudflare Workers Cache.

## API

```http
GET https://avatars.frc.sh/teams/581.png
```

The endpoint returns the team's current avatar, checking the current FRC year and then the previous year. It does not search further back and returns `404` when neither season has an avatar.

Request a specific FRC season by adding the year:

```http
GET https://avatars.frc.sh/teams/2024/581.png
```

The historical endpoint checks only the requested season. Years from 1992 through the current year are accepted.

Successful responses include an `X-Avatar-Year` header with the source year. See [Cache behavior](#cache-behavior) for refresh and negative-cache timing.

The OpenAPI 3.1.0 document is available at [`/openapi.json`](https://avatars.frc.sh/openapi.json).

## Development

Requires Node.js 24 and pnpm 12.

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Set `TBA_AUTH_KEY` in `.dev.vars` to a [The Blue Alliance API key](https://www.thebluealliance.com/account).

Run the complete local check with:

```sh
pnpm check
```

## Deploying

Create the production R2 bucket once:

```sh
pnpm exec wrangler r2 bucket create frc-avatars
```

Configure the production secret:

```sh
pnpm exec wrangler secret put TBA_AUTH_KEY
```

Then deploy the Worker and its `avatars.frc.sh` custom domain:

```sh
pnpm deploy
```

The custom domain must not already have a conflicting DNS record. Wrangler creates the required DNS record and certificate during deployment.

## Cache behavior

| Cached result     | Example R2 key         | Browser TTL | Cloudflare TTL / TBA recheck | Stale while refreshing | Stale if TBA fails |
| ----------------- | ---------------------- | ----------- | ---------------------------- | ---------------------- | ------------------ |
| Current avatar    | `avatars/581.png`      | 1 hour      | 1 day                        | 1 day                  | 7 days             |
| Historical avatar | `avatars/2024/581.png` | 1 day       | 30 days                      | 7 days                 | 1 year             |
| Current `404`     | `missing/581`          | 5 minutes   | 6 hours                      | 1 hour                 | —                  |
| Historical `404`  | `missing/2024/581`     | 1 hour      | 7 days                       | 1 day                  | —                  |

The browser TTL is the response's `max-age`. Cloudflare uses `s-maxage`; after that same freshness window, the Worker checks the R2 object's age and revalidates it with TBA. R2 objects and missing markers are retained until they are refreshed or replaced rather than expiring automatically.

There is intentionally no daily bulk job. A bulk refresh would issue thousands of mostly unnecessary TBA requests. Instead:

1. The first request for a team fetches its avatar from TBA and stores it in R2.
2. Workers Cache serves subsequent requests without running the Worker.
3. After the applicable freshness window, Cloudflare can serve the stale response while the Worker refreshes it in the background.
4. Missing avatars use a short negative-cache marker in R2 so repeated requests do not hit TBA.

Current and year-specific avatars use separate R2 keys and negative-cache markers. Requesting a historical avatar never changes the default current avatar.

Workers Cache is enabled in `wrangler.jsonc` and caches responses before the Worker executes. Hono's cache middleware is intentionally not used because it relies on the lower-level, data-center-local Cache API and would duplicate this cache layer.
