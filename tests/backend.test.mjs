import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const ACCESS_KEY = 'test-only-key-never-use-in-production';
const HEADERS = ['日付', '曜日', '運転前車両点検', '出発時間', '終了時間', '運転者', '行先', '出発メーター(km)', '終了メーター(km)', '走行距離(km)', '給油量(L)', 'オイル交換', '備考・不具合', '運転前対面確認者', '運転前検知器結果(mg/L)', '運転後対面確認者', '運転後検知器結果(mg/L)', '酒気帯び(有/無)', '指示事項'];
const MASTER = ['現在の距離', '車種', '車検満了日', '車番', '運転日誌リンク', '初回確認時の距離', '種別', '初回確認時のオイル交換実施距離', '変速機'];
const own = (o, key, fallback) => Object.hasOwn(o, key) ? o[key] : fallback;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const env = { sheets: [], readSheetNames: [], fail: null, writes: [], lockCalls: 0, now: Date.parse('2026-11-12T00:05:00Z'), verifyCount: 0, verifyStatus: 'ok', requestCount: 0 };
  class Range {
    constructor(sheet, r, c, rows = 1, cols = 1) { Object.assign(this, { sheet, r, c, rows, cols }); }
    raw(r, c) { return this.sheet.data[r - 1]?.[c - 1] ?? ''; }
    getValues() {
      return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => {
        const value = this.raw(this.r + i, this.c + j);
        if (typeof value === 'string' && value.startsWith('=HYPERLINK(')) return '運転日リンク';
        return typeof value === 'string' ? value.replace(/^'(?=[=+\-@])/, '') : value;
      }));
    }
    getValue() { return this.getValues()[0][0]; }
    getDisplayValues() { return this.getValues().map(row => row.map(v => String(v))); }
    getFormulas() { return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => { const v = this.raw(this.r + i, this.c + j); return typeof v === 'string' && v.startsWith('=') ? v : ''; })); }
    setValue(value) { return this.setValues([[value]]); }
    setValues(values) {
      const failure = env.fail && env.fail.sheet === this.sheet.name && (env.fail.row == null || env.fail.row === this.r) && (env.fail.col == null || env.fail.col === this.c) ? env.fail : null;
      if (failure && !failure.after) { env.fail = null; throw new Error('Simulated interrupted write'); }
      for (let i = 0; i < values.length; i++) {
        this.sheet.data[this.r + i - 1] ??= [];
        for (let j = 0; j < values[i].length; j++) this.sheet.data[this.r + i - 1][this.c + j - 1] = values[i][j];
      }
      env.writes.push({ sheet: this.sheet.name, r: this.r, c: this.c, rows: values.length, cols: values[0].length });
      if (failure?.after) { env.fail = null; throw new Error('Simulated lost write acknowledgement'); }
      return this;
    }
    setNumberFormat(format) { this.sheet.formats.set(`${this.r}:${this.c}`, format); return this; }
  }
  class Sheet {
    constructor(name, id, data = []) { Object.assign(this, { name, id, data: data.map(r => [...r]), hidden: false, formats: new Map() }); env.sheets.push(this); }
    getName() { return this.name; }
    getSheetId() { return this.id; }
    getRange(...args) { return new Range(this, ...args); }
    getLastRow() { for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i]?.some(v => v !== '' && v != null)) return i + 1; return 0; }
    getLastColumn() { return Math.max(0, ...this.data.map(r => r.reduce((last, v, i) => v !== '' && v != null ? i + 1 : last, 0))); }
    hideSheet() { this.hidden = true; return this; }
    isSheetHidden() { return this.hidden; }
  }
  const master = new Sheet('社用車一覧', 1, [MASTER, [own(options, 'current', ''), 'ハイエース', '2027-02-12', 'テスト410え　8', '=HYPERLINK("https://docs.google.com/spreadsheets/d/test/edit#gid=21","運転日リンク")', own(options, 'initial', 120000), own(options, 'fuel', '軽油'), own(options, 'oil', 116000), options.mt ? 'MT' : 'AT']]);
  const vehicle = new Sheet('the gid is authoritative', 21, [HEADERS]);
  if (options.employeeSheet) new Sheet('社員一覧', 2, [['氏名', '社員番号'], ['日報側に残った別の氏名', '0001']]);
  new Sheet('運転日報ひな形', 3, [HEADERS]);
  env.ss = {
    getId: () => 'test-workbook',
    getSheetByName: name => { env.readSheetNames.push(name); return env.sheets.find(s => s.name === name) ?? null; },
    getSheets: () => env.sheets,
    insertSheet: name => new Sheet(name, env.sheets.length + 100)
  };
  env.props = { SPREADSHEET_ID: 'test-workbook', ACCESS_KEY, ALLOWED_ORIGINS: '["https://example.github.io"]', KINJIRO_VERIFY_URL: 'https://verification.example.invalid/exec' };
  const cache = new Map();
  env.authCache = cache;
  let uuid = 0;
  class FixedDate extends Date { static now() { return env.now; } }
  env.context = vm.createContext({
    Date: FixedDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => env.props[key] ?? null }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'test-workbook'); return env.ss; }, flush: () => {} },
    LockService: { getScriptLock: () => { env.lockCalls++; return { waitLock: () => { if (env.busy) throw new Error('locked'); }, releaseLock: () => {} }; } },
    Utilities: { getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`, DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (_, value) => [...createHash('sha256').update(value).digest()] },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value, ttl) => { env.cacheTtl = ttl; cache.set(key, value); } }) },
    UrlFetchApp: { fetch: (url, params) => { env.verifyCount++; env.verifyRequest = { url, params }; if (env.verifyThrow) throw new Error('offline'); const id = JSON.parse(params.payload).empId; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: env.verifyStatus, code: env.verifyCode, empId: own(env, 'verifyEmployee', id), empName: own(env, 'verifyName', id === '0002' ? '佐藤 花子' : '山田 太郎') }) }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'allowall' }, createHtmlOutput: html => ({ html, setXFrameOptionsMode() { return this; } }) }
  });
  vm.runInContext(source, env.context, { filename: 'Code.gs' });
  env.call = (action, payload = {}, opts = {}) => {
    const kinjiro = own(opts, 'kinjiro', { employeeId: '0001', token: 'default-test-device-token' });
    return plain(env.context.processRequest_({ version: 1, action, payload, requestId: opts.requestId ?? `request-${++env.requestCount}`, accessKey: own(opts, 'accessKey', ''), ...(kinjiro ? { kinjiro } : {}) }));
  };
  env.master = master; env.vehicle = vehicle;
  env.cell = header => vehicle.getRange(2, HEADERS.indexOf(header) + 1).getValue();
  env.start = (payload = {}, opts = {}) => env.call('startTrip', { vehicleId: 'テスト410え8', department: '管理G', checks: Object.fromEntries(['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body'].map(k => [k, true])), before: { confirmed: true, reading: null, presence: '無' }, ...payload }, opts);
  env.finish = (tripId, payload = {}, opts = {}) => env.call('finishTrip', { tripId, destination: '取引先', endOdometer: 120120, refueled: false, fuelLiters: null, oilChanged: false, notes: '', after: { confirmed: true, reading: null, presence: '無' }, ...payload }, opts);
  return env;
}

test('auth protects reads; health contains no workbook or credentials', () => {
  const f = fixture();
  for (const action of ['bootstrap', 'lookupEmployee', 'vehicleContext', 'getTrip', 'listHistory', 'startTrip', 'finishTrip']) assert.equal(f.call(action, {}, { accessKey: '', kinjiro: null }).error.code, 'UNAUTHORIZED');
  assert.equal(f.call('bootstrap', {}, { accessKey: ACCESS_KEY, kinjiro: null }).error.code, 'UNAUTHORIZED');
  const health = JSON.parse(f.context.doGet().text);
  assert.deepEqual(health, { ok: true, service: 'drive-log', version: 1 });
});

test('reordered master headers and normalized vehicle ID return the verified self profile', () => {
  const f = fixture();
  const data = f.call('bootstrap').data;
  assert.equal(data.vehicles[0].id, 'テスト410え8');
  assert.equal(data.vehicles[0].number, 'テスト410え 8');
  assert.equal(data.vehicles[0].modelKey, 'hiace');
  assert.equal(data.departments.length, 13);
  assert.deepEqual(data.employee, { id: '0001', name: '山田 太郎' });
  assert.deepEqual(f.call('lookupEmployee', { employeeId: '０００１' }).data, { id: '0001', name: '山田 太郎' });
  assert.equal(f.call('lookupEmployee', { employeeId: 'missing' }).error.code, 'EMPLOYEE_MISMATCH');
});

test('missing initial odometer blocks start even when current master distance exists; zero is valid', () => {
  const missing = fixture({ initial: '', current: 999999 });
  assert.equal(missing.start().error.code, 'INITIAL_ODOMETER_REQUIRED');
  assert.equal(missing.call('vehicleContext', { vehicleId: 'テスト410え8' }).data.startOdometer, null);
  const zero = fixture({ initial: 0, oil: 0 });
  assert.equal(zero.start().data.trip.startOdometer, 0);
});

test('startup and employee lookup are read-only and do not wait for the mutation lock', () => {
  const f = fixture(); f.busy = true;
  assert.equal(f.call('bootstrap').ok, true);
  assert.equal(f.call('lookupEmployee', { employeeId: '0001' }).ok, true);
  assert.equal(f.lockCalls, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.sheets.length, 3);
  assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).error.code, 'BUSY');
});

test('startup reads do not recover pending writes; a stateful read performs recovery', () => {
  const f = fixture();
  f.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
  assert.equal(f.start({}, { requestId: 'startup-read-pending' }).error.code, 'INTERNAL_ERROR');
  const writes = f.writes.length; const locks = f.lockCalls;
  assert.equal(f.call('bootstrap').ok, true);
  assert.equal(f.call('lookupEmployee', { employeeId: '0001' }).ok, true);
  assert.equal(f.writes.length, writes);
  assert.equal(f.lockCalls, locks);
  assert.equal(f.ss.getSheetByName('_運転日報_リクエスト').data[1][3], 'pending');
  assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data.activeTrip.status, 'active');
  assert.equal(f.ss.getSheetByName('_運転日報_リクエスト').data[1][3], 'committed');
});

test('after first completion a missing initial F does not block the next start', () => {
  const f = fixture({ initial: 100, oil: 50 });
  const trip = f.start().data.trip;
  assert.equal(f.finish(trip.id, { endOdometer: 200 }).ok, true);
  f.master.data[1][MASTER.indexOf('初回確認時の距離')] = '';
  f.master.data[1][MASTER.indexOf('現在の距離')] = 999999;
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).data.startOdometer, 200);
  assert.equal(f.start().data.trip.startOdometer, 200);
});

test('oil baseline is independent of initial distance; zero baseline and 50 km threshold', () => {
  const missing = fixture({ initial: 4000, oil: '' });
  assert.deepEqual(missing.call('vehicleContext', { vehicleId: 'テスト410え8' }).data.oil, { baseline: null, interval: 4000, remaining: null, status: 'unregistered' });
  for (const [current, status, count] of [[3950, 'ok', 0], [3951, 'warning', 1], [4000, 'overdue', 1]]) {
    const f = fixture({ initial: current, oil: 0 });
    const ctx = f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data;
    assert.equal(ctx.oil.status, status);
    assert.equal(ctx.warnings.filter(w => w.type === 'oil').length, count);
  }
  assert.equal(fixture({ fuel: 'ガソリン' }).call('vehicleContext', { vehicleId: 'テスト410え8' }).data.oil.interval, 7000);
});

test('start/finish use the same row, JST date, latest completed meter and preserve initial baselines', () => {
  const f = fixture();
  const first = f.start().data.trip;
  assert.equal(first.startedAt, '2026-11-12T09:05:00.000+09:00');
  assert.equal(f.cell('日付'), '2026-11-12');
  assert.equal(f.cell('曜日'), '木');
  assert.equal(f.cell('運転前車両点検'), 'OK');
  assert.equal(f.vehicle.getLastRow(), 2);
  f.now += 3600000;
  const finish = f.finish(first.id, { oilChanged: true, refueled: true, fuelLiters: 22.5 }).data;
  assert.equal(finish.rowNumber, 2);
  assert.equal(finish.sheetUrl, 'https://docs.google.com/spreadsheets/d/test-workbook/edit#gid=21');
  assert.equal(f.cell('終了時間'), '10:05');
  assert.equal(f.cell('走行距離(km)'), 120);
  assert.equal(f.cell('給油量(L)'), 22.5);
  assert.equal(f.cell('オイル交換'), '実施');
  assert.equal(f.master.data[1][MASTER.indexOf('現在の距離')], 120120);
  assert.equal(f.master.data[1][MASTER.indexOf('初回確認時の距離')], 120000);
  assert.equal(f.master.data[1][MASTER.indexOf('初回確認時のオイル交換実施距離')], 116000);
  const ctx = f.call('vehicleContext', { vehicleId: first.vehicleId }).data;
  assert.equal(ctx.oil.baseline, 120120);
  assert.equal(ctx.oil.remaining, 4000);
  assert.equal(f.start().data.trip.startOdometer, 120120);
  assert.equal(f.vehicle.getLastRow(), 3);
});

test('request replay is stable, changed payload is rejected, and duplicate starts cannot allocate a second row', () => {
  const f = fixture();
  const one = f.start({}, { requestId: 'same-start-request' });
  assert.deepEqual(f.start({}, { requestId: 'same-start-request' }), one);
  assert.equal(f.start({ department: '技術G' }, { requestId: 'same-start-request' }).error.code, 'REQUEST_ID_REUSED');
  assert.equal(f.start().error.code, 'VEHICLE_IN_USE');
  const done = f.finish(one.data.trip.id, {}, { requestId: 'same-finish-request' });
  assert.deepEqual(f.finish(one.data.trip.id, {}, { requestId: 'same-finish-request' }), done);
  assert.deepEqual(f.start({}, { requestId: 'same-start-request' }), one);
  assert.equal(f.vehicle.getLastRow(), 2);
});

test('interrupted start after visible-row write recovers without a duplicate row', () => {
  const f = fixture();
  f.call('bootstrap');
  f.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
  assert.equal(f.start({}, { requestId: 'interrupted-start' }).error.code, 'INTERNAL_ERROR');
  assert.equal(f.vehicle.getLastRow(), 2);
  const retry = f.start({}, { requestId: 'interrupted-start' });
  assert.equal(retry.ok, true);
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.ss.getSheetByName('_運転日報_記録管理').getLastRow(), 2);
});

test('interrupted finish after master update replays exact row and committed result', () => {
  const f = fixture();
  const trip = f.start().data.trip;
  f.fail = { sheet: '社用車一覧', row: 2, col: 1, after: true };
  const payload = { notes: '=IMPORTXML("https://example.invalid","x")', oilChanged: true };
  assert.equal(f.finish(trip.id, payload, { requestId: 'interrupted-finish' }).error.code, 'INTERNAL_ERROR');
  const retry = f.finish(trip.id, payload, { requestId: 'interrupted-finish' });
  assert.equal(retry.ok, true);
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.cell('備考・不具合'), payload.notes);
  assert.equal(f.vehicle.getRange(2, HEADERS.indexOf('備考・不具合') + 1).getFormulas()[0][0], '');
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.status, 'completed');
});

test('decreasing or absent end meters and nonpositive checked fuel are rejected without finishing', () => {
  const f = fixture(); const trip = f.start().data.trip;
  assert.equal(f.finish(trip.id, { endOdometer: 119999 }).error.code, 'ODOMETER_DECREASE');
  assert.equal(f.finish(trip.id, { endOdometer: null }).error.code, 'VALIDATION_ERROR');
  assert.equal(f.finish(trip.id, { refueled: true, fuelLiters: 0 }).error.code, 'VALIDATION_ERROR');
  assert.equal(f.finish(trip.id, { refueled: true, fuelLiters: -1 }).error.code, 'VALIDATION_ERROR');
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.status, 'active');
  assert.equal(f.finish(trip.id, { fuelLiters: 999 }).ok, true);
  assert.equal(f.cell('給油量(L)'), '');
});

test('readings preserve blank versus zero, confirmations and combined alcohol presence', () => {
  const f = fixture();
  const trip = f.start({ before: { confirmed: false, reading: 0, presence: '有' } }).data.trip;
  f.finish(trip.id, { after: { confirmed: true, reading: null, presence: '無' }, notes: 'タイヤ傷を確認' });
  assert.equal(f.cell('運転前対面確認者'), '');
  assert.equal(f.cell('運転前検知器結果(mg/L)'), 0);
  assert.equal(f.cell('運転後対面確認者'), 'OK');
  assert.equal(f.cell('運転後検知器結果(mg/L)'), '');
  assert.equal(f.cell('酒気帯び(有/無)'), '有');
  assert.equal(f.cell('指示事項'), '');
  assert.equal(f.vehicle.formats.get(`2:${HEADERS.indexOf('運転前検知器結果(mg/L)') + 1}`), '0.00');
});

test('only MT requires the clutch check; all other applicable checks are mandatory', () => {
  const f = fixture({ mt: true });
  assert.equal(f.start().error.code, 'VALIDATION_ERROR');
  const checks = Object.fromEntries(['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body', 'clutch'].map(k => [k, true]));
  assert.equal(f.start({ checks: { ...checks, tires: false } }).error.code, 'VALIDATION_ERROR');
  assert.equal(f.start({ checks }).ok, true);
});

test('inspection month notices clamp month ends and use JST calendar dates', () => {
  const f = fixture({ initial: 0, oil: 0 });
  assert.equal(f.context.shiftMonths_('2027-03-31', -1), '2027-02-28');
  for (const [date, level] of [['2026-11-12', 'info'], ['2026-12-12', 'warning'], ['2027-01-12', 'danger'], ['2027-02-13', 'danger']]) {
    f.now = Date.parse(`${date}T01:00:00Z`);
    assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data.warnings.find(w => w.type === 'inspection').level, level);
  }
});

test('vehicle sheet can fall back to normalized plate and duplicate master IDs fail closed', () => {
  const f = fixture();
  f.master.data[1][MASTER.indexOf('運転日誌リンク')] = '';
  f.vehicle.name = 'テスト４１０え　８';
  assert.equal(f.start().ok, true);
  f.master.data.push([...f.master.data[1]]);
  assert.equal(f.call('bootstrap').error.code, 'SCHEMA_ERROR');
});

test('Kinjiro verifies the fixed endpoint, caches by token/employee and binds write employee', () => {
  const f = fixture();
  const auth = { accessKey: '', kinjiro: { employeeId: '0001', token: 'test-only-device-token' } };
  assert.equal(f.call('bootstrap', {}, auth).ok, true);
  assert.equal(f.call('bootstrap', {}, auth).ok, true);
  assert.equal(f.verifyCount, 1);
  assert.deepEqual(JSON.parse(f.verifyRequest.params.payload), { requestType: 'deviceVerify', empId: '0001', token: 'test-only-device-token' });
  assert.equal(f.verifyRequest.params.contentType, 'text/plain');
  assert.equal(f.start({ employeeId: '0002' }, auth).error.code, 'EMPLOYEE_MISMATCH');
  assert.equal(f.start({}, auth).ok, true);
});

test('idempotent replay may change valid tokens but remains bound to the recorded employee', () => {
  const f = fixture();
  const original = f.start({}, { requestId: 'auth-mode-replay' });
  const same = { requestId: 'auth-mode-replay', accessKey: '', kinjiro: { employeeId: '0001', token: 'test-only-token-one' } };
  assert.deepEqual(f.start({}, same), original);
  assert.equal(f.start({}, { ...same, kinjiro: { employeeId: '0002', token: 'test-only-token-two' } }).error.code, 'EMPLOYEE_MISMATCH');
});

test('Kinjiro invalid token, unavailable verification and mismatched returned employee fail closed', () => {
  const auth = { accessKey: '', kinjiro: { employeeId: '0001', token: 'test-only-device-token' } };
  const expired = fixture(); expired.verifyStatus = 'invalid';
  assert.equal(expired.call('bootstrap', {}, auth).error.code, 'KINJIRO_SESSION_EXPIRED');
  const missing = fixture(); delete missing.props.KINJIRO_VERIFY_URL;
  assert.equal(missing.call('bootstrap', {}, auth).error.code, 'CONFIGURATION_ERROR');
  const offline = fixture(); offline.verifyThrow = true;
  assert.equal(offline.call('bootstrap', {}, auth).error.code, 'KINJIRO_VERIFICATION_UNAVAILABLE');
  const mismatch = fixture(); mismatch.verifyEmployee = '0002';
  assert.equal(mismatch.call('bootstrap', {}, auth).error.code, 'UNAUTHORIZED');
});

test('Kinjiro status ok requires an explicit nonempty string or finite integer empId', () => {
  const auth = { accessKey: '', kinjiro: { employeeId: '0001', token: 'test-only-device-token' } };
  for (const invalid of [undefined, null, {}, [], '', '   ', false, 1.5, Infinity]) {
    const f = fixture(); f.verifyEmployee = invalid;
    assert.equal(f.call('bootstrap', {}, auth).error.code, 'UNAUTHORIZED', `rejected empId ${String(invalid)}`);
  }
  const numeric = fixture(); numeric.verifyEmployee = 123;
  assert.equal(numeric.call('bootstrap', {}, { accessKey: '', kinjiro: { employeeId: '１２３', token: 'test-only-device-token' } }).ok, true);
});

test('driver name is trusted only from deviceVerify; the diary employee sheet is never read', () => {
  const f = fixture({ employeeSheet: true });
  f.verifyName = '  認証済み　運転者  ';
  const launch = { kinjiro: { employeeId: '0001', token: 'verified-profile-token', name: 'URLから渡された偽氏名', empName: '別人' } };
  assert.deepEqual(f.call('bootstrap', { employeeName: '偽氏名' }, launch).data.employee, { id: '0001', name: '  認証済み　運転者  ' });
  f.sheets = f.sheets.filter(s => s.name !== '社員一覧');
  const trip = f.start({ employeeName: 'クライアント指定の偽氏名', name: '別人' }, launch).data.trip;
  assert.equal(trip.employeeId, '0001');
  assert.equal(trip.employeeName, '  認証済み　運転者  ');
  assert.equal(f.cell('運転者'), '  認証済み　運転者  ');
  assert.equal(f.finish(trip.id, {}, launch).ok, true);
  assert.equal(f.readSheetNames.includes('社員一覧'), false);
});

test('a missing or malformed verified name fails before spreadsheet access even with a valid invite key', () => {
  for (const value of [undefined, null, '', '   ', {}, [], 123, '改行\n氏名']) {
    const f = fixture(); f.verifyName = value;
    const response = f.call('bootstrap', { employeeName: 'クライアントが補った氏名' }, { accessKey: ACCESS_KEY });
    assert.equal(response.error.code, 'UNAUTHORIZED', `rejected name ${String(value)}`);
    assert.equal(f.readSheetNames.length, 0);
    assert.equal(f.authCache.size, 0);
  }
});

test('the identity cache retains verified name and re-verifies incomplete or expired profile entries', () => {
  const f = fixture(); f.verifyName = '確認時の氏名';
  assert.equal(f.call('bootstrap').data.employee.name, '確認時の氏名');
  f.verifyName = 'キンジロー君で更新された氏名';
  assert.equal(f.call('bootstrap').data.employee.name, '確認時の氏名');
  assert.equal(f.verifyCount, 1);
  assert.equal(f.cacheTtl, 120);
  const key = [...f.authCache.keys()][0];
  assert.match(key, /^drive-auth:v3:[a-f0-9]+$/);
  assert.doesNotMatch(f.authCache.get(key), /default-test-device-token/);
  f.authCache.set(key, JSON.stringify({ version: 1, employeeId: '0001' }));
  assert.equal(f.call('bootstrap').data.employee.name, 'キンジロー君で更新された氏名');
  assert.equal(f.verifyCount, 2);
  f.authCache.clear();
  f.verifyStatus = 'error'; f.verifyCode = 'notfound';
  assert.equal(f.call('bootstrap').error.code, 'KINJIRO_SESSION_EXPIRED');
});

test('a different authenticated employee cannot start for or finish another employee', () => {
  const f = fixture();
  assert.equal(f.start({ employeeId: '0002', employeeName: '佐藤 花子' }).error.code, 'EMPLOYEE_MISMATCH');
  const trip = f.start().data.trip;
  const other = { kinjiro: { employeeId: '0002', token: 'other-employee-token' } };
  assert.equal(f.finish(trip.id, {}, other).error.code, 'EMPLOYEE_MISMATCH');
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.status, 'active');
  assert.equal(f.finish(trip.id).ok, true);
});

test('completed ledger timestamps keep latest distance and latest oil when visible rows are sorted', () => {
  const f = fixture();
  for (const [day, end, oilChanged] of [['2026-11-12', 120100, true], ['2026-11-13', 120300, true], ['2026-11-14', 120600, false]]) {
    f.now = Date.parse(`${day}T00:00:00Z`);
    const trip = f.start().data.trip;
    f.now += 3600000;
    assert.equal(f.finish(trip.id, { endOdometer: end, oilChanged }).ok, true);
  }
  f.vehicle.data = [f.vehicle.data[0], ...f.vehicle.data.slice(1).reverse()];
  const context = f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data;
  assert.equal(context.startOdometer, 120600);
  assert.equal(context.oil.baseline, 120300);
  assert.equal(f.start().data.trip.startOdometer, 120600);
});

function manualRecord(values) { return HEADERS.map(h => values[h] ?? ''); }

test('legacy dated rows use completion time, including midnight crossing, independently of row order', () => {
  const f = fixture({ initial: '', oil: 100 });
  f.vehicle.data.push(
    manualRecord({ 日付: '2026-11-14', 出発時間: '01:30', 終了時間: '02:00', '終了メーター(km)': 350 }),
    manualRecord({ 日付: '2026-11-13', 出発時間: '23:00', 終了時間: '01:00', '終了メーター(km)': 300, オイル交換: '実施' }),
    manualRecord({ 日付: '2026-11-13', 出発時間: '10:00', 終了時間: '11:00', '終了メーター(km)': 200, オイル交換: '実施' })
  );
  const context = f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data;
  assert.equal(context.startOdometer, 350);
  assert.equal(context.oil.baseline, 300);
  assert.equal(f.start().data.trip.startOdometer, 350);
});

test('ledger preserves actual completion after a trip lasting over 24 hours', () => {
  const f = fixture({ initial: 100, oil: 0 });
  f.now = Date.parse('2026-11-12T14:00:00Z');
  const trip = f.start().data.trip;
  f.now = Date.parse('2026-11-14T03:00:00Z');
  assert.equal(f.finish(trip.id, { endOdometer: 300, oilChanged: true }).ok, true);
  f.vehicle.data.push(manualRecord({ 日付: '2026-11-13', 出発時間: '12:00', 終了時間: '13:00', '終了メーター(km)': 200 }));
  const context = f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data;
  assert.equal(context.startOdometer, 300);
  assert.equal(context.oil.baseline, 300);
});

test('completed legacy rows without a known date fail instead of choosing the physical bottom row', () => {
  const f = fixture();
  f.vehicle.data.push(manualRecord({ 出発時間: '12:00', 終了時間: '13:00', '終了メーター(km)': 120500 }));
  assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).error.code, 'SCHEMA_ERROR');
  assert.equal(f.start().error.code, 'SCHEMA_ERROR');
});

test('bridge posts only to an allowlisted origin and escapes script-closing input', () => {
  const f = fixture();
  f.verifyName = '</script><script>unexpected()</script>';
  const request = { version: 1, requestId: 'bridge-request', action: 'lookupEmployee', kinjiro: { employeeId: '0001', token: 'test-only-device-token' }, payload: { employeeId: '0001' } };
  const allowed = f.context.doPost({ parameter: { transport: 'bridge', origin: 'https://example.github.io', nonce: 'nonce-123456', payload: JSON.stringify(request) } });
  assert.match(allowed.html, /window\.top\.postMessage/);
  assert.match(allowed.html, /DRIVE_LOG_RPC/);
  assert.doesNotMatch(allowed.html, /test-only-key/);
  assert.match(allowed.html, /\\u003c\/script\\u003e/);
  assert.equal((allowed.html.match(/<\/script>/g) ?? []).length, 1);
  const blocked = f.context.doPost({ parameter: { transport: 'bridge', origin: 'https://attacker.example', nonce: 'nonce-123456', payload: JSON.stringify(request) } });
  assert.doesNotMatch(blocked.html, /postMessage/);
  const json = JSON.parse(f.context.doPost({ postData: { contents: '{bad' } }).text);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
});

test('pending-row conflicts stop recovery rather than overwriting manually changed records', () => {
  const f = fixture(); f.call('bootstrap');
  f.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
  f.start({}, { requestId: 'row-conflict-start' });
  f.vehicle.data[1][HEADERS.indexOf('運転者')] = '手動で変更された氏名';
  assert.equal(f.start({}, { requestId: 'row-conflict-start' }).error.code, 'ROW_CONFLICT');
  assert.equal(f.cell('運転者'), '手動で変更された氏名');
});

test('finish refuses a moved or manually completed start row before journaling', () => {
  const changed = fixture(); const trip = changed.start().data.trip;
  changed.vehicle.data[1][HEADERS.indexOf('運転者')] = '別の運転者';
  assert.equal(changed.finish(trip.id).error.code, 'ROW_CONFLICT');
  assert.equal(changed.cell('終了メーター(km)'), '');
  const completed = fixture(); const active = completed.start().data.trip;
  completed.vehicle.data[1][HEADERS.indexOf('終了時間')] = '12:00';
  assert.equal(completed.finish(active.id).error.code, 'ROW_CONFLICT');
  assert.equal(completed.cell('終了時間'), '12:00');
});
