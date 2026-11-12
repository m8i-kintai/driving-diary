import { createDemoApi } from './demo.js';

const AMBIGUOUS = new Set(['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'WRITE_PENDING', 'RETRY_REQUIRED', 'WRITE_INCOMPLETE', 'INVALID_RESPONSE']);

export function apiError(code, message, details = {}) {
  const error = new Error(message);
  Object.assign(error, { code, ambiguous: AMBIGUOUS.has(code) }, details);
  return error;
}

export function requestId(cryptoApi = globalThis.crypto) {
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues) throw apiError('UNSUPPORTED_BROWSER', 'このブラウザを更新してから開いてください。');
  return [...cryptoApi.getRandomValues(new Uint8Array(24))].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function isTrustedGasOrigin(origin) {
  return origin === 'https://script.google.com' || origin === 'https://script.googleusercontent.com' || /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(origin);
}

export function validateApiUrl(value) {
  if (!value) throw apiError('UNCONFIGURED', '運転日報の接続準備中です。');
  let url;
  try { url = new URL(value); } catch { throw apiError('CONFIGURATION_ERROR', '接続先を確認できません。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !(url.protocol === 'https:' && url.hostname === 'script.google.com' && /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname))) {
    throw apiError('CONFIGURATION_ERROR', '接続先を確認できません。');
  }
  if (local && !['http:', 'https:'].includes(url.protocol)) throw apiError('CONFIGURATION_ERROR', '接続先を確認できません。');
  return url.href;
}

function readLaunch(env, apiUrl) {
  const params = new URLSearchParams(env.location?.hash?.replace(/^#/, '') || '');
  const storageKey = 'drivelog.auth.v1:' + apiUrl;
  let stored = {};
  try { stored = JSON.parse(env.sessionStorage?.getItem(storageKey) || '{}'); } catch { /* private mode */ }
  const context = {
    employeeId: params.get('kinjiroEmployeeId') || stored.employeeId || '',
    department: params.get('department') || stored.department || '',
    token: params.get('kinjiroToken') || stored.token || '',
    accessKey: params.get('invite') || params.get('accessKey') || stored.accessKey || ''
  };
  if (context.employeeId.length > 64 || context.token.length > 4096 || context.accessKey.length > 4096) throw apiError('UNAUTHORIZED', 'キンジロー君の運転日報ボタンから開き直してください。');
  try { env.sessionStorage?.setItem(storageKey, JSON.stringify(context)); } catch { /* use this tab's memory */ }
  if (params.has('kinjiroToken') || params.has('invite') || params.has('accessKey')) {
    for (const key of ['kinjiroToken', 'invite', 'accessKey']) params.delete(key);
    const suffix = params.toString();
    try { env.history?.replaceState(null, '', env.location.pathname + env.location.search + (suffix ? '#' + suffix : '')); } catch { /* optional */ }
  }
  return context;
}

function unwrap(result, expectedId) {
  if (!result || typeof result.ok !== 'boolean' || result.requestId !== expectedId) throw apiError('INVALID_RESPONSE', '保存結果を確認できません。同じ内容で再確認してください。');
  if (!result.ok) {
    const error = result.error || {};
    throw apiError(String(error.code || 'INTERNAL_ERROR'), String(error.message || '処理を完了できませんでした。'));
  }
  return result.data;
}

async function fetchRpc(env, url, envelope, timeoutMs) {
  const controller = new AbortController();
  const timer = env.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await env.fetch(url, {
      method: 'POST', body: JSON.stringify(envelope), redirect: 'follow',
      credentials: 'omit', cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) throw apiError('NETWORK_ERROR', '通信を確認できません。同じ内容で再確認してください。');
    let json;
    try { json = await response.json(); } catch { throw apiError('INVALID_RESPONSE', '保存結果を確認できません。同じ内容で再確認してください。'); }
    return unwrap(json, envelope.requestId);
  } catch (error) {
    if (error.name === 'AbortError') throw apiError('TIMEOUT', '応答に時間がかかっています。同じ内容で再確認してください。');
    if (typeof error.code === 'string') throw error;
    throw apiError('NETWORK_ERROR', '通信を確認できません。同じ内容で再確認してください。');
  } finally { env.clearTimeout(timer); }
}

function bridgeRpc(env, url, envelope, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!env.document || !env.addEventListener) return reject(apiError('NETWORK_ERROR', '通信を確認できません。'));
    const nonce = requestId(env.crypto);
    const frame = env.document.createElement('iframe');
    const form = env.document.createElement('form');
    frame.name = 'drive_rpc_' + nonce.replace(/[^\w]/g, '');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.referrerPolicy = 'no-referrer';
    form.method = 'POST'; form.action = url; form.target = frame.name; form.hidden = true;
    for (const [name, value] of Object.entries({ transport: 'bridge', payload: JSON.stringify(envelope), origin: env.location.origin, nonce })) {
      const input = env.document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
    }
    let timer;
    const cleanup = () => { env.clearTimeout(timer); env.removeEventListener('message', onMessage); frame.remove(); form.remove(); };
    const onMessage = event => {
      const data = event.data;
      if (!isTrustedGasOrigin(event.origin) || !data || data.kind !== 'DRIVE_LOG_RPC' || data.nonce !== nonce || data.requestId !== envelope.requestId) return;
      cleanup();
      try { resolve(unwrap(data.response, envelope.requestId)); } catch (error) { reject(error); }
    };
    env.addEventListener('message', onMessage);
    timer = env.setTimeout(() => { cleanup(); reject(apiError('TIMEOUT', '保存結果を確認できません。同じ内容で再確認してください。')); }, timeoutMs);
    env.document.body.append(frame, form);
    try { form.submit(); } catch { cleanup(); reject(apiError('NETWORK_ERROR', '通信を確認できません。')); }
  });
}

export function createApi({ config = {}, env = globalThis, auth } = {}) {
  const launch = auth || readLaunch(env, config.apiUrl || '');
  const call = async (action, payload = {}, id = requestId(env.crypto)) => {
    const url = validateApiUrl(config.apiUrl);
    if (!(launch.employeeId && launch.token)) throw apiError('UNAUTHORIZED', 'キンジロー君の運転日報ボタンから開き直してください。');
    if (env.navigator?.onLine === false) throw apiError('NETWORK_ERROR', '通信できる場所で、同じ内容を再確認してください。');
    const envelope = { version: 1, action, requestId: id, payload };
    if (launch.accessKey) envelope.accessKey = launch.accessKey;
    if (launch.employeeId && launch.token) envelope.kinjiro = { employeeId: launch.employeeId, token: launch.token };
    try { return await fetchRpc(env, url, envelope, config.requestTimeoutMs || 20000); }
    catch (error) {
      // 応答不明のPOSTも同じrequestIdで再確認し、二重記入を防ぎます。
      if (config.allowBridge !== false && ['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(error.code) && env.document) {
        return bridgeRpc(env, url, envelope, config.bridgeTimeoutMs || 30000);
      }
      throw error;
    }
  };
  return {
    launchContext: Object.freeze({ employeeId: launch.employeeId || '', department: launch.department || '' }),
    bootstrap: async () => {
      const data = await call('bootstrap');
      if (typeof data?.employee?.id !== 'string' || !data.employee.id.trim() || typeof data.employee.name !== 'string' || !data.employee.name.trim()) {
        throw apiError('INVALID_RESPONSE', '運転者情報を確認できません。キンジロー君から開き直してください。');
      }
      return data;
    },
    vehicleContext: vehicleId => call('vehicleContext', { vehicleId }),
    startTrip: (payload, id) => call('startTrip', payload, id),
    finishTrip: (payload, id) => call('finishTrip', payload, id),
    getTrip: tripId => call('getTrip', { tripId }),
    listHistory: vehicleId => call('listHistory', { vehicleId })
  };
}

const browserEnv = typeof window === 'undefined' ? null : window;
export const isDemo = Boolean(browserEnv && new URLSearchParams(browserEnv.location.search).get('demo') === '1');
export const api = browserEnv ? (isDemo ? createDemoApi(browserEnv) : createApi({ config: browserEnv.DRIVE_CONFIG || {}, env: browserEnv })) : null;
