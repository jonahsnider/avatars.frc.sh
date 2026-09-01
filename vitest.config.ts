import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: { TBA_AUTH_KEY: 'test-key' },
			},
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
	},
});
