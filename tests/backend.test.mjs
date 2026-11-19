import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const fleetSource = fs.readFileSync(new URL('../gas/FleetAdmin.gs', import.meta.url), 'utf8');
const ACCESS_KEY = 'test-only-key-never-use-in-production';
const HEADERS = ['日付', '曜日', '運転前車両点検', '出発時間', '終了時間', '運転者', '行先', '出発メーター(km)', '終了メーター(km)', '走行距離(km)', '給油量(L)', 'オイル交換', '備考・不具合', '運転前対面確認者', '運転前検知器結果(mg/L)', '運転後対面確認者', '運転後検知器結果(mg/L)', '酒気帯び(有/無)', '指示事項'];
const MASTER = ['現在の距離', '車種', '車検満了日', '車番', '運転日誌リンク', '初回確認時の距離', '種別', '初回確認時のオイル交換実施距離', '変速機'];
const own = (o, key, fallback) => Object.hasOwn(o, key) ? o[key] : fallback;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const env = { sheets: [], readSheetNames: [], fail: null, writes: [], lockCalls: 0, now: Date.parse('2026-11-12T00:05:00Z'), verifyCount: 0, verifyStatus: 'ok', requestCount: 0, typedSheets: !!options.typedSheets, sheetTimeZone: options.sheetTimeZone || 'Asia/Tokyo', activeEmail: 'admin@example.invalid', effectiveEmail: 'admin@example.invalid', canEdit: true };
  class Range {
    constructor(sheet, r, c, rows = 1, cols = 1) { Object.assign(this, { sheet, r, c, rows, cols }); }
    raw(r, c) { return this.sheet.data[r - 1]?.[c - 1] ?? ''; }
    getValues() {
      return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => {
        let value = this.raw(this.r + i, this.c + j);
        if (env.typedSheets && this.sheet.id === 21 && this.r + i > 1 && typeof value === 'string') {
          const header = HEADERS[this.c + j - 1];
          const offset = env.sheetTimeZone === 'Etc/UTC' ? 'Z' : '+09:00';
          if (header === '日付' && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = new Date(`${value}T00:00:00${offset}`);
          if (['出発時間', '終了時間'].includes(header) && /^\d{2}:\d{2}$/.test(value)) value = new Date(`1899-12-30T${value}:00${offset}`);
        }
        if (value === '=""') return '';
        if (typeof value === 'string' && value.startsWith('=HYPERLINK(')) return '運転日リンク';
        return typeof value === 'string' ? value.replace(/^'(?=[=+\-@])/, '') : value;
      }));
    }
    getValue() { return this.getValues()[0][0]; }
    canEdit() { return env.canEdit; }
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
    getNumberFormat() { return this.sheet.formats.get(`${this.r}:${this.c}`) ?? 'General'; }
    setDataValidation(rule) { this.sheet.validations.set(`${this.r}:${this.c}`, rule); return this; }
    clearDataValidations() {
      for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) this.sheet.validations.delete(`${this.r + i}:${this.c + j}`);
      return this;
    }
    clearContent() {
      const failure = env.fail && env.fail.sheet === this.sheet.name && (env.fail.row == null || env.fail.row === this.r) && (env.fail.col == null || env.fail.col === this.c) ? env.fail : null;
      if (failure && !failure.after) { env.fail = null; throw new Error('Simulated interrupted clear'); }
      for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) {
        if (this.sheet.data[this.r + i - 1]) this.sheet.data[this.r + i - 1][this.c + j - 1] = '';
      }
      env.writes.push({ sheet: this.sheet.name, r: this.r, c: this.c, rows: this.rows, cols: this.cols, cleared: true });
      if (failure?.after) { env.fail = null; throw new Error('Simulated lost clear acknowledgement'); }
      return this;
    }
    clearFormat() { return this; }
    merge() { return this; }
    breakApart() { return this; }
    setBackground() { return this; }
    setBorder() { return this; }
    setFontColor() { return this; }
    setFontWeight() { return this; }
    setFontFamily() { return this; }
    setFontSize() { return this; }
    setWrap() { return this; }
    setVerticalAlignment() { return this; }
    setHorizontalAlignment() { return this; }
  }
  class Sheet {
    constructor(name, id, data = []) { Object.assign(this, { name, id, data: data.map(r => [...r]), hidden: false, formats: new Map(), validations: new Map(), metadata: [], columnWidths: new Map() }); env.sheets.push(this); }
    getName() { return this.name; }
    setName(name) {
      if (env.sheets.some(sheet => sheet !== this && sheet.name === name)) throw new Error('Duplicate sheet name');
      this.name = name;
      if (env.failRename) { env.failRename = false; throw new Error('Simulated lost rename acknowledgement'); }
      return this;
    }
    getSheetId() { return this.id; }
    getIndex() { return env.sheets.indexOf(this) + 1; }
    getParent() { return env.ss; }
    setColumnWidth(column, width) { this.columnWidths.set(column, width); return this; }
    getColumnWidth(column) { return this.columnWidths.get(column) ?? 100; }
    getDeveloperMetadata() { return this.metadata; }
    addDeveloperMetadata(key, value) {
      const metadata = { getKey: () => key, getValue: () => value, setValue(next) { value = next; return this; } };
      this.metadata.push(metadata);
      return this;
    }
    setRowHeight() { return this; }
    setHiddenGridlines() { return this; }
    getRange(...args) { return new Range(this, ...args); }
    getLastRow() { for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i]?.some(v => v !== '' && v != null)) return i + 1; return 0; }
    getLastColumn() { return Math.max(0, ...Array.from(this.data, r => r?.reduce((last, v, i) => v !== '' && v != null ? i + 1 : last, 0) ?? 0)); }
    hideSheet() { this.hidden = true; return this; }
    showSheet() { this.hidden = false; return this; }
    isSheetHidden() { return this.hidden; }
  }
  const master = new Sheet('社用車一覧', 1, [MASTER, [own(options, 'current', ''), 'ハイエース', '2027-02-12', 'テスト410え　8', '=HYPERLINK("https://docs.google.com/spreadsheets/d/test/edit#gid=21","運転日リンク")', own(options, 'initial', 120000), own(options, 'fuel', '軽油'), own(options, 'oil', 116000), options.mt ? 'MT' : 'AT']]);
  const vehicle = new Sheet('the gid is authoritative', 21, [HEADERS]);
  if (options.employeeSheet) new Sheet('社員一覧', 2, [['氏名', '社員番号'], ['日報側に残った別の氏名', '0001']]);
  new Sheet('運転日報ひな形', 3, [HEADERS]);
  env.ss = {
    getId: () => 'test-workbook',
    getSpreadsheetTimeZone: () => env.sheetTimeZone,
    getSheetByName: name => { env.readSheetNames.push(name); return env.sheets.find(s => s.name === name) ?? null; },
    getSheets: () => env.sheets,
    insertSheet: (name, indexOrOptions = {}, options = {}) => {
      if (env.sheets.some(sheet => sheet.name === name)) throw new Error('Duplicate sheet name');
      if (typeof indexOrOptions === 'object') options = indexOrOptions;
      const sheet = new Sheet(name, env.sheets.length + 100, options.template?.data ?? []);
      if (typeof indexOrOptions === 'number') { env.sheets.pop(); env.sheets.splice(indexOrOptions, 0, sheet); }
      if (env.failInsert) { env.failInsert = false; throw new Error('Simulated lost insert acknowledgement'); }
      return sheet;
    }
  };
  env.props = { SPREADSHEET_ID: 'test-workbook', ACCESS_KEY, ALLOWED_ORIGINS: '["https://example.github.io"]', KINJIRO_VERIFY_URL: 'https://verification.example.invalid/exec' };
  const cache = new Map();
  env.authCache = cache;
  let uuid = 0;
  class FixedDate extends Date { static now() { return env.now; } }
  env.context = vm.createContext({
    Date: FixedDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => env.props[key] ?? null }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'test-workbook'); return env.ss; }, flush: () => {}, newDataValidation: () => {
      const rule = {};
      return { requireValueInList(values) { rule.values = [...values]; return this; }, setAllowInvalid(allow) { rule.allowInvalid = allow; return this; }, build() { return rule; } };
    } },
    LockService: { getScriptLock: () => { env.lockCalls++; return { waitLock: () => { if (env.busy) throw new Error('locked'); }, releaseLock: () => {} }; } },
    Session: { getActiveUser: () => ({ getEmail: () => env.activeEmail }), getEffectiveUser: () => ({ getEmail: () => env.effectiveEmail }) },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (_, value) => [...createHash('sha256').update(value).digest()],
      formatDate: (date, timeZone, format) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
        if (format === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
        if (format === 'HH:mm') return `${parts.hour}:${parts.minute}`;
        if (format === 'HH:mm:ss.SSS') return `${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
        throw new Error(`Unsupported test date format ${format}`);
      }
    },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value, ttl) => { env.cacheTtl = ttl; cache.set(key, value); } }) },
    UrlFetchApp: { fetch: (url, params) => { env.verifyCount++; env.verifyRequest = { url, params }; if (env.verifyThrow) throw new Error('offline'); const id = JSON.parse(params.payload).empId; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: env.verifyStatus, code: env.verifyCode, empId: own(env, 'verifyEmployee', id), empName: own(env, 'verifyName', id === '0002' ? '佐藤 花子' : '山田 太郎') }) }; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    HtmlService: { XFrameOptionsMode: { ALLOWALL: 'allowall' }, createHtmlOutput: html => ({ html, setXFrameOptionsMode() { return this; } }), createHtmlOutputFromFile: file => ({ file, setTitle(title) { this.title = title; return this; } }) }
  });
  vm.runInContext(source, env.context, { filename: 'Code.gs' });
  vm.runInContext(fleetSource, env.context, { filename: 'FleetAdmin.gs' });
  env.call = (action, payload = {}, opts = {}) => {
    const kinjiro = own(opts, 'kinjiro', { employeeId: '0001', token: 'default-test-device-token' });
    return plain(env.context.processRequest_({ version: 1, action, payload, requestId: opts.requestId ?? `request-${++env.requestCount}`, accessKey: own(opts, 'accessKey', ''), ...(kinjiro ? { kinjiro } : {}) }));
  };
  env.master = master; env.vehicle = vehicle;
  env.cell = header => vehicle.getRange(2, HEADERS.indexOf(header) + 1).getValue();
  env.start = (payload = {}, opts = {}) => env.call('startTrip', { vehicleId: 'テスト410え8', department: '管理G', checks: Object.fromEntries(['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body'].map(k => [k, true])), before: { confirmed: true, reading: null, presence: '無' }, ...payload }, opts);
  env.finish = (tripId, payload = {}, opts = {}) => env.call('finishTrip', { tripId, destination: '取引先', endOdometer: 120120, refueled: false, fuelLiters: null, oilChanged: false, notes: '', after: { confirmed: true, reading: null, presence: '無' }, ...payload }, opts);
  env.admin = (action, operation, payload = {}, opts = {}) => plain(env.context.fleetAdminRpc({ version: 1, action, operation, payload, requestId: opts.requestId ?? `10000000-0000-4000-8000-${String(++env.requestCount).padStart(12, '0')}`, ...opts }));
  env.install = () => plain(env.context.installFleetManagement_('https://script.google.com/macros/s/test-admin-deployment/exec'));
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

test('management logs are created visible and stateful access reopens previously hidden logs', () => {
  const f = fixture();
  assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).ok, true);
  const logs = ['_運転日報_記録管理', '_運転日報_リクエスト'].map(name => f.ss.getSheetByName(name));
  assert.ok(logs.every(sheet => !sheet.isSheetHidden()));
  logs.forEach(sheet => sheet.hideSheet());
  assert.ok(logs.every(sheet => sheet.isSheetHidden()));
  assert.equal(f.call('listHistory', { vehicleId: 'テスト410え8' }).ok, true);
  assert.ok(logs.every(sheet => !sheet.isSheetHidden()));
  assert.equal(f.start().ok, true);
  assert.ok(logs.every(sheet => !sheet.isSheetHidden()));
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
  const trip = f.start({ before: { confirmed: false, reading: 0, presence: '無' } }).data.trip;
  assert.equal(f.finish(trip.id, { after: { confirmed: true, reading: null, presence: '有' }, notes: 'タイヤ傷を確認' }).ok, true);
  assert.equal(f.cell('運転前対面確認者'), '');
  assert.equal(f.cell('運転前検知器結果(mg/L)'), 0);
  assert.equal(f.cell('運転後対面確認者'), 'OK');
  assert.equal(f.cell('運転後検知器結果(mg/L)'), '');
  assert.equal(f.cell('酒気帯び(有/無)'), '有');
  assert.equal(f.cell('指示事項'), '');
  assert.equal(f.vehicle.formats.get(`2:${HEADERS.indexOf('運転前検知器結果(mg/L)') + 1}`), '0.00');
});

test('new start requires explicit alcohol absence and creates no driving record when blocked', () => {
  const present = fixture();
  const denied = present.start({ before: { confirmed: true, reading: 0, presence: '有' } });
  assert.equal(denied.error.code, 'ALCOHOL_PRESENT');
  assert.equal(denied.error.message, '酒気帯びが「有」のため出発できません。');
  assert.equal(present.vehicle.getLastRow(), 1);
  assert.equal(present.master.data[1][MASTER.indexOf('現在の距離')], '');
  assert.equal(present.ss.getSheetByName('_運転日報_記録管理').getLastRow(), 1);
  assert.equal(present.ss.getSheetByName('_運転日報_リクエスト').getLastRow(), 1);
  for (const presence of [undefined, null, '', '未選択', '無 ', false, 0]) {
    const f = fixture();
    assert.equal(f.start({ before: { confirmed: true, reading: null, presence } }).error.code, 'VALIDATION_ERROR');
    assert.equal(f.vehicle.getLastRow(), 1);
  }
  assert.equal(fixture().start({ before: { confirmed: true, reading: null, presence: '無' } }).ok, true);
});

test('historical alcohol-present start requests still replay and recover without creating a new start', () => {
  const f = fixture();
  const original = f.start({}, { requestId: 'legacy-present-start' });
  const requests = f.ss.getSheetByName('_運転日報_リクエスト');
  const records = f.ss.getSheetByName('_運転日報_記録管理');
  // Model a request persisted before the alcohol-start rule was introduced.
  const operation = JSON.parse(requests.data[1][4]);
  operation.trip.before.presence = '有'; operation.fields.presence = '有';
  requests.data[1][2] = requests.data[1][2].replace('"presence":"無"', '"presence":"有"');
  requests.data[1][4] = JSON.stringify(operation);
  const response = JSON.parse(requests.data[1][5]); response.data.trip.before.presence = '有';
  requests.data[1][5] = JSON.stringify(response);
  records.data[1][3] = JSON.stringify(operation.trip);
  f.vehicle.data[1][HEADERS.indexOf('酒気帯び(有/無)')] = '有';
  const replay = f.start({ before: { confirmed: true, reading: null, presence: '有' } }, { requestId: 'legacy-present-start' });
  assert.equal(replay.ok, true);
  assert.equal(replay.data.trip.id, original.data.trip.id);
  assert.equal(replay.data.trip.before.presence, '有');
  assert.equal(f.vehicle.getLastRow(), 2);
  requests.data[1][3] = 'pending';
  records.data = [records.data[0]];
  const context = f.call('vehicleContext', { vehicleId: 'テスト410え8' }).data;
  assert.equal(context.activeTrip.id, original.data.trip.id);
  assert.equal(context.activeTrip.before.presence, '有');
  assert.equal(requests.data[1][3], 'committed');
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.finish(original.data.trip.id).ok, true);
  assert.equal(f.cell('酒気帯び(有/無)'), '有');
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

test('start stays bound to self while another verified employee may complete the trip', () => {
  const f = fixture();
  assert.equal(f.start({ employeeId: '0002', employeeName: '佐藤 花子' }).error.code, 'EMPLOYEE_MISMATCH');
  const trip = f.start().data.trip;
  assert.equal(trip.recordedDriverName, '山田 太郎');
  const other = { kinjiro: { employeeId: '0002', token: 'other-employee-token' } };
  const result = f.finish(trip.id, { department: '技術G', completedByEmployeeId: '0003', completedByEmployeeName: 'クライアント指定の偽氏名' }, other);
  assert.equal(result.ok, true);
  assert.equal(result.data.trip.employeeId, '0001');
  assert.equal(result.data.trip.employeeName, '山田 太郎');
  assert.equal(result.data.trip.completedByEmployeeId, '0002');
  assert.equal(result.data.trip.completedByEmployeeName, '佐藤 花子');
  assert.equal(result.data.trip.department, '管理G');
  assert.equal(result.data.trip.completedDepartment, '技術G');
  assert.equal(result.data.trip.recordedDriverName, '山田 太郎 ／ 佐藤 花子');
  assert.equal(f.cell('運転者'), '山田 太郎 ／ 佐藤 花子');
  const stored = JSON.parse(f.ss.getSheetByName('_運転日報_記録管理').data[1][3]);
  assert.equal(stored.completedByEmployeeId, '0002');
  assert.equal(stored.completedByEmployeeName, '佐藤 花子');
  assert.equal(stored.department, '管理G');
  assert.equal(stored.completedDepartment, '技術G');
  assert.equal(f.vehicle.data[0].length, 19);
  assert.equal(f.vehicle.data[1].length, 19);
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.recordedDriverName, '山田 太郎 ／ 佐藤 花子');
  assert.equal(f.call('listHistory', { vehicleId: trip.vehicleId }).data.trips[0].completedByEmployeeId, '0002');
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).data.activeTrip, null);
});

test('same employee ID records the starting name once even if the verified name changes', () => {
  const f = fixture(); const trip = f.start().data.trip;
  f.authCache.clear(); f.verifyName = '改姓後の認証氏名';
  const result = f.finish(trip.id);
  assert.equal(result.ok, true);
  assert.equal(result.data.trip.employeeName, '山田 太郎');
  assert.equal(result.data.trip.completedByEmployeeName, '改姓後の認証氏名');
  assert.equal(result.data.trip.completedDepartment, '管理G');
  assert.equal(result.data.trip.recordedDriverName, '山田 太郎');
  assert.equal(f.cell('運転者'), '山田 太郎');
});

test('different employee IDs record both people even when their names are identical', () => {
  const f = fixture(); const trip = f.start().data.trip;
  f.verifyName = '山田 太郎';
  const result = f.finish(trip.id, {}, { kinjiro: { employeeId: '0002', token: 'same-name-other-person' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.trip.recordedDriverName, '山田 太郎 ／ 山田 太郎');
  assert.equal(f.cell('運転者'), '山田 太郎 ／ 山田 太郎');
});

test('handover finish receipts belong to the completing person and prevent a second completion', () => {
  const f = fixture(); const start = f.start({}, { requestId: 'handover-start-receipt' });
  const b = { requestId: 'handover-finish-receipt', kinjiro: { employeeId: '0002', token: 'person-b-device-token' } };
  const c = { requestId: b.requestId, kinjiro: { employeeId: '0003', token: 'person-c-device-token' } };
  const finished = f.finish(start.data.trip.id, {}, b);
  assert.equal(finished.ok, true);
  assert.deepEqual(f.finish(start.data.trip.id, {}, b), finished);
  assert.equal(f.finish(start.data.trip.id, {}, c).error.code, 'EMPLOYEE_MISMATCH');
  assert.equal(f.finish(start.data.trip.id, {}, { requestId: b.requestId }).error.code, 'EMPLOYEE_MISMATCH');
  assert.equal(f.finish(start.data.trip.id, {}, { kinjiro: c.kinjiro }).error.code, 'TRIP_ALREADY_COMPLETED');
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.cell('運転者'), '山田 太郎 ／ 佐藤 花子');
  assert.deepEqual(f.start({}, { requestId: 'handover-start-receipt' }), start);
  assert.equal(f.start({}, { requestId: 'handover-start-receipt', kinjiro: b.kinjiro }).error.code, 'EMPLOYEE_MISMATCH');
});

test('interrupted handover completion preserves both names and its actor during recovery by another caller', () => {
  const f = fixture(); const trip = f.start().data.trip;
  const b = { requestId: 'pending-handover-finish', kinjiro: { employeeId: '0002', token: 'person-b-device-token' } };
  f.fail = { sheet: '社用車一覧', row: 2, col: 1, after: true };
  assert.equal(f.finish(trip.id, {}, b).error.code, 'INTERNAL_ERROR');
  assert.equal(f.cell('運転者'), '山田 太郎 ／ 佐藤 花子');
  const c = { requestId: b.requestId, kinjiro: { employeeId: '0003', token: 'person-c-device-token' } };
  assert.equal(f.finish(trip.id, {}, c).error.code, 'EMPLOYEE_MISMATCH');
  const retried = f.finish(trip.id, {}, b);
  assert.equal(retried.ok, true);
  assert.equal(retried.data.trip.completedByEmployeeId, '0002');
  assert.equal(retried.data.trip.completedByEmployeeName, '佐藤 花子');
  assert.equal(retried.data.trip.recordedDriverName, '山田 太郎 ／ 佐藤 花子');
  assert.equal(f.cell('運転者'), '山田 太郎 ／ 佐藤 花子');
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.completedByEmployeeId, '0002');
});

test('legacy finish receipts without completing-person metadata fall back to the starting employee', () => {
  const f = fixture(); const trip = f.start().data.trip;
  const opts = { requestId: 'legacy-finish-owner' };
  assert.equal(f.finish(trip.id, {}, opts).ok, true);
  const journal = f.ss.getSheetByName('_運転日報_リクエスト');
  const row = journal.data.find(r => r[0] === opts.requestId);
  const operation = JSON.parse(row[4]);
  delete operation.trip.completedByEmployeeId; delete operation.trip.completedByEmployeeName;
  delete operation.trip.completedDepartment;
  row[4] = JSON.stringify(operation);
  const response = JSON.parse(row[5]);
  delete response.data.trip.completedByEmployeeId; delete response.data.trip.completedByEmployeeName; delete response.data.trip.recordedDriverName; delete response.data.trip.completedDepartment;
  row[5] = JSON.stringify(response);
  assert.deepEqual(f.finish(trip.id, {}, opts), response);
  assert.equal(f.finish(trip.id, {}, { ...opts, kinjiro: { employeeId: '0002', token: 'other-person-replay' } }).error.code, 'EMPLOYEE_MISMATCH');
});

test('an explicitly selected completing department is validated without changing the starting department', () => {
  const f = fixture(); const trip = f.start().data.trip;
  assert.equal(Object.hasOwn(trip, 'completedDepartment'), false);
  for (const department of [null, '', '未登録の部門', 100, {}]) {
    const response = f.finish(trip.id, { department });
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.equal(response.error.message, '稼働部門を選択してください。');
    assert.equal(f.cell('終了時間'), '');
  }
  const finished = f.finish(trip.id, { department: '建設2G' });
  assert.equal(finished.ok, true);
  assert.equal(finished.data.trip.department, '管理G');
  assert.equal(finished.data.trip.completedDepartment, '建設2G');
});

test('completed legacy history without a completing department displays the starting department fallback', () => {
  const f = fixture(); const trip = f.start().data.trip;
  assert.equal(f.finish(trip.id).ok, true);
  const records = f.ss.getSheetByName('_運転日報_記録管理');
  const stored = JSON.parse(records.data[1][3]); delete stored.completedDepartment;
  records.data[1][3] = JSON.stringify(stored);
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.completedDepartment, '管理G');
  assert.equal(f.call('listHistory', { vehicleId: trip.vehicleId }).data.trips[0].completedDepartment, '管理G');
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

test('typed Sheets dates and times complete the original row after a three-kilometer trip', () => {
  const f = fixture({ typedSheets: true, initial: 85712 });
  f.now = Date.parse('2026-11-12T04:07:00Z');
  const started = f.start();
  assert.equal(started.ok, true);
  assert.equal(f.cell('日付').toISOString(), '2026-11-11T15:00:00.000Z');
  assert.equal(f.cell('出発時間').toISOString(), '1899-12-30T04:07:00.000Z');
  assert.equal(f.cell('終了時間'), '');
  const completed = f.finish(started.data.trip.id, { endOdometer: 85715 });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(completed.data.rowNumber, 2);
  assert.equal(completed.data.trip.distance, 3);
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.cell('終了メーター(km)'), 85715);
});

test('typed Sheets pending completion recovers without another row or a false conflict', () => {
  const f = fixture({ typedSheets: true }); const trip = f.start().data.trip;
  f.fail = { sheet: '社用車一覧', row: 2, col: 1, after: true };
  assert.equal(f.finish(trip.id, {}, { requestId: 'typed-pending-finish' }).error.code, 'INTERNAL_ERROR');
  const recovered = f.finish(trip.id, {}, { requestId: 'typed-pending-finish' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(f.vehicle.getLastRow(), 2);
  assert.equal(f.call('getTrip', { tripId: trip.id }).data.trip.status, 'completed');
});

test('typed Sheets recovery accepts historical journal Date values serialized to ISO', () => {
  const f = fixture({ typedSheets: true });
  f.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
  assert.equal(f.start({}, { requestId: 'typed-serialized-start' }).error.code, 'INTERNAL_ERROR');
  const requests = f.ss.getSheetByName('_運転日報_リクエスト');
  const operation = JSON.parse(requests.data[1][4]);
  operation.fields.date = f.cell('日付').toISOString();
  operation.fields.startTime = f.cell('出発時間').toISOString();
  requests.data[1][4] = JSON.stringify(operation);
  const recovered = f.call('vehicleContext', { vehicleId: 'テスト410え8' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.data.activeTrip.status, 'active');
  assert.equal(f.vehicle.data[1][HEADERS.indexOf('日付')], '2026-11-12');
  assert.equal(f.vehicle.data[1][HEADERS.indexOf('出発時間')], '09:05');
  assert.equal(f.finish(recovered.data.activeTrip.id).ok, true);
});

test('typed Sheets uses spreadsheet timezone and keeps a blank end time distinct from midnight', () => {
  const f = fixture({ typedSheets: true, sheetTimeZone: 'Etc/UTC' });
  f.now = Date.parse('2026-11-11T15:00:00Z');
  const trip = f.start().data.trip;
  assert.equal(f.cell('出発時間').toISOString(), '1899-12-30T00:00:00.000Z');
  assert.equal(f.cell('終了時間'), '');
  f.now += 30 * 60000;
  const completed = f.finish(trip.id);
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(f.vehicle.data[1][HEADERS.indexOf('出発時間')], '00:00');
  assert.equal(f.vehicle.data[1][HEADERS.indexOf('終了時間')], '00:30');
});

test('typed Sheets still rejects a genuinely edited start time', () => {
  const f = fixture({ typedSheets: true }); const trip = f.start().data.trip;
  f.vehicle.data[1][HEADERS.indexOf('出発時間')] = '09:06';
  assert.equal(f.finish(trip.id).error.code, 'ROW_CONFLICT');
  assert.equal(f.cell('終了メーター(km)'), '');
});

test('typed Sheets does not discard manually changed seconds or a changed calendar day', () => {
  const seconds = fixture({ typedSheets: true }); const first = seconds.start().data.trip;
  seconds.vehicle.data[1][HEADERS.indexOf('出発時間')] = new Date('1899-12-30T00:05:30+00:00');
  assert.equal(seconds.finish(first.id).error.code, 'ROW_CONFLICT');
  const day = fixture({ typedSheets: true }); const second = day.start().data.trip;
  day.vehicle.data[1][HEADERS.indexOf('日付')] = '2026-11-13';
  assert.equal(day.finish(second.id).error.code, 'ROW_CONFLICT');
  assert.equal(day.cell('終了メーター(km)'), '');
});

test('private cancellation preview is read-only and cancellation retains an audit tombstone', () => {
  const f = fixture({ typedSheets: true });
  const startPayload = {};
  const first = f.start(startPayload, { requestId: 'cancel-first-start' }).data.trip;
  f.now += 600000;
  const finishPayload = { oilChanged: true, notes: '取消対象のテスト' };
  assert.equal(f.finish(first.id, finishPayload, { requestId: 'cancel-first-finish' }).ok, true);
  f.vehicle.data[0].push('対象外の列'); f.vehicle.data[1].push('保持する値');
  // Simulate the user's partial manual clearing without reconstructing lost data.
  f.vehicle.data[1][HEADERS.indexOf('走行距離(km)')] = '';
  f.master.data[1][MASTER.indexOf('現在の距離')] = '';
  const writesBeforePreview = f.writes.length;
  const preview = plain(f.context.previewCancelLatestTrip_(first.id, 'テストを元に戻す'));
  assert.equal(f.writes.length, writesBeforePreview);
  assert.equal(preview.tripId, first.id);
  assert.equal(preview.restoredOdometer, 120000);
  assert.equal(preview.committedFields.distance, 120);
  assert.equal(preview.visibleFields.distance, '');
  assert.throws(() => f.context.cancelLatestTrip_(first.id, ''), { driveLogCode: 'VALIDATION_ERROR' });
  const cancelled = plain(f.context.cancelLatestTrip_(first.id, 'テストを元に戻す'));
  assert.equal(cancelled.restoredOdometer, 120000);
  assert.ok(f.vehicle.data[1].slice(0, HEADERS.length).every(v => v === ''));
  assert.equal(f.vehicle.data[1][HEADERS.length], '保持する値');
  assert.equal(f.master.data[1][MASTER.indexOf('現在の距離')], 120000);
  assert.equal(f.master.data[1][MASTER.indexOf('初回確認時の距離')], 120000);
  const ledger = f.ss.getSheetByName('_運転日報_記録管理');
  const tombstone = JSON.parse(ledger.data[1][3]);
  assert.equal(tombstone.status, 'cancelled');
  assert.equal(tombstone.cancellationReason, 'テストを元に戻す');
  assert.equal(tombstone.endOdometer, 120120);
  assert.equal(tombstone.cancelledAt, '2026-11-12T09:15:00.000+09:00');
  const requests = f.ss.getSheetByName('_運転日報_リクエスト');
  assert.equal(requests.data.length, 4);
  const journal = JSON.parse(requests.data[3][4]);
  assert.equal(journal.kind, 'cancel');
  assert.equal(journal.backup.trip.status, 'completed');
  assert.equal(journal.backup.visibleFields.distance, '');
  assert.equal(journal.backup.finishRequest[0], 'cancel-first-finish');
  assert.equal(journal.previousFields.distance, 120);
  assert.equal(f.call('getTrip', { tripId: first.id }).error.code, 'TRIP_CANCELLED');
  assert.deepEqual(f.call('listHistory', { vehicleId: first.vehicleId }).data.trips, []);
  const context = f.call('vehicleContext', { vehicleId: first.vehicleId }).data;
  assert.equal(context.startOdometer, 120000);
  assert.equal(context.activeTrip, null);
  assert.equal(context.oil.baseline, 116000);
  assert.equal(f.start(startPayload, { requestId: 'cancel-first-start' }).error.code, 'TRIP_CANCELLED');
  assert.equal(f.finish(first.id, finishPayload, { requestId: 'cancel-first-finish' }).error.code, 'TRIP_CANCELLED');
  const writesBeforeRetry = f.writes.length;
  assert.deepEqual(plain(f.context.cancelLatestTrip_(first.id, 'テストを元に戻す')), cancelled);
  assert.equal(f.writes.length, writesBeforeRetry);
  assert.equal(f.call('cancelLatestTrip', { tripId: first.id, reason: '公開不可' }).error.code, 'VALIDATION_ERROR');
  assert.equal(f.start().data.trip.startOdometer, 120000);
});

test('two same-clock test trips cancel newest first and restore preceding meter then initial F', () => {
  const f = fixture({ typedSheets: true, initial: 100, oil: 50 });
  const one = f.start().data.trip;
  f.finish(one.id, { endOdometer: 104, oilChanged: true });
  const two = f.start().data.trip;
  f.finish(two.id, { endOdometer: 106 });
  assert.throws(() => f.context.previewCancelLatestTrip_(one.id, 'テスト取消'), { driveLogCode: 'CANCEL_NOT_LATEST' });
  assert.equal(plain(f.context.previewCancelLatestTrip_(two.id, 'テスト取消')).restoredOdometer, 104);
  assert.equal(plain(f.context.cancelLatestTrip_(two.id, 'テスト取消')).restoredOdometer, 104);
  assert.equal(f.master.data[1][0], 104);
  assert.equal(f.call('vehicleContext', { vehicleId: one.vehicleId }).data.oil.baseline, 104);
  assert.equal(plain(f.context.cancelLatestTrip_(one.id, 'テスト取消')).restoredOdometer, 100);
  assert.equal(f.master.data[1][0], 100);
  const context = f.call('vehicleContext', { vehicleId: one.vehicleId }).data;
  assert.equal(context.startOdometer, 100);
  assert.equal(context.oil.baseline, 50);
  assert.deepEqual(f.call('listHistory', { vehicleId: one.vehicleId }).data.trips, []);
  assert.equal(f.ss.getSheetByName('_運転日報_記録管理').data.length, 3);
});

test('fully cleared test rows can still be cancelled from their committed finish journal', () => {
  const f = fixture({ initial: 100 });
  const trip = f.start().data.trip; f.finish(trip.id, { endOdometer: 104 });
  f.vehicle.data[1] = Array(HEADERS.length).fill('');
  f.master.data[1][0] = '';
  assert.equal(plain(f.context.previewCancelLatestTrip_(trip.id, '入力テスト取消')).restoredOdometer, 100);
  f.context.cancelLatestTrip_(trip.id, '入力テスト取消');
  assert.equal(f.master.data[1][0], 100);
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).data.startOdometer, 100);
});

test('cancellation refuses an active successor and conflicting nonblank row changes without writing', () => {
  const active = fixture(); const first = active.start().data.trip; active.finish(first.id);
  active.start();
  let before = active.writes.length;
  assert.throws(() => active.context.cancelLatestTrip_(first.id, '取消'), { driveLogCode: 'CANCEL_NOT_LATEST' });
  assert.equal(active.writes.length, before);
  const changed = fixture(); const trip = changed.start().data.trip; changed.finish(trip.id);
  changed.vehicle.data[1][HEADERS.indexOf('備考・不具合')] = '後で追記した大事な値';
  before = changed.writes.length;
  assert.throws(() => changed.context.cancelLatestTrip_(trip.id, '取消'), { driveLogCode: 'ROW_CONFLICT' });
  assert.equal(changed.writes.length, before);
  assert.equal(changed.cell('終了メーター(km)'), 120120);
});

test('cancellation checks manual visible successors and incomplete records outside the ledger', () => {
  for (const manual of ['completed', 'active', 'same-minute']) {
    const f = fixture(); const trip = f.start().data.trip; f.now += 3600000; f.finish(trip.id);
    const row = [...f.vehicle.data[1]];
    if (manual === 'completed') row[HEADERS.indexOf('終了時間')] = '11:00';
    if (manual === 'active') { row[HEADERS.indexOf('終了時間')] = ''; row[HEADERS.indexOf('終了メーター(km)')] = ''; }
    f.vehicle.data.push(row);
    const before = f.writes.length;
    assert.throws(() => f.context.cancelLatestTrip_(trip.id, '取消'), { driveLogCode: 'CANCEL_NOT_LATEST' });
    assert.equal(f.writes.length, before);
  }
});

test('cancellation recovers after visible clear, master update, ledger write and commit acknowledgement loss', () => {
  const failures = [
    { sheet: 'the gid is authoritative', row: 2, col: 1, after: true },
    { sheet: '社用車一覧', row: 2, col: 1, after: true },
    { sheet: '_運転日報_記録管理', row: 2, col: 1, after: true },
    { sheet: '_運転日報_リクエスト', row: 4, col: 4, after: true }
  ];
  for (const failure of failures) {
    const f = fixture({ typedSheets: true }); const trip = f.start().data.trip; f.now += 600000; f.finish(trip.id);
    f.fail = failure;
    assert.throws(() => f.context.cancelLatestTrip_(trip.id, '回復テスト'), /Simulated/);
    // Ordinary stateful reads recover a pending administrative operation too.
    const context = f.call('vehicleContext', { vehicleId: trip.vehicleId });
    assert.equal(context.ok, true, JSON.stringify(context));
    assert.equal(context.data.startOdometer, 120000);
    assert.equal(f.master.data[1][0], 120000);
    assert.ok(f.vehicle.data[1].slice(0, HEADERS.length).every(v => v === ''));
    assert.equal(f.call('getTrip', { tripId: trip.id }).error.code, 'TRIP_CANCELLED');
    assert.equal(f.ss.getSheetByName('_運転日報_リクエスト').data[3][3], 'committed');
    assert.equal(plain(f.context.cancelLatestTrip_(trip.id, '回復テスト')).restoredOdometer, 120000);
    assert.equal(f.ss.getSheetByName('_運転日報_リクエスト').data.length, 4);
  }
});

test('pending cancellation refuses subsequent row or baseline changes on recovery', () => {
  for (const field of ['row', 'baseline', 'manualSuccessor', 'master']) {
    const f = fixture(); const trip = f.start().data.trip; f.now += 3600000; f.finish(trip.id);
    f.fail = { sheet: 'the gid is authoritative', row: 2, col: 1 };
    assert.throws(() => f.context.cancelLatestTrip_(trip.id, '取消途中'), /Simulated/);
    if (field === 'row') f.vehicle.data[1][HEADERS.indexOf('備考・不具合')] = '別の編集';
    if (field === 'baseline') f.master.data[1][MASTER.indexOf('初回確認時の距離')] = 555;
    if (field === 'master') f.master.data[1][0] = 555;
    if (field === 'manualSuccessor') { const row = [...f.vehicle.data[1]]; row[HEADERS.indexOf('終了時間')] = '11:00'; f.vehicle.data.push(row); }
    const response = f.call('vehicleContext', { vehicleId: trip.vehicleId });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, field === 'row' ? 'ROW_CONFLICT' : field === 'manualSuccessor' ? 'CANCEL_NOT_LATEST' : 'CANCEL_STATE_CHANGED');
    assert.equal(JSON.parse(f.ss.getSheetByName('_運転日報_記録管理').data[1][3]).status, 'completed');
  }
});

test('old pending start or finish operations never resurrect a cancelled tombstone', () => {
  const f = fixture(); const trip = f.start({}, { requestId: 'tombstone-start' }).data.trip;
  f.finish(trip.id, {}, { requestId: 'tombstone-finish' });
  f.context.cancelLatestTrip_(trip.id, '取消済');
  const requests = f.ss.getSheetByName('_運転日報_リクエスト');
  requests.data[1][3] = 'pending'; requests.data[2][3] = 'pending';
  const context = f.call('vehicleContext', { vehicleId: trip.vehicleId });
  assert.equal(context.ok, true);
  assert.equal(context.data.startOdometer, 120000);
  assert.equal(requests.data[1][3], 'cancelled');
  assert.equal(requests.data[2][3], 'cancelled');
  assert.equal(f.start({}, { requestId: 'tombstone-start' }).error.code, 'TRIP_CANCELLED');
  assert.equal(f.finish(trip.id, {}, { requestId: 'tombstone-finish' }).error.code, 'TRIP_CANCELLED');
  assert.ok(f.vehicle.data[1].slice(0, HEADERS.length).every(v => v === ''));
});

test('administrative preview rejects unrelated pending writes and does not initialize helpers', () => {
  const empty = fixture();
  assert.throws(() => empty.context.previewCancelLatestTrip_('unknown-trip', '理由'), { driveLogCode: 'SCHEMA_ERROR' });
  assert.equal(empty.writes.length, 0);
  assert.equal(empty.sheets.length, 3);
  const f = fixture(); const trip = f.start().data.trip; f.finish(trip.id);
  f.ss.getSheetByName('_運転日報_リクエスト').data[1][3] = 'pending';
  const before = f.writes.length;
  assert.throws(() => f.context.previewCancelLatestTrip_(trip.id, '理由'), { driveLogCode: 'ADMIN_PENDING_REQUESTS' });
  assert.throws(() => f.context.cancelLatestTrip_(trip.id, '理由'), { driveLogCode: 'ADMIN_PENDING_REQUESTS' });
  assert.equal(f.writes.length, before);
});

function applyFleet(f, operation, payload, opts = {}) {
  const preview = f.admin('preview', operation, payload);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  return f.admin('apply', operation, payload, { expectedRevision: preview.data.expectedRevision, ...opts });
}

const NEW_CAR = { number: '架空500あ 22', model: 'プロボックス', fuelType: 'ガソリン', inspectionDue: '2028-02-29', initialOil: null, initialOdometer: 0, requiresClutch: false };

function legacyFleetPanel(f, inputs = {}) {
  const url = 'https://script.google.com/macros/s/test-admin-deployment/exec?view=fleet';
  const labels = { 1: '社用車 管理ツール', 2: '入力後、右の「内容を確認・実行」を押してください', 3: '運転中・保存中の車両は変更できません',
    4: '番号変更', 5: '対象車両', 6: '新しい車番', 9: '運用から外す', 10: '対象車両', 13: '運用に戻す', 14: '対象車両',
    17: '新規追加', 18: '車番', 19: '車種', 20: '燃料', 21: '車検満了日', 22: '初回オイル交換距離', 23: '初回確認時の距離', 24: '変速機 (AT/MT)' };
  Object.entries(labels).forEach(([row, value]) => f.master.getRange(Number(row), 10).setValue(value));
  for (const [row, operation] of [[4, 'rename'], [9, 'stop'], [13, 'restore'], [17, 'add']]) {
    f.master.getRange(row, 14).setValue(`=HYPERLINK("${url}&operation=${operation}","内容を確認・実行")`);
  }
  Object.entries(inputs).forEach(([row, value]) => f.master.getRange(Number(row), 11).setValue(value));
  return f.master.getRange(1, 10, 25, 7).getValues();
}

test('fleet RPC and admin HTML require Google self execution and edit permission before any mutation', () => {
  const f = fixture();
  for (const [active, effective, canEdit, code] of [
    ['', 'owner@example.invalid', true, 'UNAUTHORIZED'],
    ['other@example.invalid', 'owner@example.invalid', true, 'UNAUTHORIZED'],
    ['viewer@example.invalid', 'viewer@example.invalid', false, 'FORBIDDEN']
  ]) {
    Object.assign(f, { activeEmail: active, effectiveEmail: effective, canEdit });
    assert.equal(f.admin('bootstrap').error.code, code);
    assert.throws(() => f.context.doGet({ parameter: { view: 'fleet' } }), { driveLogCode: code });
    assert.equal(f.writes.length, 0);
  }
  Object.assign(f, { activeEmail: 'admin@example.invalid', effectiveEmail: 'admin@example.invalid', canEdit: true });
  const page = f.context.doGet({ parameter: { view: 'fleet' } });
  assert.equal(page.file, 'FleetAdminView');
  assert.equal(page.title, '車両管理');
  assert.equal(page.xFrameOptionsMode, undefined);
  assert.equal(f.call('fleetAdminRpc', { action: 'apply' }).error.code, 'VALIDATION_ERROR');
});

test('fleet installer preserves identity and baselines while isolated management inputs survive reruns', () => {
  const blocked = fixture(); blocked.ss.insertSheet('車両管理ツール').getRange(1, 1).setValue('既存の大事な資料');
  const before = blocked.writes.length;
  assert.throws(() => blocked.install(), { driveLogCode: 'PANEL_AREA_CONFLICT' });
  assert.equal(blocked.writes.length, before);
  const unrelated = fixture(); unrelated.master.getRange(8, 12).setValue('既存の別資料は移設対象外');
  const unrelatedBefore = unrelated.writes.length;
  assert.throws(() => unrelated.install(), { driveLogCode: 'PANEL_AREA_CONFLICT' });
  assert.equal(unrelated.writes.length, unrelatedBefore);
  assert.equal(unrelated.master.getRange(8, 12).getValue(), '既存の別資料は移設対象外');
  const f = fixture(); const trip = f.start().data.trip; f.finish(trip.id);
  assert.equal(f.install().installed, true);
  const panel = f.ss.getSheetByName('車両管理ツール');
  assert.ok(panel);
  assert.equal(panel.getIndex(), f.master.getIndex() + 1);
  const headers = f.master.data[0];
  assert.equal(f.master.data[1][headers.indexOf('車両ID')], trip.vehicleId);
  assert.equal(headers[16], '使用状況');
  assert.equal(headers[8], '変速機');
  assert.equal(f.master.data[1][MASTER.indexOf('初回確認時の距離')], 120000);
  assert.equal(f.master.data[1][MASTER.indexOf('初回確認時のオイル交換実施距離')], 116000);
  assert.equal(f.master.data[1][MASTER.indexOf('現在の距離')], 120120);
  assert.match(panel.getRange(11, 6).getFormulas()[0][0], /operation=stop/);
  panel.getRange(8, 3).setValue('テスト410え 8'); panel.getRange(9, 3).setValue('新しい車番');
  const columns = f.master.getLastColumn();
  f.install();
  assert.equal(f.master.getLastColumn(), columns);
  assert.equal(panel.getRange(9, 3).getValue(), '新しい車番');
  assert.deepEqual(panel.validations.get('8:3').values, ['テスト410え 8']);
  assert.equal(f.call('bootstrap').data.vehicles[0].id, trip.vehicleId);
  assert.equal(f.call('listHistory', { vehicleId: trip.vehicleId }).data.trips.length, 1);
});

test('fleet installer preserves Workspace-scoped links without pinning a browser account number', () => {
  const base = 'https://script.google.com/a/macros/workspace.example/s/test-admin-deployment/exec';
  for (const suffix of ['', '?view=fleet']) {
    const f = fixture();
    const result = plain(f.context.installFleetManagement_(base + suffix));
    assert.equal(result.adminUrl, base + '?view=fleet');
    const panel = f.ss.getSheetByName('車両管理ツール');
    for (const [row, column, operation, label] of [[11, 2, 'rename', '変更内容を確認'], [11, 6, 'stop', '外す車両を確認'], [20, 2, 'restore', '戻す車両を確認'], [25, 6, 'add', '登録内容を確認']]) {
      const formula = panel.getRange(row, column).getFormulas()[0][0];
      assert.equal(formula, `=HYPERLINK("${base}?view=fleet&operation=${operation}","${label}")`);
      assert.doesNotMatch(formula, /authuser=|\/u\/\d+\//);
    }
  }
  const rejected = fixture();
  for (const url of [base + '?view=fleet&authuser=2', 'https://script.google.com/macros/u/2/s/test-admin-deployment/exec', 'https://script.google.com.evil.example/macros/s/test-admin-deployment/exec']) {
    assert.throws(() => rejected.context.installFleetManagement_(url), { driveLogCode: 'VALIDATION_ERROR' });
  }
  assert.equal(rejected.writes.length, 0);
});

test('initial fleet installation preserves an active trip, its receipts and its original gid through completion', () => {
  const f = fixture();
  const started = f.start({}, { requestId: 'active-before-fleet-install' });
  const trip = started.data.trip;
  const ledgerBefore = plain(f.ss.getSheetByName('_運転日報_記録管理').data);
  const receiptsBefore = plain(f.ss.getSheetByName('_運転日報_リクエスト').data);
  const visibleBefore = plain(f.vehicle.data);
  assert.equal(f.install().installed, true);
  assert.deepEqual(plain(f.ss.getSheetByName('_運転日報_記録管理').data), ledgerBefore);
  assert.deepEqual(plain(f.ss.getSheetByName('_運転日報_リクエスト').data), receiptsBefore);
  assert.deepEqual(plain(f.vehicle.data), visibleBefore);
  assert.equal(f.master.data[1][f.master.data[0].indexOf('車両ID')], trip.vehicleId);
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).data.activeTrip.id, trip.id);
  assert.deepEqual(f.start({}, { requestId: 'active-before-fleet-install' }), started);
  assert.equal(f.admin('preview', 'rename', { vehicleId: trip.vehicleId, number: '架空400あ 33' }).error.code, 'VEHICLE_IN_USE');
  assert.equal(f.admin('preview', 'setStatus', { vehicleId: trip.vehicleId, active: false }).error.code, 'VEHICLE_IN_USE');
  const completed = f.finish(trip.id);
  assert.equal(completed.ok, true);
  assert.equal(completed.data.rowNumber, 2);
  assert.match(completed.data.sheetUrl, /gid=21$/);
});

test('fleet initial installation still rejects pending saves and mismatched active-trip destination gids', () => {
  const pending = fixture();
  pending.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
  assert.equal(pending.start().error.code, 'INTERNAL_ERROR');
  let before = pending.writes.length;
  assert.throws(() => pending.install(), { driveLogCode: 'VEHICLE_PENDING' });
  assert.equal(pending.writes.length, before);
  const mismatch = fixture(); mismatch.start();
  const ledger = mismatch.ss.getSheetByName('_運転日報_記録管理');
  const trip = JSON.parse(ledger.data[1][3]); trip.sheetId = 999999;
  ledger.data[1][3] = JSON.stringify(trip);
  before = mismatch.writes.length;
  assert.throws(() => mismatch.install(), { driveLogCode: 'SCHEMA_ERROR' });
  assert.equal(mismatch.writes.length, before);
});

test('fleet bootstrap and preview stay read-only and read all isolated panel inputs', () => {
  const f = fixture();
  assert.equal(f.admin('preview', 'rename', { vehicleId: 'テスト410え8', number: '架空400あ 9' }).error.code, 'FLEET_NOT_INSTALLED');
  f.install();
  const writes = f.writes.length;
  const boot = f.admin('bootstrap');
  assert.equal(boot.data.adminEmail, 'admin@example.invalid');
  assert.equal(boot.data.vehicles[0].active, true);
  assert.equal(boot.data.models.length, 5);
  assert.deepEqual(boot.data.panel, { rename: {}, stop: {}, restore: {}, add: {} });
  const preview = f.admin('preview', 'rename', { vehicleId: 'テスト410え8', number: '架空400あ 9' });
  assert.equal(preview.ok, true);
  assert.equal(preview.data.summary.previousNumber, 'テスト410え 8');
  assert.equal(typeof preview.data.expectedRevision, 'string');
  assert.equal(f.writes.length, writes);
  const sheet = f.ss.getSheetByName('車両管理ツール');
  sheet.getRange(8, 3).setValue('テスト410え　8'); sheet.getRange(9, 3).setValue('架空400あ 9');
  sheet.getRange(8, 7).setValue('テスト410え 8');
  for (const [row, value] of [[17, '架空500う 5'], [18, 'ハイゼット'], [19, '軽油'], [20, '2028-05-30'], [21, 0], [22, 10], [23, 'MT']]) sheet.getRange(row, 7).setValue(value);
  const data = f.admin('bootstrap').data;
  assert.match(data.managementUrl, new RegExp(`gid=${sheet.getSheetId()}$`));
  assert.deepEqual(data.panel.rename, { vehicleId: 'テスト410え8', number: '架空400あ 9' });
  assert.deepEqual(data.panel.stop, { vehicleId: 'テスト410え8', active: false });
  assert.deepEqual(data.panel.add, { number: '架空500う 5', model: 'ハイゼット', fuelType: '軽油', inspectionDue: '2028-05-30', initialOil: 0, initialOdometer: 10, requiresClutch: true });
  const retired = applyFleet(f, 'setStatus', { vehicleId: 'テスト410え8', active: false });
  assert.equal(retired.ok, true);
  sheet.getRange(17, 3).setValue('テスト410え 8');
  assert.deepEqual(f.admin('bootstrap').data.panel.restore, { vehicleId: 'テスト410え8', active: true });
});

test('legacy panel inputs remain readable before migration without writing to the workbook', () => {
  const f = fixture();
  legacyFleetPanel(f, { 5: 'テスト410え 8', 6: '架空400あ 17', 10: 'テスト410え 8',
    18: '架空500う 5', 19: 'ハイゼット', 20: '軽油', 21: '2028-05-30', 22: 0, 23: 10, 24: 'MT' });
  const writes = f.writes.length;
  const result = f.admin('bootstrap');
  assert.equal(result.ok, true);
  assert.equal(f.writes.length, writes);
  assert.deepEqual(result.data.panel.rename, { vehicleId: 'テスト410え8', number: '架空400あ 17' });
  assert.deepEqual(result.data.panel.stop, { vehicleId: 'テスト410え8', active: false });
  assert.equal(result.data.panel.add.initialOil, 0);
  assert.equal(result.data.panel.add.initialOdometer, 10);
  assert.equal(result.data.panel.add.requiresClutch, true);
  assert.equal(f.ss.getSheetByName('車両管理ツール'), null);
});

test('panel-only migration leaves master rows and active driving records completely unchanged', () => {
  const f = fixture(); const started = f.start({}, { requestId: 'active-before-panel-migration' }); f.install();
  f.sheets.splice(f.sheets.findIndex(sheet => sheet.name === '車両管理ツール'), 1);
  legacyFleetPanel(f, { 5: 'テスト410え 8', 6: '移設用の入力', 22: 0, 23: 0 });
  const preserved = new Map(f.sheets.map(sheet => [sheet.name, plain(sheet.data)]));
  const before = f.writes.length;
  f.context.migrateFleetManagementPanel_('https://script.google.com/macros/s/test-admin-deployment/exec');
  const panel = f.ss.getSheetByName('車両管理ツール');
  assert.ok(panel);
  assert.equal(panel.getRange(9, 3).getValue(), '移設用の入力');
  assert.equal(Array.from({ length: 9 }, (_, i) => panel.getColumnWidth(i + 1)).reduce((sum, width) => sum + width, 0), 710);
  for (const [name, data] of preserved) assert.deepEqual(plain(f.ss.getSheetByName(name).data), data, name);
  assert.ok(f.writes.slice(before).every(write => write.sheet === '車両管理ツール'));
  assert.equal(f.call('vehicleContext', { vehicleId: started.data.trip.vehicleId }).data.activeTrip.id, started.data.trip.id);
  assert.deepEqual(f.start({}, { requestId: 'active-before-panel-migration' }), started);
});

test('legacy panel migration copies every input and clears only its verified old range after explicit cleanup', () => {
  const f = fixture(); f.install();
  f.sheets.splice(f.sheets.findIndex(sheet => sheet.name === '車両管理ツール'), 1);
  const legacy = legacyFleetPanel(f, { 5: 'テスト410え 8', 6: '架空400あ 17', 10: 'テスト410え 8', 14: '停止車の入力も保持',
    18: '架空500う 5', 19: 'ハイゼット', 20: '軽油', 21: new Date('2028-05-30T00:00:00+09:00'), 22: 0, 23: 10, 24: 'MT' });
  const primary = plain(f.master.data.slice(0, 2).map(row => row.slice(0, MASTER.length)));
  f.context.migrateFleetManagementPanel_('https://script.google.com/macros/s/test-admin-deployment/exec');
  const sheet = f.ss.getSheetByName('車両管理ツール');
  for (const [row, col, value] of [[8, 3, 'テスト410え 8'], [9, 3, '架空400あ 17'], [8, 7, 'テスト410え 8'], [17, 3, '停止車の入力も保持'],
    [17, 7, '架空500う 5'], [18, 7, 'ハイゼット'], [19, 7, '軽油'], [21, 7, 0], [22, 7, 10], [23, 7, 'MT']]) {
    assert.equal(sheet.getRange(row, col).getValue(), value);
  }
  assert.equal(f.admin('bootstrap').data.panel.add.inspectionDue, '2028-05-30');
  assert.deepEqual(f.master.getRange(1, 10, 25, 7).getValues(), legacy, 'install must retain the complete original panel until explicit cleanup');
  assert.deepEqual(plain(f.master.data.slice(0, 2).map(row => row.slice(0, MASTER.length))), primary);
  const identity = f.master.data[1][f.master.data[0].indexOf('車両ID')];
  f.context.removeLegacyFleetPanel_();
  assert.ok(f.master.getRange(1, 10, 25, 7).getValues().every(row => row.every(value => value === '')));
  assert.equal(f.master.data[1][f.master.data[0].indexOf('車両ID')], identity);
  assert.equal(f.master.data[1][f.master.data[0].indexOf('使用状況')], '使用中');
  assert.deepEqual(plain(f.master.data.slice(0, 2).map(row => row.slice(0, MASTER.length))), primary);
  assert.equal(sheet.getRange(9, 3).getValue(), '架空400あ 17');
  f.install();
  assert.equal(sheet.getRange(9, 3).getValue(), '架空400あ 17');
});

test('migration never overwrites conflicting new inputs or clears unknown legacy content', () => {
  const f = fixture(); legacyFleetPanel(f, { 6: '旧入力' }); f.install();
  const sheet = f.ss.getSheetByName('車両管理ツール'); sheet.getRange(9, 3).setValue('新側で編集中');
  assert.throws(() => f.install());
  assert.equal(sheet.getRange(9, 3).getValue(), '新側で編集中');
  assert.equal(f.master.getRange(6, 11).getValue(), '旧入力');
  assert.throws(() => f.context.removeLegacyFleetPanel_());
  assert.equal(sheet.getRange(9, 3).getValue(), '新側で編集中');
  assert.equal(f.master.getRange(6, 11).getValue(), '旧入力');

  const unknown = fixture(); legacyFleetPanel(unknown, { 6: '保持対象の入力' }); unknown.master.getRange(8, 12).setValue('管理表と無関係な資料');
  const original = unknown.master.getRange(1, 10, 25, 7).getValues();
  const before = unknown.writes.length;
  assert.throws(() => unknown.install(), { driveLogCode: 'PANEL_AREA_CONFLICT' });
  assert.equal(unknown.writes.length, before);
  assert.throws(() => unknown.context.removeLegacyFleetPanel_());
  assert.deepEqual(unknown.master.getRange(1, 10, 25, 7).getValues(), original);
});

test('a lost migration write acknowledgement keeps the original inputs available for a safe retry', () => {
  const f = fixture(); legacyFleetPanel(f, { 5: 'テスト410え 8', 6: '再実行でも失わない', 22: 0, 23: 0 });
  const original = f.master.getRange(1, 10, 25, 7).getValues();
  f.fail = { sheet: '車両管理ツール', row: 9, col: 3, after: true };
  assert.throws(() => f.install());
  assert.deepEqual(f.master.getRange(1, 10, 25, 7).getValues(), original);
  assert.equal(f.install().installed, true);
  const sheet = f.ss.getSheetByName('車両管理ツール');
  assert.equal(sheet.getRange(9, 3).getValue(), '再実行でも失わない');
  assert.equal(sheet.getRange(21, 7).getValue(), 0);
  assert.equal(sheet.getRange(22, 7).getValue(), 0);
});

test('legacy cleanup retries after a lost acknowledgement and preserves an added blank-result formula', () => {
  const f = fixture(); legacyFleetPanel(f, { 6: '消去前に引き継ぐ', 22: 0, 23: 10 }); f.install();
  const panel = f.ss.getSheetByName('車両管理ツール');
  f.master.getRange(21, 11).setNumberFormat('yyyy-mm-dd');
  f.master.getRange(22, 11).setNumberFormat('0');
  f.master.getRange(23, 11).setNumberFormat('0');
  f.fail = { sheet: '社用車一覧', row: 1, col: 10, after: true };
  assert.throws(() => f.context.removeLegacyFleetPanel_());
  assert.ok(f.master.getRange(1, 10, 25, 7).getValues().every(row => row.every(value => value === '')));
  assert.equal(panel.getRange(9, 3).getValue(), '消去前に引き継ぐ');
  f.master.getRange(8, 12).setValue('=""');
  assert.throws(() => f.context.removeLegacyFleetPanel_(), { driveLogCode: 'PANEL_AREA_CONFLICT' });
  assert.equal(f.master.getRange(8, 12).getValue(), '');
  assert.equal(f.master.getRange(8, 12).getFormulas()[0][0], '=""');
  f.master.getRange(8, 12).setValue('');
  assert.equal(f.context.removeLegacyFleetPanel_().removed, true);
  assert.equal(f.master.getRange(21, 11).getNumberFormat(), 'General');
  assert.equal(f.master.getRange(22, 11).getNumberFormat(), 'General');
  assert.equal(f.master.getRange(23, 11).getNumberFormat(), 'General');
  assert.equal(panel.getRange(21, 7).getValue(), 0);
  assert.equal(panel.getRange(22, 7).getValue(), 10);
  assert.equal(f.context.removeLegacyFleetPanel_().removed, false);
});

test('legacy cleanup waits for a pending management save and preserves custom number formatting', () => {
  const f = fixture(); legacyFleetPanel(f); f.install();
  const payload = { vehicleId: 'テスト410え8', number: '架空400あ 83' };
  const preview = f.admin('preview', 'rename', payload);
  const opts = { expectedRevision: preview.data.expectedRevision, requestId: '77777777-7777-4777-8777-777777777777' };
  f.failRename = true;
  assert.equal(f.admin('apply', 'rename', payload, opts).error.code, 'FLEET_SAVE_PENDING');
  const before = f.writes.length;
  assert.throws(() => f.context.removeLegacyFleetPanel_(), { driveLogCode: 'VEHICLE_PENDING' });
  assert.equal(f.writes.length, before);
  assert.equal(f.master.getRange(1, 10).getValue(), '社用車 管理ツール');
  assert.equal(f.admin('apply', 'rename', payload, opts).ok, true);
  f.master.getRange(22, 11).setNumberFormat('0.00');
  assert.equal(f.context.removeLegacyFleetPanel_().removed, true);
  assert.equal(f.master.getRange(22, 11).getNumberFormat(), '0.00');
});

test('management sheet identity is reserved and cannot become a vehicle trip destination', () => {
  const f = fixture(); f.install();
  assert.equal(f.admin('preview', 'add', { ...NEW_CAR, number: '車両管理ツール' }).error.code, 'VALIDATION_ERROR');
  const sheet = f.ss.getSheetByName('車両管理ツール');
  f.master.getRange(2, MASTER.indexOf('運転日誌リンク') + 1).setValue(`=HYPERLINK("https://docs.google.com/spreadsheets/d/test/edit#gid=${sheet.getSheetId()}","運転日リンク")`);
  assert.equal(f.call('vehicleContext', { vehicleId: 'テスト410え8' }).error.code, 'SCHEMA_ERROR');
});

test('rename keeps stable ID, history, receipts and gid while new starts require the displayed current number', () => {
  const f = fixture();
  const first = f.start({}, { requestId: 'before-fleet-rename-start' });
  f.finish(first.data.trip.id); f.install();
  const id = first.data.trip.vehicleId, payload = { vehicleId: id, number: '架空400あ 99' };
  const renamed = applyFleet(f, 'rename', payload);
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.data.vehicle.id, id);
  assert.equal(renamed.data.vehicle.number, payload.number);
  assert.equal(f.vehicle.getName(), payload.number);
  assert.match(renamed.data.sheetUrl, /gid=21$/);
  assert.match(f.master.getRange(2, MASTER.indexOf('運転日誌リンク') + 1).getFormulas()[0][0], /gid=21/);
  assert.equal(f.master.data[1][0], 120120);
  assert.equal(f.call('listHistory', { vehicleId: id }).data.trips[0].vehicleNumber, first.data.trip.vehicleNumber);
  assert.deepEqual(f.start({}, { requestId: 'before-fleet-rename-start' }), first);
  assert.equal(f.start().error.code, 'VEHICLE_CHANGED');
  assert.equal(f.start({ expectedVehicleNumber: 'テスト410え 8' }).error.code, 'VEHICLE_CHANGED');
  assert.equal(f.start({ expectedVehicleNumber: '架空400あ　99' }).data.trip.startOdometer, 120120);
});

test('retiring and restoring a vehicle updates driver choices and server guards without deleting history', () => {
  const f = fixture(); const trip = f.start().data.trip; f.finish(trip.id); f.install();
  const panel = f.ss.getSheetByName('車両管理ツール'); panel.getRange(9, 3).setValue('保持する入力');
  const retired = applyFleet(f, 'setStatus', { vehicleId: trip.vehicleId, active: false });
  assert.equal(retired.ok, true, JSON.stringify(retired));
  assert.equal(retired.data.message, '運用から外しました。');
  assert.equal(f.call('bootstrap').data.vehicles.length, 0);
  assert.equal(f.admin('bootstrap').data.vehicles[0].active, false);
  assert.equal(f.start().error.code, 'VEHICLE_INACTIVE');
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).error.code, 'VEHICLE_INACTIVE');
  assert.equal(f.call('listHistory', { vehicleId: trip.vehicleId }).data.trips.length, 1);
  assert.deepEqual(panel.validations.get('17:3').values, ['テスト410え 8']);
  assert.equal(panel.getRange(9, 3).getValue(), '保持する入力');
  assert.equal(applyFleet(f, 'setStatus', { vehicleId: trip.vehicleId, active: true }).ok, true);
  assert.equal(f.call('bootstrap').data.vehicles.length, 1);
  assert.equal(f.start().ok, true);
});

test('manual inactive status on an active trip still allows context and completion', () => {
  const f = fixture(); f.install(); const trip = f.start().data.trip;
  f.master.data[1][f.master.data[0].indexOf('使用状況')] = '使用停止';
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).data.activeTrip.id, trip.id);
  assert.equal(f.finish(trip.id).ok, true);
  assert.equal(f.call('vehicleContext', { vehicleId: trip.vehicleId }).error.code, 'VEHICLE_INACTIVE');
});

test('fleet rejects active trips and pending trip writes before accepting a management journal', () => {
  for (const pending of [false, true]) {
    const f = fixture(); f.install();
    if (pending) f.fail = { sheet: '_運転日報_記録管理', row: 2, col: 1 };
    f.start(); const before = f.writes.length;
    const response = f.admin('preview', 'setStatus', { vehicleId: 'テスト410え8', active: false });
    assert.equal(response.error.code, pending ? 'VEHICLE_PENDING' : 'VEHICLE_IN_USE');
    assert.equal(f.writes.length, before);
    assert.equal(f.ss.getSheetByName('_運転日報_車両管理').data.length, 1);
  }
});

test('revision, duplicate numbers, illegal names and template data fail before journal acceptance', () => {
  const f = fixture(); f.install();
  const payload = { vehicleId: 'テスト410え8', number: '架空400あ 8' };
  const preview = f.admin('preview', 'rename', payload);
  f.master.data[1][0] = 54321;
  const before = f.writes.length;
  assert.equal(f.admin('apply', 'rename', payload, { expectedRevision: preview.data.expectedRevision }).error.code, 'REVISION_CONFLICT');
  assert.equal(f.writes.length, before);
  assert.equal(f.admin('preview', 'add', { ...NEW_CAR, number: 'テスト410え　8' }).error.code, 'DUPLICATE_VEHICLE_NUMBER');
  for (const number of ['bad/name', '=DANGEROUS()', '_運転日報_車両管理']) assert.equal(f.admin('preview', 'add', { ...NEW_CAR, number }).error.code, 'VALIDATION_ERROR');
  f.ss.insertSheet('架空500う 1');
  assert.equal(f.admin('preview', 'add', { ...NEW_CAR, number: '架空500う 1' }).error.code, 'SHEET_NAME_CONFLICT');
  f.ss.getSheetByName('運転日報ひな形').data.push(['2026-11-12']);
  assert.equal(f.admin('preview', 'add', NEW_CAR).error.code, 'SCHEMA_ERROR');
  assert.equal(f.ss.getSheetByName('_運転日報_車両管理').data.length, 1);
});

test('new vehicle copies the blank template, uses UUID identity and keeps zero versus unregistered oil', () => {
  const f = fixture(); f.install();
  assert.equal(f.admin('preview', 'add', { ...NEW_CAR, initialOdometer: null }).error.code, 'VALIDATION_ERROR');
  const result = applyFleet(f, 'add', { ...NEW_CAR, requiresClutch: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const vehicle = result.data.vehicle;
  assert.match(vehicle.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(vehicle.id, '架空500あ22');
  assert.equal(vehicle.initialOdometer, 0); assert.equal(vehicle.currentOdometer, 0); assert.equal(vehicle.initialOil, null);
  assert.equal(vehicle.requiresClutch, true);
  const sheet = f.ss.getSheetByName(NEW_CAR.number);
  assert.deepEqual(sheet.data[0], HEADERS);
  assert.equal(sheet.getLastRow(), 1);
  assert.match(result.data.sheetUrl, new RegExp(`gid=${sheet.id}$`));
  assert.equal(f.call('bootstrap').data.vehicles.length, 2);
  assert.equal(f.start({ vehicleId: vehicle.id }).error.code, 'VEHICLE_CHANGED');
  assert.equal(f.start({ vehicleId: vehicle.id, expectedVehicleNumber: vehicle.number }).error.code, 'VALIDATION_ERROR');
  const checks = Object.fromEntries(['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body', 'clutch'].map(key => [key, true]));
  assert.equal(f.start({ vehicleId: vehicle.id, expectedVehicleNumber: vehicle.number, checks }).data.trip.startOdometer, 0);
});

test('fleet apply replays its original response and binds immutable requests to their administrator', () => {
  const f = fixture(); f.install();
  const payload = { ...NEW_CAR };
  const preview = f.admin('preview', 'add', payload);
  const opts = { expectedRevision: preview.data.expectedRevision, requestId: '22222222-2222-4222-8222-222222222222' };
  const result = f.admin('apply', 'add', payload, opts);
  assert.equal(result.ok, true, JSON.stringify(result));
  const sheets = f.sheets.length, writes = f.writes.length;
  assert.deepEqual(f.admin('apply', 'add', payload, opts), result);
  assert.equal(f.sheets.length, sheets); assert.equal(f.writes.length, writes);
  assert.equal(f.admin('apply', 'add', { ...payload, number: '別の車番' }, opts).error.code, 'REQUEST_ID_REUSED');
  f.activeEmail = f.effectiveEmail = 'other-editor@example.invalid';
  assert.equal(f.admin('apply', 'add', payload, opts).error.code, 'REQUEST_ID_REUSED');
});

test('new-vehicle registration recovers lost acknowledgements without a duplicate sheet or master row', () => {
  for (const stage of ['insert', 'gid', 'rename', 'master', 'response', 'commit']) {
    const f = fixture(); f.install();
    const preview = f.admin('preview', 'add', NEW_CAR);
    const opts = { expectedRevision: preview.data.expectedRevision, requestId: '33333333-3333-4333-8333-333333333333' };
    const newRow = f.master.getLastRow() + 1;
    if (stage === 'insert') f.failInsert = true;
    if (stage === 'gid') f.fail = { sheet: '_運転日報_車両管理', row: 2, col: 5, after: true };
    if (stage === 'rename') f.failRename = true;
    if (stage === 'master') f.fail = { sheet: '社用車一覧', row: newRow, col: 1, after: true };
    if (stage === 'response') f.fail = { sheet: '_運転日報_車両管理', row: 2, col: 6, after: true };
    if (stage === 'commit') f.fail = { sheet: '_運転日報_車両管理', row: 2, col: 4, after: true };
    const first = f.admin('apply', 'add', NEW_CAR, opts);
    assert.equal(first.error?.code, 'FLEET_SAVE_PENDING', stage + JSON.stringify(first));
    const writes = f.writes.length;
    const boot = f.call('bootstrap');
    assert.equal(boot.ok, true, stage + JSON.stringify(boot));
    assert.equal(f.writes.length, writes, 'driver startup must not recover');
    if (stage !== 'commit') assert.equal(boot.data.vehicles.length, 1, 'pending new vehicle must stay private');
    const retry = f.admin('apply', 'add', NEW_CAR, opts);
    assert.equal(retry.ok, true, stage + JSON.stringify(retry));
    assert.equal(f.sheets.filter(sheet => sheet.name === NEW_CAR.number).length, 1);
    assert.equal(f.master.data.filter(row => row[f.master.data[0].indexOf('車両ID')] === retry.data.vehicle.id).length, 1);
    assert.equal(f.ss.getSheetByName('_運転日報_車両管理').data.length, 2);
  }
});

test('driver stateful access recovers pending rename and startup hides that target without writing', () => {
  const f = fixture(); f.install();
  const payload = { vehicleId: 'テスト410え8', number: '架空400あ 80' };
  const preview = f.admin('preview', 'rename', payload);
  const opts = { expectedRevision: preview.data.expectedRevision, requestId: '44444444-4444-4444-8444-444444444444' };
  f.failRename = true;
  assert.equal(f.admin('apply', 'rename', payload, opts).error.code, 'FLEET_SAVE_PENDING');
  const writes = f.writes.length;
  assert.equal(f.call('bootstrap').data.vehicles.length, 0);
  assert.equal(f.writes.length, writes);
  assert.equal(f.call('vehicleContext', { vehicleId: payload.vehicleId }).data.vehicle.number, payload.number);
  assert.equal(f.master.data[1][MASTER.indexOf('車番')], payload.number);
  assert.equal(f.admin('apply', 'rename', payload, opts).ok, true);
});

test('management recovery refuses changed meters rather than restoring the old form snapshot', () => {
  const f = fixture(); f.install();
  const payload = { vehicleId: 'テスト410え8', number: '架空400あ 81' };
  const preview = f.admin('preview', 'rename', payload);
  const opts = { expectedRevision: preview.data.expectedRevision, requestId: '55555555-5555-4555-8555-555555555555' };
  f.failRename = true; f.admin('apply', 'rename', payload, opts);
  f.master.data[1][0] = 999999;
  const retry = f.admin('apply', 'rename', payload, opts);
  assert.equal(retry.error.code, 'FLEET_SAVE_PENDING');
  assert.equal(retry.error.causeCode, 'ROW_CONFLICT');
  assert.equal(f.master.data[1][0], 999999);
  assert.equal(f.ss.getSheetByName('_運転日報_車両管理').data[1][3], 'pending');
});

test('an already accepted fleet request remains pending even when the master schema later breaks', () => {
  const f = fixture(); f.install();
  const payload = { vehicleId: 'テスト410え8', number: '架空400あ 82' };
  const preview = f.admin('preview', 'rename', payload);
  const opts = { expectedRevision: preview.data.expectedRevision, requestId: '66666666-6666-4666-8666-666666666666' };
  f.failRename = true;
  assert.equal(f.admin('apply', 'rename', payload, opts).error.code, 'FLEET_SAVE_PENDING');
  f.master.data[0][f.master.data[0].indexOf('車両ID')] = '管理列を手変更';
  const retry = f.admin('apply', 'rename', payload, opts);
  assert.equal(retry.error.code, 'FLEET_SAVE_PENDING');
  assert.equal(retry.error.commitState, 'pending');
  assert.equal(retry.error.causeCode, 'FLEET_NOT_INSTALLED');
});
