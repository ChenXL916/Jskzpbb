import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQuickTunnelOrigin } from './makeup-gateway-service.mjs';

test('extracts only the quick tunnel URL from cloudflared output', () => {
  assert.equal(
    extractQuickTunnelOrigin('INF Your quick Tunnel has been created! Visit https://makeup-test.trycloudflare.com'),
    'https://makeup-test.trycloudflare.com'
  );
  assert.equal(extractQuickTunnelOrigin('no tunnel yet'), null);
});
