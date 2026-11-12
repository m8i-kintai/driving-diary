import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, isTrustedGasOrigin, validateApiUrl } from '../api.js';

// Every request in these tests goes to this in-memory fetch stub, never Google.
const TEST_URL = 'https://script.google.com/macros/s/TEST_ONLY_NO_NETWORK/exec';
const auth = { accessKey: 'test-only-invite' };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
}
function environment(overrides = {}) {
  let sequence = 0;
  const calls = [];
  const localAccess = [];
  const env = {
    location: new URL('https://example.test/driving/'),
    navigator: { onLine: true }, crypto: { randomUUID: () => `test-request-${++sequence}` },
    sessionStorage: storage(),
    localStorage: { getItem(key) { localAccess.push(['read', key]); throw new Error('Auth must not read localStorage'); }, setItem(key) { localAccess.push(['write', key]); throw new Error('Auth must not write localStorage'); } },
    setTimeout, clearTimeout,
    history: { replaceState(_state, _title, path) { env.location = new URL(path, env.location); } },
    async fetch(url, options) {
      const envelope = JSON.parse(options.body);
      calls.push({ url, options, envelope });
      return { ok: true, async json() { return { ok: true, requestId: envelope.requestId, data: { action: envelope.action } }; } };
    },
    ...overrides,
  };
  return { env, calls, localAccess };
}
function client(env, config = {}) { return createApi({ env, auth, config: { apiUrl: TEST_URL, allowBridge: false, ...config } }); }

test('a matching JSON acknowledgement returns data and preserves mutation request IDs', async () => {
  const { env, calls } = environment();
  const api = client(env);
  const start = { vehicleId: 'sample', employeeId: '1001' };
  const finish = { tripId: 'test-trip', endOdometer: 123 };
  assert.deepEqual(await api.startTrip(start, 'start-stable'), { action: 'startTrip' });
  await api.startTrip(start, 'start-stable');
  await api.finishTrip(finish, 'finish-stable');
  await api.finishTrip(finish, 'finish-stable');
  assert.deepEqual(calls.map(call => call.envelope.requestId), ['start-stable', 'start-stable', 'finish-stable', 'finish-stable']);
  assert.deepEqual(calls[0].envelope.payload, start);
  assert.deepEqual(calls[2].envelope.payload, finish);
  for (const { url, options } of calls) {
    assert.equal(url, TEST_URL);
    assert.equal(options.method, 'POST');
    assert.notEqual(options.mode, 'no-cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

for (const [name, response] of [
  ['another request ID', { ok: true, requestId: 'another-id', data: { saved: true } }],
  ['a missing request ID', { ok: true, data: { saved: true } }],
  ['a truthy string instead of a boolean', { ok: 'true', requestId: 'stable', data: { saved: true } }],
  ['a missing envelope', null],
]) {
  test(`does not report success for ${name}`, async () => {
    const { env } = environment({ fetch: async () => ({ ok: true, json: async () => response }) });
    await assert.rejects(client(env).startTrip({}, 'stable'), { code: 'INVALID_RESPONSE', ambiguous: true });
  });
}

test('a server rejection remains a rejection with its business code', async () => {
  const { env } = environment({ fetch: async () => ({ ok: true, json: async () => ({ ok: false, requestId: 'stable', error: { code: 'VEHICLE_IN_USE', message: '車両は運転中です' } }) }) });
  await assert.rejects(client(env).startTrip({}, 'stable'), { code: 'VEHICLE_IN_USE', message: '車両は運転中です' });
});

test('HTTP errors, unreadable JSON and rejected fetch never become saved acknowledgements', async () => {
  let parsed = false;
  const responses = [
    [async () => ({ ok: false, json: async () => { parsed = true; return { ok: true }; } }), 'NETWORK_ERROR'],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML overload page'); } }), 'INVALID_RESPONSE'],
    [async () => { throw new TypeError('offline'); }, 'NETWORK_ERROR'],
  ];
  for (const [fetch, code] of responses) {
    const { env } = environment({ fetch });
    await assert.rejects(client(env).startTrip({}, 'stable'), { code, ambiguous: true });
  }
  assert.equal(parsed, false, 'an HTTP failure must not parse a misleading success body');
});

test('a timeout rejects without accepting an unknown save outcome', async () => {
  const { env } = environment({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
  await assert.rejects(client(env, { requestTimeoutMs: 5 }).startTrip({}, 'same-id-after-timeout'), { code: 'TIMEOUT', ambiguous: true });
});

test('missing configuration, missing credentials and offline state fail before fetch', async () => {
  const { env, calls } = environment();
  await assert.rejects(createApi({ env, auth, config: {} }).bootstrap(), { code: 'UNCONFIGURED' });
  await assert.rejects(createApi({ env, auth: {}, config: { apiUrl: TEST_URL } }).bootstrap(), { code: 'UNAUTHORIZED' });
  env.navigator.onLine = false;
  await assert.rejects(client(env).bootstrap(), { code: 'NETWORK_ERROR' });
  assert.equal(calls.length, 0);
});

test('launch credentials stay in sessionStorage and are scrubbed from the URL fragment', async () => {
  const { env, calls, localAccess } = environment();
  env.location = new URL('https://example.test/driving/?view=mobile#kinjiroEmployeeId=1001&department=%E5%BB%BA%E8%A8%AD2G&kinjiroToken=test-private-token&invite=test-private-invite');
  const api = createApi({ env, config: { apiUrl: TEST_URL, allowBridge: false } });
  assert.deepEqual(api.launchContext, { employeeId: '1001', department: '建設2G' });
  assert.equal('token' in api.launchContext, false);
  assert.equal('accessKey' in api.launchContext, false);
  assert.ok(!env.location.href.includes('test-private'));
  assert.equal(env.location.search, '?view=mobile');
  const saved = JSON.parse([...env.sessionStorage.values.values()][0]);
  assert.equal(saved.token, 'test-private-token');
  assert.equal(saved.accessKey, 'test-private-invite');
  await api.bootstrap();
  assert.deepEqual(calls[0].envelope.kinjiro, { employeeId: '1001', token: 'test-private-token' });
  assert.equal(calls[0].envelope.accessKey, 'test-private-invite');
  assert.ok(!calls[0].url.includes('test-private'));
  const reopened = createApi({ env, config: { apiUrl: TEST_URL, allowBridge: false } });
  await reopened.bootstrap();
  assert.deepEqual(calls[1].envelope.kinjiro, calls[0].envelope.kinjiro);
  assert.deepEqual(localAccess, [], 'authentication never reads or writes persistent localStorage');
});

test('Google origin and deployment URL allowlists reject lookalikes and non-HTTPS endpoints', () => {
  for (const origin of ['https://script.google.com', 'https://script.googleusercontent.com', 'https://n-abc123-script.googleusercontent.com']) assert.equal(isTrustedGasOrigin(origin), true, origin);
  for (const origin of ['http://script.google.com', 'https://script.google.com.evil.test', 'https://evil.test', 'https://other.googleusercontent.com', 'null']) assert.equal(isTrustedGasOrigin(origin), false, origin);
  assert.equal(validateApiUrl(TEST_URL), TEST_URL);
  for (const value of ['http://script.google.com/macros/s/test/exec', 'https://script.google.com.evil.test/macros/s/test/exec', 'https://evil.test/api', 'javascript:alert(1)']) assert.throws(() => validateApiUrl(value), { code: 'CONFIGURATION_ERROR' });
});

function bridgeEnvironment() {
  const { env, calls } = environment();
  const listeners = new Set();
  const nodes = [];
  let submitted;
  env.addEventListener = (name, handler) => { if (name === 'message') listeners.add(handler); };
  env.removeEventListener = (name, handler) => { if (name === 'message') listeners.delete(handler); };
  env.fetch = async (url, options) => { calls.push({ url, envelope: JSON.parse(options.body), options }); throw new TypeError('CORS response unavailable'); };
  env.document = {
    createElement(tag) {
      const node = { tag, children: [], contentWindow: {}, setAttribute() {}, append(...children) { this.children.push(...children); }, remove() { this.removed = true; } };
      if (tag === 'form') node.submit = () => {
        submitted = Object.fromEntries(node.children.map(input => [input.name, input.value]));
        const envelope = JSON.parse(submitted.payload);
        const frame = nodes.find(item => item.tag === 'iframe');
        const message = { kind: 'DRIVE_LOG_RPC', nonce: submitted.nonce, requestId: envelope.requestId, response: { ok: true, requestId: envelope.requestId, data: { saved: 'verified' } } };
        queueMicrotask(() => {
          for (const spoof of [
            { origin: 'https://evil.test', data: message },
            { origin: 'https://script.google.com', data: { ...message, nonce: 'wrong-nonce' } },
            { origin: 'https://script.google.com', data: { ...message, requestId: 'wrong-request' } },
          ]) for (const listener of listeners) listener({ ...spoof, source: frame.contentWindow });
          for (const listener of listeners) listener({ origin: 'https://n-test-script.googleusercontent.com', data: message, source: frame.contentWindow });
        });
      };
      return node;
    },
    body: { append(...elements) { nodes.push(...elements); } },
  };
  return { env, calls, nodes, listeners, submission: () => submitted };
}

test('CORS fallback reuses the exact mutation ID and payload and accepts only matching bridge acknowledgements', async () => {
  const { env, calls, nodes, listeners, submission } = bridgeEnvironment();
  const payload = { tripId: 'preview-trip', endOdometer: 12450 };
  const result = await client(env, { allowBridge: true }).finishTrip(payload, 'stable-across-transports');
  assert.deepEqual(result, { saved: 'verified' });
  assert.deepEqual(JSON.parse(submission().payload), calls[0].envelope);
  assert.equal(JSON.parse(submission().payload).requestId, 'stable-across-transports');
  assert.equal(nodes.find(node => node.tag === 'form').method, 'POST');
  assert.equal(listeners.size, 0);
  assert.ok(nodes.every(node => node.removed));
});
