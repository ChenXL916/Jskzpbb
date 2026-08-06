import vinext from 'vinext';
import { defineConfig } from 'vite';
import { sites } from './build/sites-vite-plugin';

const localBindingConfig = {
  main: './worker/index.ts',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    binding: 'ASSETS',
    directory: './public',
    not_found_handling: 'single-page-application' as const,
    run_worker_first: true
  },
  vars: {
    BACKEND_ORIGIN: process.env.SITES_BACKEND_ORIGIN ?? '',
    BACKEND_ORIGIN_REGISTRY_URL: process.env.SITES_BACKEND_ORIGIN_REGISTRY_URL ?? ''
  }
};

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig
      })
    ]
  };
});
