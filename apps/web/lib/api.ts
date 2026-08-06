function resolveApiUrl(): string {
  const configuredApiUrl =
    process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002/api';
  if (typeof window === 'undefined') {
    return configuredApiUrl;
  }

  if (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  ) {
    return `${window.location.protocol}//${window.location.hostname}:3002/api`;
  }

  // Public deployments use the Next.js same-origin gateway. This prevents a
  // production browser from trying to call the deployer's localhost API when
  // the original local build-time value is still present.
  try {
    const configured = new URL(configuredApiUrl, window.location.origin);
    if (
      configured.hostname === 'localhost' ||
      configured.hostname === '127.0.0.1'
    ) {
      return '/api';
    }
  } catch {
    return configuredApiUrl.startsWith('/') ? configuredApiUrl : '/api';
  }

  return configuredApiUrl;
}

export const API_URL = resolveApiUrl();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !isFormData ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    },
    cache: 'no-store'
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string | string[]; code?: string }
      | null;
    const message = Array.isArray(body?.message)
      ? body.message.join('；')
      : body?.message ?? `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, body?.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function formatTime(value: string | Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
