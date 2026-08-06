import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES
} from 'vinext/server/image-optimization';
import handler from 'vinext/server/app-router-entry';
import { createGatewayHandler } from './gateway.mjs';

interface Fetcher {
  fetch(input: Request | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  BACKEND_ORIGIN?: string;
  BACKEND_ORIGIN_REGISTRY_URL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const fallback = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/_vinext/image') {
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          }
        },
        [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES]
      );
    }
    return handler.fetch(request, env, ctx);
  }
};

export default createGatewayHandler(fallback);
