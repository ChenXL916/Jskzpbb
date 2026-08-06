const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/ChenXL916/Jskzpbb/makeup-runtime/runtime/backend-origin.json';
const QUICK_TUNNEL_SUFFIX = '.trycloudflare.com';
const REGISTRY_TIMEOUT_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 65_000;
const CACHE_TTL_MS = 15_000;

let cachedOrigin = null;

function parseOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith(QUICK_TUNNEL_SUFFIX) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) {
      return null;
    }
    url.pathname = '/';
    return url;
  } catch {
    return null;
  }
}

async function resolveOrigin(env) {
  const configured = parseOrigin(env.BACKEND_ORIGIN);
  const registryValue =
    env.BACKEND_ORIGIN_REGISTRY_URL === undefined
      ? DEFAULT_REGISTRY_URL
      : env.BACKEND_ORIGIN_REGISTRY_URL;
  if (!registryValue) return configured;

  let registryUrl;
  try {
    registryUrl = new URL(registryValue);
    if (registryUrl.protocol !== 'https:') return configured;
  } catch {
    return configured;
  }

  const now = Date.now();
  if (cachedOrigin?.registry === registryUrl.href && cachedOrigin.expiresAt > now) {
    return new URL(cachedOrigin.origin);
  }

  try {
    const response = await fetch(registryUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    });
    if (!response.ok) return configured;
    const payload = await response.json();
    const runtime = parseOrigin(payload?.origin);
    if (!runtime) return configured;
    cachedOrigin = {
      registry: registryUrl.href,
      origin: runtime.href,
      expiresAt: now + CACHE_TTL_MS
    };
    return runtime;
  } catch {
    return configured;
  }
}

function unavailable() {
  return new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>服务连接中</title><style>body{margin:0;font-family:system-ui,"Microsoft YaHei";background:#f5f2eb;color:#17231f;display:grid;place-items:center;min-height:100vh}.card{max-width:520px;margin:24px;padding:32px;border:1px solid #ddd8cd;border-radius:16px;background:#fff}h1{font-size:26px}p{color:#65706b;line-height:1.7}</style><section class="card"><h1>排班与妆造协同系统暂时无法连接</h1><p>本机业务服务正在恢复，系统不会显示旧数据或模拟数据。请稍后刷新页面。</p></section></html>',
    {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    }
  );
}

export function createGatewayHandler(fallback) {
  return {
    async fetch(request, env = {}, ctx) {
      const origin = await resolveOrigin(env);
      if (!origin) return unavailable();

      const source = new URL(request.url);
      const upstream = new URL(`${source.pathname}${source.search}`, origin);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('oai-sites-authorization');
      headers.set('x-forwarded-host', source.host);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-jishi-gateway', 'sites');

      const init = {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      };
      if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;

      try {
        const response = await fetch(upstream, init);
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('cache-control', 'no-store');
        responseHeaders.set('x-jishi-gateway', 'sites');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch {
        if (fallback && source.pathname === '/__sites-fallback') {
          return fallback.fetch(request, env, ctx);
        }
        return unavailable();
      }
    }
  };
}

export const gatewayInternals = {
  DEFAULT_REGISTRY_URL,
  parseOrigin,
  resetCache() {
    cachedOrigin = null;
  }
};
