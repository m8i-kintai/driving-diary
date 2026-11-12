/**
 * 運転日報 API / Apps Script V8.
 * Script Properties (never put their real values in this source):
 *   SPREADSHEET_ID: driving-log workbook ID
 *   ACCESS_KEY: legacy invitation property; alone it cannot establish driver identity
 *   ALLOWED_ORIGINS: JSON array of exact frontend origins, e.g. ["https://example.github.io"]
 *   KINJIRO_VERIFY_URL: required, fixed server-side deviceVerify endpoint
 * Deploy as a web app executing as the owner. doGet exposes health only.
 * setup_ is a private, manually run initializer; do not run it against production as a preview.
 */
var DRIVE_LOG_ = Object.freeze({
  version: 1,
  master: '社用車一覧', template: '運転日報ひな形',
  trips: '_運転日報_記録管理', requests: '_運転日報_リクエスト',
  departments: ['ネットワーク1G', 'ネットワーク2G', '管理G', '技術G', '建設1G', '建設2G', '建設3G', '通信事業部', '保全G', '横浜営業所', '埼玉営業所', '大阪営業所', '広島営業所'],
  checks: ['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body'],
  tripHeaders: ['tripId', 'vehicleId', 'status', 'recordJson'],
  requestHeaders: ['requestId', 'action', 'fingerprint', 'state', 'operationJson', 'responseJson', 'createdAt']
});

var MASTER_SCHEMA_ = {
  number: ['車番', '車両番号'], model: ['車種'], fuel: ['種別', '種別(燃料)', '燃料', '燃料種別'],
  inspection: ['車検満了日'], initialOil: ['初回確認時のオイル交換実施距離'],
  initialOdometer: ['初回確認時の距離'], currentOdometer: ['現在の距離', '現在距離'],
  link: ['運転日誌リンク', '運転日報リンク', '運転日リンク']
};
var TRIP_SCHEMA_ = {
  date: ['日付', '月日'], weekday: ['曜日'], checks: ['運転前車両点検'],
  startTime: ['出発時間', '出発時間(運転前)'], endTime: ['終了時間', '終了時間(運転後)'],
  employee: ['運転者'], destination: ['行先', '行き先'],
  startOdometer: ['出発メーター(km)'], endOdometer: ['終了メーター(km)'],
  distance: ['走行距離(km)'], fuel: ['給油量(L)', '給油ℓ'], oil: ['オイル交換'],
  notes: ['備考・不具合', '備考(不具合等)', '備考'],
  beforeConfirmed: ['運転前対面確認者', '運転前確認'], beforeReading: ['運転前検知器結果(mg/L)'],
  afterConfirmed: ['運転後対面確認者', '運転後確認'], afterReading: ['運転後検知器結果(mg/L)'],
  presence: ['酒気帯び(有/無)'], instructions: ['指示事項']
};

function doGet() {
  return jsonOutput_({ ok: true, service: 'drive-log', version: DRIVE_LOG_.version });
}

function doPost(e) {
  var bridge = !!(e && e.parameter && e.parameter.transport === 'bridge');
  var origin = bridge ? String(e.parameter.origin || '') : '';
  if (bridge && !allowedOrigin_(origin)) {
    return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><p>この配布元は許可されていません。</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  var request, response;
  try {
    var raw = bridge ? e.parameter.payload : e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 24000) fail_('VALIDATION_ERROR', 'リクエストの形式を確認してください。');
    try { request = JSON.parse(raw); } catch (_) { fail_('VALIDATION_ERROR', '通信データがJSON形式ではありません。'); }
    response = processRequest_(request);
  } catch (err) {
    response = errorResponse_(err, request && request.requestId);
  }
  if (!bridge) return jsonOutput_(response);
  var nonce = String(e.parameter.nonce || '');
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(nonce)) {
    return HtmlService.createHtmlOutput('<!doctype html><p>通信識別子が無効です。</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  var message = { kind: 'DRIVE_LOG_RPC', requestId: response.requestId, nonce: nonce, response: response };
  var html = '<!doctype html><meta charset="utf-8"><script>window.top.postMessage(' +
    safeScriptJson_(message) + ',' + safeScriptJson_(origin) + ');</script>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function processRequest_(request) {
  try {
    validateEnvelope_(request);
    var auth = authenticate_(request);
    var payload = request.payload || {};
    // Startup and the legacy self-profile action never initialize helpers.
    if (request.action === 'bootstrap' || request.action === 'lookupEmployee') {
      var readData = request.action === 'bootstrap' ? {
        departments: DRIVE_LOG_.departments.slice(), vehicles: loadVehicles_(spreadsheet_()).map(publicVehicle_),
        serverTime: nowJst_(), employee: authenticatedEmployee_(auth)
      } : authenticatedEmployee_(auth, payload.employeeId);
      return { ok: true, data: readData, requestId: request.requestId };
    }
    var lock = LockService.getScriptLock();
    try { lock.waitLock(25000); } catch (_) { fail_('BUSY', '処理が混み合っています。同じ操作をもう一度お試しください。'); }
    try {
      var ss = spreadsheet_();
      var store = store_(ss);
      recoverPending_(ss, store);
      var mutating = request.action === 'startTrip' || request.action === 'finishTrip';
      var fingerprint = stableJson_({ action: request.action, payload: payload });
      if (mutating) {
        var previous = findRequest_(store.requests, request.requestId);
        if (previous) {
          if (previous.values[1] !== request.action || previous.values[2] !== fingerprint) {
            fail_('REQUEST_ID_REUSED', '同じ通信IDに異なる操作が指定されています。');
          }
          var receiptTrip = JSON.parse(previous.values[4]).trip;
          var receiptOwner = request.action === 'finishTrip' && !blank_(receiptTrip.completedByEmployeeId)
            ? receiptTrip.completedByEmployeeId : receiptTrip.employeeId;
          assertSubject_(auth, receiptOwner);
          requireTrip_(store, receiptTrip.id); // A cancelled receipt must never replay its old success.
          return JSON.parse(previous.values[5]);
        }
      }
      var data;
      switch (request.action) {
        case 'vehicleContext': data = vehicleContext_(ss, store, payload.vehicleId); break;
        case 'getTrip': data = { trip: publicTrip_(requireTrip_(store, payload.tripId)) }; break;
        case 'listHistory':
          var vehicle = requireVehicle_(ss, payload.vehicleId);
          data = { trips: allTrips_(store).filter(function (t) { return t.vehicleId === vehicle.id && t.status !== 'cancelled'; })
            .sort(function (a, b) { return b.startedAt.localeCompare(a.startedAt); }).map(publicTrip_) };
          break;
        case 'startTrip': return startTrip_(ss, store, request, auth, fingerprint);
        case 'finishTrip': return finishTrip_(ss, store, request, auth, fingerprint);
        default: fail_('VALIDATION_ERROR', '未対応の操作です。');
      }
      return { ok: true, data: data, requestId: request.requestId };
    } finally {
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
    }
  } catch (err) { return errorResponse_(err, request && request.requestId); }
}

function validateEnvelope_(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.version !== 1 ||
      !/^[A-Za-z0-9_.:-]{8,128}$/.test(String(r.requestId || '')) || typeof r.action !== 'string' ||
      (r.payload != null && (typeof r.payload !== 'object' || Array.isArray(r.payload)))) {
    fail_('VALIDATION_ERROR', '通信データの形式を確認してください。');
  }
}

function authenticate_(r) {
  var props = PropertiesService.getScriptProperties();
  // A shared invitation key cannot prove a person's name. Identity always comes
  // from the fixed Kinjiro verifier, never from URL names or request payloads.
  if (!r.kinjiro || typeof r.kinjiro !== 'object') fail_('UNAUTHORIZED', 'キンジロー君の運転日報ボタンから開き直してください。');
  var employeeId = normalizeId_(r.kinjiro.employeeId);
  var token = r.kinjiro.token;
  if (!employeeId || typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    fail_('UNAUTHORIZED', 'キンジロー君の認証情報を確認できません。');
  }
  var verifyUrl = props.getProperty('KINJIRO_VERIFY_URL') || '';
  if (!/^https:\/\//.test(verifyUrl)) fail_('CONFIGURATION_ERROR', 'キンジロー君認証の接続先が未設定です。');
  var cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  var cacheKey = 'drive-auth:v3:' + sha256_(verifyUrl + '\n' + employeeId + '\n' + token);
  if (cache) {
    try {
      var cached = JSON.parse(cache.get(cacheKey) || 'null');
      if (cached && cached.version === 1 && cached.employeeId === employeeId && validEmployeeName_(cached.employeeName)) {
        return { employeeId: cached.employeeId, employeeName: cached.employeeName };
      }
    } catch (_) { /* A missing/old/invalid profile must be verified again. */ }
  }
  var verified;
  try {
    var result = UrlFetchApp.fetch(verifyUrl, {
      method: 'post', contentType: 'text/plain', muteHttpExceptions: true, followRedirects: true,
      payload: JSON.stringify({ requestType: 'deviceVerify', empId: employeeId, token: token })
    });
    if (result.getResponseCode() < 200 || result.getResponseCode() >= 300) throw new Error('verify-http');
    verified = JSON.parse(result.getContentText());
  } catch (_) { fail_('KINJIRO_VERIFICATION_UNAVAILABLE', 'キンジロー君の確認に接続できません。少し待って再度お試しください。'); }
  if (!verified || verified.status === 'invalid' || verified.status === 'notfound' ||
      verified.status === 'error' && ['invalid', 'notfound'].indexOf(verified.code) >= 0) {
    fail_('KINJIRO_SESSION_EXPIRED', 'キンジロー君で認証を更新してから開き直してください。');
  }
  if (verified.status !== 'ok') fail_('KINJIRO_VERIFICATION_UNAVAILABLE', 'キンジロー君の確認結果を取得できません。');
  var returnedId = verified.empId;
  if (!(typeof returnedId === 'string' || typeof returnedId === 'number' && isFinite(returnedId) && Math.floor(returnedId) === returnedId) ||
      !normalizeId_(returnedId) || normalizeId_(returnedId) !== employeeId) {
    fail_('UNAUTHORIZED', 'キンジロー君の社員番号を確認できません。');
  }
  if (!validEmployeeName_(verified.empName)) fail_('UNAUTHORIZED', 'キンジロー君で本人の氏名を確認できません。管理者に確認してください。');
  var identity = { employeeId: employeeId, employeeName: verified.empName };
  if (cache) cache.put(cacheKey, JSON.stringify({ version: 1, employeeId: identity.employeeId, employeeName: identity.employeeName }), 120);
  return identity;
}

function startTrip_(ss, store, request, auth, fingerprint) {
  var p = request.payload || {};
  var employee = authenticatedEmployee_(auth, p.employeeId);
  var vehicle = requireVehicle_(ss, p.vehicleId);
  if (activeTrip_(store, vehicle.id)) fail_('VEHICLE_IN_USE', 'この車両は運転中です。先の運転を終了してください。');
  var state = vehicleState_(ss, vehicle, store);
  if (state.latestEnd === null && vehicle.initialOdometer === null) fail_('INITIAL_ODOMETER_REQUIRED', 'この車両の初回確認時の距離を管理者が登録してから開始してください。');
  if (DRIVE_LOG_.departments.indexOf(p.department) < 0) fail_('VALIDATION_ERROR', '稼働部門を選択してください。');
  var required = DRIVE_LOG_.checks.concat(vehicle.requiresClutch ? ['clutch'] : []);
  if (!p.checks || required.some(function (key) { return p.checks[key] !== true; })) fail_('VALIDATION_ERROR', 'すべての対象点検を確認してください。');
  var before = alcohol_(p.before);
  // Applies only to new starts. Previously persisted requests recover/replay
  // before entering this handler so historical operations remain recoverable.
  if (before.presence !== '無') fail_('ALCOHOL_PRESENT', '酒気帯びが「有」のため出発できません。');
  var startedAt = nowJst_();
  var trip = {
    id: Utilities.getUuid(), vehicleId: vehicle.id, vehicleNumber: vehicle.number, model: vehicle.model, modelKey: vehicle.modelKey,
    employeeId: employee.id, employeeName: employee.name, department: p.department,
    startedAt: startedAt, startOdometer: state.latestEnd === null ? vehicle.initialOdometer : state.latestEnd,
    before: before, status: 'active', completedAt: null, endOdometer: null, distance: null,
    sheetId: state.sheet.getSheetId(), rowNumber: Math.max(state.sheet.getLastRow() + 1, state.table.headerRow + 1),
    startRequestId: request.requestId
  };
  var fields = blankTripFields_();
  fields.date = startedAt.slice(0, 10);
  fields.weekday = japaneseWeekday_(startedAt.slice(0, 10));
  fields.checks = 'OK'; fields.startTime = startedAt.slice(11, 16); fields.employee = safeCellText_(employee.name);
  fields.startOdometer = trip.startOdometer;
  fields.beforeConfirmed = before.confirmed ? 'OK' : '';
  fields.beforeReading = before.reading === null ? '' : before.reading;
  fields.presence = before.presence;
  var response = { ok: true, data: { trip: publicTrip_(trip) }, requestId: request.requestId };
  var operation = { kind: 'start', trip: trip, fields: fields, previousFields: blankTripFields_() };
  commitOperation_(ss, store, request, fingerprint, operation, response);
  return response;
}

function finishTrip_(ss, store, request, auth, fingerprint) {
  var p = request.payload || {};
  var completedBy = authenticatedEmployee_(auth);
  var trip = requireTrip_(store, p.tripId);
  if (trip.status !== 'active') fail_('TRIP_ALREADY_COMPLETED', 'この運転は終了済みです。履歴を確認してください。');
  var completedDepartment = trip.department;
  if (p.department !== undefined) {
    if (DRIVE_LOG_.departments.indexOf(p.department) < 0) fail_('VALIDATION_ERROR', '稼働部門を選択してください。');
    completedDepartment = p.department;
  }
  var end = numeric_(p.endOdometer, '終了メーター', false);
  if (end < trip.startOdometer) fail_('ODOMETER_DECREASE', '終了メーターは出発メーター以上にしてください。');
  var destination = text_(p.destination, '行先', 300, true);
  var notes = text_(p.notes == null ? '' : p.notes, '備考・不具合', 2000, false);
  if (typeof p.refueled !== 'boolean' || typeof p.oilChanged !== 'boolean') fail_('VALIDATION_ERROR', '給油・オイル交換の確認状態が不正です。');
  var fuel = p.refueled ? numeric_(p.fuelLiters, '給油量', false) : null;
  if (p.refueled && fuel <= 0) fail_('VALIDATION_ERROR', '給油量は0より大きい数値を入力してください。');
  var after = alcohol_(p.after);
  var sheet = sheetById_(ss, trip.sheetId);
  if (!sheet) fail_('SCHEMA_ERROR', '記録先シートが見つかりません。管理者に確認してください。');
  var table = table_(sheet, TRIP_SCHEMA_);
  var previousFields = rowFields_(sheet, table, trip.rowNumber);
  var original = {
    date: trip.startedAt.slice(0, 10), startTime: trip.startedAt.slice(11, 16),
    employee: safeCellText_(trip.employeeName), startOdometer: trip.startOdometer, checks: 'OK'
  };
  if (Object.keys(original).some(function (key) { return !sameCell_(previousFields[key], original[key]); }) ||
      !blank_(previousFields.endTime) || !blank_(previousFields.endOdometer)) {
    fail_('ROW_CONFLICT', '開始時の記録行が移動または変更されています。管理者に確認してください。');
  }
  var fields = Object.assign({}, previousFields);
  trip.status = 'completed'; trip.completedAt = nowJst_(); trip.endOdometer = end;
  trip.distance = Math.round((end - trip.startOdometer) * 1000000) / 1000000;
  trip.after = after; trip.destination = destination; trip.fuelLiters = fuel;
  trip.oilChanged = p.oilChanged; trip.notes = notes; trip.finishRequestId = request.requestId;
  trip.completedByEmployeeId = completedBy.id; trip.completedByEmployeeName = completedBy.name;
  trip.completedDepartment = completedDepartment;
  fields.employee = safeCellText_(recordedDriverName_(trip));
  fields.endTime = trip.completedAt.slice(11, 16); fields.destination = safeCellText_(destination);
  fields.endOdometer = end; fields.distance = trip.distance; fields.fuel = fuel === null ? '' : fuel;
  fields.oil = p.oilChanged ? '実施' : ''; fields.notes = safeCellText_(notes);
  fields.afterConfirmed = after.confirmed ? 'OK' : ''; fields.afterReading = after.reading === null ? '' : after.reading;
  fields.presence = trip.before.presence === '有' || after.presence === '有' ? '有' : '無'; fields.instructions = '';
  var response = { ok: true, data: { trip: publicTrip_(trip), rowNumber: trip.rowNumber,
    sheetUrl: sheetUrl_(ss, trip.sheetId) }, requestId: request.requestId };
  commitOperation_(ss, store, request, fingerprint, { kind: 'finish', trip: trip, fields: fields, previousFields: previousFields }, response);
  return response;
}

// Owner-only administration. These private helpers are deliberately absent from
// doPost. Use a temporary editor-only owner wrapper, inspect the preview first,
// and remove the wrapper before deploying. No physical rows are deleted.
function previewCancelLatestTrip_(tripId, reason) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = spreadsheet_(), store = existingStore_(ss);
    assertNoPendingAdmin_(store);
    return cancellationPlan_(ss, store, tripId, reason).summary;
  } finally { lock.releaseLock(); }
}

function cancelLatestTrip_(tripId, reason) {
  var id = text_(tripId, '取消対象の記録ID', 128, true);
  var cancellationReason = text_(reason, '取消理由', 2000, true);
  var requestId = 'admin-cancel:' + id;
  var fingerprint = stableJson_({ tripId: id, reason: cancellationReason });
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = spreadsheet_(), store = existingStore_(ss);
    var previous = findRequest_(store.requests, requestId);
    if (previous) {
      if (previous.values[1] !== 'adminCancelTrip' || previous.values[2] !== fingerprint) {
        fail_('REQUEST_ID_REUSED', 'この記録の取消操作は別の理由で保存されています。管理記録を確認してください。');
      }
      assertNoPendingAdmin_(store, requestId);
      if (previous.values[3] === 'pending') {
        applyOperation_(ss, store, JSON.parse(previous.values[4]));
        SpreadsheetApp.flush();
        store.requests.getRange(previous.row, 4).setValue('committed');
        SpreadsheetApp.flush();
      } else if (previous.values[3] !== 'committed') {
        fail_('CANCEL_UNSAFE', '取消操作の状態を管理者が確認してください。');
      }
      return JSON.parse(previous.values[5]).data;
    }
    assertNoPendingAdmin_(store);
    var plan = cancellationPlan_(ss, store, id, cancellationReason);
    var response = { ok: true, data: plan.summary, requestId: requestId };
    commitOperation_(ss, store, { requestId: requestId, action: 'adminCancelTrip' }, fingerprint, plan.operation, response);
    return plan.summary;
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

// Reading an administrative preview must not create or hide helper sheets.
function existingStore_(ss) {
  var result = {};
  [['trips', DRIVE_LOG_.trips, DRIVE_LOG_.tripHeaders], ['requests', DRIVE_LOG_.requests, DRIVE_LOG_.requestHeaders]].forEach(function (entry) {
    var sheet = ss.getSheetByName(entry[1]);
    if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, entry[2].length).getValues()[0]) !== JSON.stringify(entry[2])) {
      fail_('SCHEMA_ERROR', '取消前に管理シートの存在と見出しを確認してください。');
    }
    result[entry[0]] = sheet;
  });
  return result;
}

function assertNoPendingAdmin_(store, allowedRequestId) {
  var count = store.requests.getLastRow() - 1;
  if (count > 0 && store.requests.getRange(2, 1, count, 4).getValues().some(function (row) {
    return row[3] === 'pending' && row[0] !== allowedRequestId;
  })) fail_('ADMIN_PENDING_REQUESTS', '未完了の保存処理があります。先に通常の保存回復を確認してください。');
}

function cancellationPlan_(ss, store, tripId, reason) {
  var id = text_(tripId, '取消対象の記録ID', 128, true);
  var cancellationReason = text_(reason, '取消理由', 2000, true);
  var trip = requireTrip_(store, id);
  if (trip.status !== 'completed') fail_('CANCEL_UNSAFE', '完了済みの最新記録だけを取り消せます。');
  var vehicle = requireVehicle_(ss, trip.vehicleId);
  var sheet = sheetById_(ss, trip.sheetId);
  if (!sheet || resolveVehicleSheet_(ss, vehicle).getSheetId() !== trip.sheetId) fail_('SCHEMA_ERROR', '取消対象の車両シートを確認してください。');
  var table = table_(sheet, TRIP_SCHEMA_);
  var finish = committedFinish_(store, trip);
  if (stableJson_(finish.operation.trip) !== stableJson_(trip)) fail_('CANCEL_UNSAFE', '管理記録と完了時の保存内容が一致しません。');
  var expected = canonicalTripFields_(finish.operation.fields, sheetTimeZone_(sheet));
  var visible = rowFields_(sheet, table, trip.rowNumber);
  Object.keys(TRIP_SCHEMA_).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(expected, key) || !blank_(visible[key]) && !sameCell_(visible[key], expected[key])) {
      fail_('ROW_CONFLICT', '取消対象の記録行に完了時と異なる値があります。管理者に確認してください。');
    }
  });
  assertCancellationLatest_(ss, store, trip, finish.row);
  var remaining = vehicleState_(ss, vehicle, store, trip);
  var restored = remaining.latestEnd === null ? vehicle.initialOdometer : remaining.latestEnd;
  var cancelled = Object.assign({}, trip, { status: 'cancelled', cancelledAt: nowJst_(), cancellationReason: cancellationReason,
    cancelRequestId: 'admin-cancel:' + trip.id });
  var summary = { tripId: trip.id, vehicleId: trip.vehicleId, vehicleNumber: trip.vehicleNumber,
    sheetId: trip.sheetId, rowNumber: trip.rowNumber, sheetUrl: sheetUrl_(ss, trip.sheetId),
    startedAt: trip.startedAt, completedAt: trip.completedAt, startOdometer: trip.startOdometer,
    endOdometer: trip.endOdometer, distance: trip.distance, recordedDriverName: recordedDriverName_(trip),
    reason: cancellationReason, restoredOdometer: restored, visibleFields: visible, committedFields: expected };
  return { summary: summary, operation: { kind: 'cancel', trip: cancelled, fields: blankTripFields_(), previousFields: expected,
    restoredOdometer: restored, finishJournalRow: finish.row,
    backup: { trip: trip, visibleFields: visible, masterCurrentOdometer: vehicle.currentOdometer,
      finishRequest: finish.values.slice() } } };
}

function committedFinish_(store, trip) {
  var receipt = findRequest_(store.requests, trip.finishRequestId);
  if (!receipt || receipt.values[1] !== 'finishTrip' || receipt.values[3] !== 'committed') fail_('CANCEL_UNSAFE', '確定済みの完了保存履歴が見つかりません。');
  var operation = JSON.parse(receipt.values[4]);
  if (operation.kind !== 'finish' || operation.trip.id !== trip.id || operation.trip.status !== 'completed') fail_('CANCEL_UNSAFE', '完了保存履歴と取消対象が一致しません。');
  return { row: receipt.row, values: receipt.values, operation: operation };
}

function assertCancellationLatest_(ss, store, trip, finishJournalRow) {
  var started = Date.parse(trip.startedAt), completed = Date.parse(trip.completedAt);
  if (!isFinite(started) || !isFinite(completed)) fail_('CANCEL_UNSAFE', '取消対象の日時を確認してください。');
  allTrips_(store).forEach(function (other) {
    if (other.id === trip.id || other.vehicleId !== trip.vehicleId || other.status === 'cancelled') return;
    if (other.status !== 'completed') fail_('CANCEL_NOT_LATEST', 'この車両に運転中または状態不明の記録があります。');
    var otherStarted = Date.parse(other.startedAt), otherCompleted = Date.parse(other.completedAt);
    if (!isFinite(otherStarted) || !isFinite(otherCompleted)) fail_('CANCEL_UNSAFE', '同じ車両の既存記録の日時を確認してください。');
    if (otherStarted > started || otherCompleted > completed ||
        otherCompleted === completed && committedFinish_(store, other).row > finishJournalRow) {
      fail_('CANCEL_NOT_LATEST', '後続の運転記録があります。最新の記録から取り消してください。');
    }
  });
  // Visible manual records have no ledger. Check them independently, and refuse
  // ambiguous same-minute records instead of guessing an ordering from row order.
  var sheet = sheetById_(ss, trip.sheetId), table = table_(sheet, TRIP_SCHEMA_);
  var count = sheet.getLastRow() - table.headerRow;
  for (var i = 0; i < count; i++) {
    var rowNumber = table.headerRow + 1 + i;
    if (rowNumber === trip.rowNumber) continue;
    var fields = rowFields_(sheet, table, rowNumber);
    if (Object.keys(fields).every(function (key) { return blank_(fields[key]); })) continue;
    if (blank_(fields.date) || blank_(fields.startTime) || blank_(fields.endTime) || blank_(fields.endOdometer)) {
      fail_('CANCEL_NOT_LATEST', '車両シートに未完了または日時不明の別記録があります。');
    }
    var startClock = clockMilliseconds_(fields.startTime), endClock = clockMilliseconds_(fields.endTime);
    var stamp = Date.parse(fields.date + 'T00:00:00+09:00') + endClock + (endClock < startClock ? 86400000 : 0);
    if (!isFinite(stamp) || stamp >= Math.floor(completed / 60000) * 60000) {
      // A matching earlier app record has an exact ledger instant, unlike a
      // manual same-minute row. This also permits rapid successive test trips.
      var managedEarlier = allTrips_(store).filter(function (t) {
        return t.id !== trip.id && t.vehicleId === trip.vehicleId && t.status === 'completed' &&
          t.sheetId === trip.sheetId && t.rowNumber === rowNumber && Date.parse(t.completedAt) <= completed;
      }).some(function (t) {
        var finish = committedFinish_(store, t);
        var expected = canonicalTripFields_(finish.operation.fields, sheetTimeZone_(sheet));
        return finish.row < finishJournalRow && Object.keys(TRIP_SCHEMA_).every(function (key) { return sameCell_(fields[key], expected[key]); });
      });
      if (!managedEarlier) fail_('CANCEL_NOT_LATEST', '車両シートに後続または前後関係が不明な記録があります。');
    }
  }
}

function validateCancellationApply_(ss, store, operation, existing) {
  var original = operation.backup && operation.backup.trip;
  if (!original || !existing || existing.id !== original.id ||
      existing.status !== 'cancelled' && stableJson_(existing) !== stableJson_(original) ||
      existing.status === 'cancelled' && existing.cancelRequestId !== operation.trip.cancelRequestId) {
    fail_('CANCEL_UNSAFE', '取消対象の管理記録が変更されています。');
  }
  assertCancellationLatest_(ss, store, original, operation.finishJournalRow);
  var vehicle = requireVehicle_(ss, original.vehicleId);
  var remaining = vehicleState_(ss, vehicle, store, original);
  var restored = remaining.latestEnd === null ? vehicle.initialOdometer : remaining.latestEnd;
  if (restored !== operation.restoredOdometer) fail_('CANCEL_STATE_CHANGED', '取消後の距離基準が変更されています。再確認してください。');
  if (vehicle.currentOdometer !== null && vehicle.currentOdometer !== operation.backup.masterCurrentOdometer && vehicle.currentOdometer !== restored) {
    fail_('CANCEL_STATE_CHANGED', '社用車一覧の現在距離が変更されています。再確認してください。');
  }
}

// Write-ahead journal: reserve the exact row before writing the visible sheet.
// Stateful reads and mutations recover pending operations under the same lock.
function commitOperation_(ss, store, request, fingerprint, operation, response) {
  var row = store.requests.getLastRow() + 1;
  var values = [request.requestId, request.action, fingerprint, 'pending', JSON.stringify(operation), JSON.stringify(response), nowJst_()];
  store.requests.getRange(row, 1, 1, values.length).setValues([values]);
  SpreadsheetApp.flush();
  applyOperation_(ss, store, operation);
  SpreadsheetApp.flush();
  store.requests.getRange(row, 4).setValue('committed');
  SpreadsheetApp.flush();
}

function recoverPending_(ss, store) {
  var count = store.requests.getLastRow() - 1;
  if (count <= 0) return;
  var statuses = store.requests.getRange(2, 4, count, 1).getValues();
  statuses.forEach(function (entry, index) {
    if (entry[0] !== 'pending') return;
    var row = index + 2;
    var operation = JSON.parse(store.requests.getRange(row, 5).getValue());
    var existing = allTrips_(store).filter(function (t) { return t.id === operation.trip.id; })[0];
    if (operation.kind !== 'cancel' && existing && existing.status === 'cancelled') {
      store.requests.getRange(row, 4).setValue('cancelled');
      SpreadsheetApp.flush();
      return;
    }
    applyOperation_(ss, store, operation);
    SpreadsheetApp.flush();
    store.requests.getRange(row, 4).setValue('committed');
    SpreadsheetApp.flush();
  });
}

function applyOperation_(ss, store, operation) {
  var trip = operation.trip;
  var existing = allTrips_(store).filter(function (t) { return t.id === trip.id; })[0];
  if (operation.kind !== 'cancel' && existing && existing.status === 'cancelled') fail_('TRIP_CANCELLED', 'この運転記録は管理者により取り消されています。車両を選び直してください。');
  if (operation.kind === 'cancel') validateCancellationApply_(ss, store, operation, existing);
  var sheet = sheetById_(ss, trip.sheetId);
  if (!sheet) fail_('SCHEMA_ERROR', '記録先シートが見つかりません。管理者に確認してください。');
  var table = table_(sheet, TRIP_SCHEMA_);
  var timeZone = sheetTimeZone_(sheet);
  var current = rowFields_(sheet, table, trip.rowNumber);
  var desired = canonicalTripFields_(operation.fields, timeZone);
  var previous = canonicalTripFields_(operation.previousFields, timeZone);
  Object.keys(desired).forEach(function (key) {
    if (!sameCell_(current[key], desired[key]) && !sameCell_(current[key], previous[key])) {
      fail_('ROW_CONFLICT', '記録行が変更されています。管理者に確認してください。');
    }
  });
  // Only the 19 known fields are touched; unrelated extra columns are preserved.
  var columns = Object.keys(desired).map(function (key) { return { column: table.map[key] + 1, value: desired[key] }; })
    .sort(function (a, b) { return a.column - b.column; });
  var run = [];
  function flushRun() {
    if (run.length) sheet.getRange(trip.rowNumber, run[0].column, 1, run.length).setValues([run.map(function (x) { return x.value; })]);
    run = [];
  }
  columns.forEach(function (entry) {
    if (run.length && entry.column !== run[run.length - 1].column + 1) flushRun();
    run.push(entry);
  });
  flushRun();
  [table.map.beforeReading, table.map.afterReading].forEach(function (col) { sheet.getRange(trip.rowNumber, col + 1).setNumberFormat('0.00'); });
  if (operation.kind === 'finish') {
    var vehicle = requireVehicle_(ss, trip.vehicleId);
    vehicle.masterSheet.getRange(vehicle.masterRow, vehicle.masterMap.currentOdometer + 1).setValue(trip.endOdometer);
  } else if (operation.kind === 'cancel') {
    var restoredVehicle = requireVehicle_(ss, trip.vehicleId);
    restoredVehicle.masterSheet.getRange(restoredVehicle.masterRow, restoredVehicle.masterMap.currentOdometer + 1)
      .setValue(operation.restoredOdometer === null ? '' : operation.restoredOdometer);
  }
  saveTrip_(store, trip);
}

function vehicleContext_(ss, store, id) {
  var vehicle = requireVehicle_(ss, id);
  var state = vehicleState_(ss, vehicle, store);
  var start = state.latestEnd === null ? vehicle.initialOdometer : state.latestEnd;
  var current = state.latestEnd === null ? vehicle.initialOdometer : state.latestEnd;
  var oil = oilState_(vehicle.fuelType, state.latestOil === null ? vehicle.initialOil : state.latestOil, current);
  var v = publicVehicle_(vehicle); v.currentOdometer = current;
  return { vehicle: v, activeTrip: publicTrip_(activeTrip_(store, vehicle.id)), oil: oil,
    warnings: warnings_(vehicle, oil, nowJst_().slice(0, 10)), startOdometer: start };
}

function vehicleState_(ss, vehicle, store, excludedTrip) {
  var sheet = resolveVehicleSheet_(ss, vehicle);
  var table = table_(sheet, TRIP_SCHEMA_);
  var timeZone = sheetTimeZone_(sheet);
  var latest = null, latestOilRecord = null;
  function consider(stamp, end, oil) {
    if (!isFinite(stamp)) fail_('SCHEMA_ERROR', '既存の完了記録の日時を確認してください。');
    if (!latest || stamp > latest.stamp || stamp === latest.stamp && end > latest.end) latest = { stamp: stamp, end: end };
    if (oil && (!latestOilRecord || stamp > latestOilRecord.stamp || stamp === latestOilRecord.stamp && end > latestOilRecord.end)) {
      latestOilRecord = { stamp: stamp, end: end };
    }
  }
  // The ledger has the actual completion instant, including trips lasting >24 h.
  allTrips_(store).forEach(function (trip) {
    if (trip.vehicleId !== vehicle.id || trip.status !== 'completed' || excludedTrip && trip.id === excludedTrip.id) return;
    if (typeof trip.completedAt !== 'string' || !trip.completedAt) fail_('SCHEMA_ERROR', '管理用の完了日時を確認してください。');
    consider(Date.parse(trip.completedAt), numeric_(trip.endOdometer, '既存の終了メーター', false), trip.oilChanged === true);
  });
  var count = sheet.getLastRow() - table.headerRow;
  if (count > 0) {
    var rows = sheet.getRange(table.headerRow + 1, 1, count, table.width).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (excludedTrip && excludedTrip.sheetId === sheet.getSheetId() && excludedTrip.rowNumber === table.headerRow + 1 + i) continue;
      var row = rows[i];
      if (blank_(row[table.map.endTime]) || blank_(row[table.map.endOdometer])) continue;
      var end = numeric_(row[table.map.endOdometer], '既存の終了メーター', false);
      var day = canonicalTripField_('date', row[table.map.date], timeZone);
      if (!day) fail_('SCHEMA_ERROR', '既存の完了記録に日付がありません。');
      var startClock = clockMilliseconds_(canonicalTripField_('startTime', row[table.map.startTime], timeZone));
      var endClock = clockMilliseconds_(canonicalTripField_('endTime', row[table.map.endTime], timeZone));
      var stamp = Date.parse(day + 'T00:00:00+09:00') + endClock;
      if (endClock < startClock) stamp += 86400000;
      consider(stamp, end, /^(実施|済|交換|○|〇|true|1)$/i.test(String(row[table.map.oil]).trim()));
    }
  }
  return { sheet: sheet, table: table, latestEnd: latest ? latest.end : null, latestOil: latestOilRecord ? latestOilRecord.end : null };
}

function clockMilliseconds_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    var date = new Date(value.getTime() + 9 * 3600000);
    return ((date.getUTCHours() * 60 + date.getUTCMinutes()) * 60 + date.getUTCSeconds()) * 1000;
  }
  if (typeof value === 'number' && isFinite(value) && value >= 0 && value < 1) return Math.round(value * 86400000);
  var match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(value == null ? '' : value).normalize('NFKC').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) {
    fail_('SCHEMA_ERROR', '既存の完了記録の出発・終了時刻を確認してください。');
  }
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3] || 0)) * 1000 + Number((match[4] || '').padEnd(3, '0'));
}

function loadVehicles_(ss) {
  var sheet = ss.getSheetByName(DRIVE_LOG_.master);
  if (!sheet) fail_('SCHEMA_ERROR', '社用車一覧シートが見つかりません。');
  var table = table_(sheet, MASTER_SCHEMA_);
  var count = sheet.getLastRow() - table.headerRow;
  if (count <= 0) return [];
  var range = sheet.getRange(table.headerRow + 1, 1, count, table.width);
  var rows = range.getValues(), formulas = range.getFormulas();
  var displays = typeof range.getDisplayValues === 'function' ? range.getDisplayValues() : rows;
  var optional = headerMap_(table.headers, { transmission: ['変速機', 'ミッション'] }, false);
  var seen = {};
  return rows.reduce(function (out, row, index) {
    var rawNumber = displays[index][table.map.number];
    if (blank_(rawNumber)) return out;
    var id = normalizeId_(rawNumber);
    if (seen[id]) fail_('SCHEMA_ERROR', '社用車一覧の車番が重複しています。');
    seen[id] = true;
    var model = String(row[table.map.model] || '').normalize('NFKC').trim();
    var modelKeys = { 'ハイエース': 'hiace', 'ハイゼット': 'hijet', 'サクシード': 'succeed', 'プロボックス': 'probox', 'トヨエース': 'toyoace' };
    if (!modelKeys[model]) fail_('SCHEMA_ERROR', '社用車一覧の車種を確認してください。');
    var fuelRaw = normalizeId_(row[table.map.fuel]).toLowerCase();
    var fuel = /^(ガソリン|gasoline)$/.test(fuelRaw) ? 'ガソリン' : /^(軽油|diesel|ディーゼル)$/.test(fuelRaw) ? '軽油' : null;
    if (!fuel) fail_('SCHEMA_ERROR', '社用車一覧の種別はガソリンまたは軽油にしてください。');
    var link = String(formulas[index][table.map.link] || row[table.map.link] || '');
    var exactGid = /[#?&]gid=(\d+)/.exec(link);
    out.push({ id: id, number: String(rawNumber).normalize('NFKC').replace(/\s+/g, ' ').trim(), model: model, modelKey: modelKeys[model],
      fuelType: fuel, inspectionDue: dateValue_(row[table.map.inspection]),
      initialOil: numeric_(row[table.map.initialOil], '初回オイル交換距離', true),
      initialOdometer: numeric_(row[table.map.initialOdometer], '初回確認時の距離', true),
      currentOdometer: numeric_(row[table.map.currentOdometer], '現在の距離', true),
      requiresClutch: optional.transmission != null && normalizeId_(row[optional.transmission]).toUpperCase() === 'MT',
      sheetId: exactGid ? Number(exactGid[1]) : null,
      masterSheet: sheet, masterRow: table.headerRow + 1 + index, masterMap: table.map });
    return out;
  }, []);
}

function requireVehicle_(ss, id) {
  var key = normalizeId_(id);
  var vehicle = loadVehicles_(ss).filter(function (v) { return v.id === key; })[0];
  if (!vehicle) fail_('VEHICLE_NOT_FOUND', '車両を選び直してください。');
  return vehicle;
}

function resolveVehicleSheet_(ss, vehicle) {
  var sheet = vehicle.sheetId === null ? null : sheetById_(ss, vehicle.sheetId);
  if (!sheet) sheet = ss.getSheets().filter(function (s) { return normalizeId_(s.getName()) === vehicle.id; })[0];
  if (!sheet || [DRIVE_LOG_.master, DRIVE_LOG_.template, DRIVE_LOG_.trips, DRIVE_LOG_.requests].indexOf(sheet.getName()) >= 0) {
    fail_('SCHEMA_ERROR', '車両の運転日誌リンクを管理者が確認してください。');
  }
  return sheet;
}

function authenticatedEmployee_(auth, requestedId) {
  if (!auth || !auth.employeeId || !validEmployeeName_(auth.employeeName)) fail_('UNAUTHORIZED', 'キンジロー君で本人情報を確認してください。');
  if (!blank_(requestedId)) assertSubject_(auth, requestedId);
  return { id: auth.employeeId, name: auth.employeeName };
}

function validEmployeeName_(value) { return typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\u0000-\u001F\u007F]/.test(value); }

function table_(sheet, schema) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var rows = sheet.getRange(1, 1, Math.max(1, Math.min(sheet.getLastRow(), 5)), width).getValues();
  for (var i = 0; i < rows.length; i++) {
    var map = headerMap_(rows[i], schema, false);
    if (Object.keys(schema).every(function (key) { return map[key] != null; })) return { headerRow: i + 1, headers: rows[i], map: map, width: width };
  }
  fail_('SCHEMA_ERROR', sheet.getName() + 'の見出しを確認してください。');
}

function headerMap_(headers, schema, required) {
  var normalized = headers.map(normalizeHeader_), result = {};
  Object.keys(schema).forEach(function (key) {
    var aliases = schema[key].map(normalizeHeader_);
    var found = [];
    normalized.forEach(function (h, index) { if (aliases.indexOf(h) >= 0) found.push(index); });
    if (found.length > 1) fail_('SCHEMA_ERROR', '同じ意味の見出しが重複しています。');
    if (found.length) result[key] = found[0];
    else if (required) fail_('SCHEMA_ERROR', schema[key][0] + 'の見出しがありません。');
  });
  return result;
}

function store_(ss) {
  return { trips: helperSheet_(ss, DRIVE_LOG_.trips, DRIVE_LOG_.tripHeaders), requests: helperSheet_(ss, DRIVE_LOG_.requests, DRIVE_LOG_.requestHeaders) };
}

function helperSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (JSON.stringify(existing) !== JSON.stringify(headers)) fail_('SCHEMA_ERROR', '管理シートの見出しが一致しません。');
  }
  if (typeof sheet.isSheetHidden !== 'function' || !sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function findRequest_(sheet, id) {
  var count = sheet.getLastRow() - 1;
  if (count <= 0) return null;
  var ids = sheet.getRange(2, 1, count, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === id) return { row: i + 2, values: sheet.getRange(i + 2, 1, 1, 7).getValues()[0] };
  return null;
}

function allTrips_(store) {
  var count = store.trips.getLastRow() - 1;
  if (count <= 0) return [];
  return store.trips.getRange(2, 4, count, 1).getValues().filter(function (r) { return !blank_(r[0]); }).map(function (r) { return JSON.parse(r[0]); });
}

function requireTrip_(store, id) {
  var trip = allTrips_(store).filter(function (t) { return t.id === id; })[0];
  if (!trip) fail_('TRIP_NOT_FOUND', '運転記録が見つかりません。車両を選び直してください。');
  if (trip.status === 'cancelled') fail_('TRIP_CANCELLED', 'この運転記録は管理者により取り消されています。車両を選び直してください。');
  return trip;
}

function activeTrip_(store, vehicleId) {
  var active = allTrips_(store).filter(function (t) { return t.vehicleId === vehicleId && t.status === 'active'; });
  if (active.length > 1) fail_('SCHEMA_ERROR', '運転中の記録が重複しています。管理者に確認してください。');
  return active[0] || null;
}

function saveTrip_(store, trip) {
  var count = store.trips.getLastRow() - 1, row = store.trips.getLastRow() + 1;
  if (count > 0) {
    var ids = store.trips.getRange(2, 1, count, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (ids[i][0] === trip.id) { row = i + 2; break; }
  }
  store.trips.getRange(row, 1, 1, 4).setValues([[trip.id, trip.vehicleId, trip.status, JSON.stringify(trip)]]);
}

function publicVehicle_(v) {
  return { id: v.id, number: v.number, model: v.model, modelKey: v.modelKey, fuelType: v.fuelType,
    inspectionDue: v.inspectionDue, currentOdometer: v.currentOdometer === null ? v.initialOdometer : v.currentOdometer, requiresClutch: v.requiresClutch };
}

function publicTrip_(t) {
  if (!t) return null;
  var result = {};
  ['id', 'vehicleId', 'vehicleNumber', 'model', 'modelKey', 'employeeId', 'employeeName', 'department', 'startedAt', 'startOdometer', 'before', 'status', 'completedAt', 'endOdometer', 'distance', 'after', 'destination', 'fuelLiters', 'oilChanged', 'notes', 'completedByEmployeeId', 'completedByEmployeeName', 'completedDepartment']
    .forEach(function (key) { if (t[key] !== undefined) result[key] = t[key]; });
  if (t.status === 'completed' && result.completedDepartment === undefined) result.completedDepartment = t.department;
  result.recordedDriverName = recordedDriverName_(t);
  return result;
}

function recordedDriverName_(trip) {
  if (!blank_(trip.completedByEmployeeId) && normalizeId_(trip.completedByEmployeeId) !== normalizeId_(trip.employeeId) && validEmployeeName_(trip.completedByEmployeeName)) {
    return trip.employeeName + ' ／ ' + trip.completedByEmployeeName;
  }
  return trip.employeeName;
}

function oilState_(fuelType, baseline, current) {
  var interval = fuelType === '軽油' ? 4000 : 7000;
  var remaining = baseline === null || current === null ? null : baseline + interval - current;
  return { baseline: baseline, interval: interval, remaining: remaining,
    status: remaining === null ? 'unregistered' : remaining <= 0 ? 'overdue' : remaining < 50 ? 'warning' : 'ok' };
}

function warnings_(vehicle, oil, today) {
  var result = [];
  if (oil.status === 'warning' || oil.status === 'overdue') result.push({
    id: 'oil:' + vehicle.id + ':' + oil.baseline, type: 'oil', level: oil.status === 'overdue' ? 'danger' : 'warning',
    title: 'オイル交換時期', message: oil.remaining <= 0 ? 'オイル交換の目安距離に達しています。' : 'オイル交換の目安まで残り' + Math.round(oil.remaining) + 'kmです。'
  });
  var due = vehicle.inspectionDue;
  if (due) {
    var stage = today >= due ? 0 : today >= shiftMonths_(due, -1) ? 1 : today >= shiftMonths_(due, -2) ? 2 : today >= shiftMonths_(due, -3) ? 3 : null;
    if (stage !== null) result.push({ id: 'inspection:' + vehicle.id + ':' + due + ':' + stage, type: 'inspection',
      level: stage <= 1 ? 'danger' : stage === 2 ? 'warning' : 'info', title: '車検のお知らせ',
      message: stage === 0 ? '車検満了日（' + due + '）を確認してください。' : '車検満了日（' + due + '）の' + stage + 'か月前になりました。' });
  }
  return result;
}

function shiftMonths_(isoDate, delta) {
  var parts = isoDate.split('-').map(Number), d = new Date(Date.UTC(parts[0], parts[1] - 1 + delta, 1));
  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(parts[2], last));
  return d.toISOString().slice(0, 10);
}

function dateValue_(v) {
  if (blank_(v)) return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (typeof v === 'number' && isFinite(v)) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  var m = /^(\d{4})[\/年-](\d{1,2})[\/月-](\d{1,2})日?$/.exec(String(v).normalize('NFKC').trim());
  if (!m) fail_('SCHEMA_ERROR', '車検満了日の日付形式を確認してください。');
  var date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10);
  if (Number(date.slice(5, 7)) !== Number(m[2]) || Number(date.slice(8, 10)) !== Number(m[3])) fail_('SCHEMA_ERROR', '車検満了日が不正です。');
  return date;
}

function numeric_(v, label, optional) {
  if (blank_(v)) { if (optional) return null; fail_('VALIDATION_ERROR', label + 'を入力してください。'); }
  if (typeof v !== 'number' && typeof v !== 'string') fail_('VALIDATION_ERROR', label + 'は数値で入力してください。');
  var raw = typeof v === 'string' ? v.normalize('NFKC').trim() : v;
  if (typeof raw === 'string' && !/^\d+(?:\.\d+)?$/.test(raw)) fail_('VALIDATION_ERROR', label + 'は0以上の数値で入力してください。');
  var number = Number(raw);
  if (!isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) fail_('VALIDATION_ERROR', label + 'は0以上の数値で入力してください。');
  return number;
}

function alcohol_(value) {
  if (!value || typeof value.confirmed !== 'boolean' || ['有', '無'].indexOf(value.presence) < 0) fail_('VALIDATION_ERROR', 'アルコール確認の状態を入力してください。');
  return { confirmed: value.confirmed, reading: numeric_(value.reading, '検知器結果', true), presence: value.presence };
}

function rowFields_(sheet, table, row) {
  var values = sheet.getRange(row, 1, 1, table.width).getValues()[0], result = {};
  Object.keys(TRIP_SCHEMA_).forEach(function (key) { result[key] = values[table.map[key]] == null ? '' : values[table.map[key]]; });
  return canonicalTripFields_(result, sheetTimeZone_(sheet));
}

// Sheets may return calendar/time cells as Date objects even when the app wrote
// strings. Normalize only these three known fields, including old journal ISO
// strings, so comparisons and recovery use the same spreadsheet-local values.
function canonicalTripFields_(fields, timeZone) {
  var result = {};
  Object.keys(fields).forEach(function (key) { result[key] = canonicalTripField_(key, fields[key], timeZone); });
  return result;
}

function canonicalTripField_(key, value, timeZone) {
  if (key !== 'date' && key !== 'startTime' && key !== 'endTime') return value;
  if (blank_(value)) return '';
  var date = Object.prototype.toString.call(value) === '[object Date]' ? value : null;
  if (!date && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) date = new Date(value);
  if (date) {
    if (isNaN(date.getTime())) fail_('SCHEMA_ERROR', '記録の日付・時刻を確認してください。');
    if (key === 'date') return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
    return Utilities.formatDate(date, timeZone, 'HH:mm:ss.SSS').replace(/\.000$/, '').replace(/:00$/, '');
  }
  if (key === 'date') return dateValue_(value);
  var milliseconds = clockMilliseconds_(value);
  var hours = Math.floor(milliseconds / 3600000) % 24;
  var minutes = Math.floor(milliseconds / 60000) % 60;
  var seconds = Math.floor(milliseconds / 1000) % 60;
  var fraction = milliseconds % 1000;
  var text = ('0' + hours).slice(-2) + ':' + ('0' + minutes).slice(-2);
  if (seconds || fraction) text += ':' + ('0' + seconds).slice(-2);
  if (fraction) text += '.' + ('00' + fraction).slice(-3);
  return text;
}

function sheetTimeZone_(sheet) { return sheet.getParent().getSpreadsheetTimeZone(); }
function blankTripFields_() { var result = {}; Object.keys(TRIP_SCHEMA_).forEach(function (key) { result[key] = ''; }); return result; }
function sameCell_(a, b) {
  function key(v) { return String(v == null ? '' : v).replace(/^'(?=[=+\-@])/, ''); }
  return key(a) === key(b);
}
function blank_(v) { return v == null || typeof v === 'string' && v.trim() === ''; }
function normalizeId_(v) { return v == null ? '' : String(v).normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g, ''); }
function normalizeHeader_(v) { return normalizeId_(v).toLowerCase(); }
function nowJst_() { return new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00'); }
function japaneseWeekday_(date) { return ['日', '月', '火', '水', '木', '金', '土'][new Date(date + 'T00:00:00Z').getUTCDay()]; }
function sheetById_(ss, id) { return ss.getSheets().filter(function (s) { return String(s.getSheetId()) === String(id); })[0] || null; }
function sheetUrl_(ss, gid) { return 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit#gid=' + gid; }
function safeCellText_(text) { return /^[=+\-@]/.test(text) ? "'" + text : text; }
function text_(v, label, max, required) { if (typeof v !== 'string' || v.length > max || required && !v.trim()) fail_('VALIDATION_ERROR', label + 'を確認してください。'); return v.trim(); }
function assertSubject_(auth, employeeId) { if (!auth.employeeId || auth.employeeId !== normalizeId_(employeeId)) fail_('EMPLOYEE_MISMATCH', 'キンジロー君の社員番号と運転者が一致しません。'); }
function fail_(code, message) { var e = new Error(message); e.driveLogCode = code; throw e; }
function errorResponse_(err, id) { return { ok: false, error: { code: err && err.driveLogCode || 'INTERNAL_ERROR', message: err && err.driveLogCode ? err.message : '処理を完了できませんでした。同じ操作をもう一度お試しください。' }, requestId: typeof id === 'string' ? id : null }; }
function jsonOutput_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function safeScriptJson_(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function stableJson_(v) { if (Array.isArray(v)) return '[' + v.map(stableJson_).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableJson_(v[k]); }).join(',') + '}'; return JSON.stringify(v); }
function sha256_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }

function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) fail_('CONFIGURATION_ERROR', '記録先スプレッドシートが未設定です。');
  return SpreadsheetApp.openById(id);
}
function allowedOrigin_(origin) {
  if (!/^https?:\/\/[^\s/?#]+$/.test(origin)) return false;
  var raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_ORIGINS') || '';
  var allowed;
  try { allowed = JSON.parse(raw); } catch (_) { allowed = raw.split(/[\s,]+/); }
  return Array.isArray(allowed) && allowed.indexOf(origin) >= 0;
}

function setup_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KINJIRO_VERIFY_URL')) fail_('CONFIGURATION_ERROR', 'キンジロー君認証設定を先に登録してください。');
  var ss = spreadsheet_();
  loadVehicles_(ss); // validate existing headings without changing the master
  store_(ss);
  SpreadsheetApp.flush();
  return { initialized: true, helperSheets: [DRIVE_LOG_.trips, DRIVE_LOG_.requests] };
}
