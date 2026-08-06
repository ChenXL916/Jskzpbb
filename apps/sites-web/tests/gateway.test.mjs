import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayInternals } from '../worker/gateway.mjs';

test('accepts only HTTPS Cloudflare quick tunnel origins', () => {
  assert.equal(
    gatewayInternals.parseOrigin('https://makeup-example.trycloudflare.com').href,
    'https://makeup-example.trycloudflare.com/'
  );
  assert.equal(gatewayInternals.parseOrigin('http://makeup-example.trycloudflare.com'), null);
  assert.equal(gatewayInternals.parseOrigin('https://example.com'), null);
  assert.equal(gatewayInternals.parseOrigin('https://evil.trycloudflare.com/path'), null);
});

test('uses a runtime registry isolated from the live dashboard repository', () => {
  assert.equal(
    gatewayInternals.DEFAULT_REGISTRY_URL,
    'https://raw.githubusercontent.com/ChenXL916/Jskzpbb/makeup-runtime/runtime/backend-origin.json'
  );
});
