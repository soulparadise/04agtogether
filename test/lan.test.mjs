import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLanAddress, isPrivateIPv4 } from '../scripts/lan.mjs';
import { createNetworkShaper } from '../scripts/network-shaper.mjs';
import { developmentSocketOptions, developmentSearch } from '../frontend/src/player/dev-network.mjs';

test('LAN selects a private interface without changing the loopback dev default', () => {
  const interfaces = {
    Meta: [{ address: '198.18.0.1', family: 'IPv4', internal: false }],
    'Ethernet 2': [{ address: '192.168.248.193', family: 'IPv4', internal: false }],
    Ethernet: [{ address: '192.168.88.240', family: 'IPv4', internal: false }],
    loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  };
  assert.equal(findLanAddress(interfaces, undefined).address, '192.168.88.240');
  assert.equal(findLanAddress(interfaces, '192.168.248.193').address, '192.168.248.193');
  assert.throws(() => findLanAddress(interfaces, '0.0.0.0'));
  assert.throws(() => findLanAddress(interfaces, '8.8.8.8'));
  assert.equal(isPrivateIPv4('172.16.1.2'), true);
  assert.equal(isPrivateIPv4('172.32.1.2'), false);
  assert.equal(isPrivateIPv4('192.168.1.999'), false);
  assert.throws(() => createNetworkShaper({ target: 'http://example.com' }));
});

test('LAN HTTP profiles work without secure-context randomUUID; navigation preserves only dev options', () => {
  const cryptoSource = { getRandomValues: values => values.fill(123) };
  assert.equal(developmentSocketOptions('?network=300', cryptoSource).query.testNetwork, '300');
  assert.deepEqual(developmentSocketOptions('?network=bad', cryptoSource), {});
  assert.equal(developmentSearch('?diagnostics=1&network=100&ownerToken=not-a-real-token'), '?diagnostics=1&network=100');
});
