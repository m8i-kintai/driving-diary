/** Fleet administration shares this project's ScriptLock with driving writes.
 * Deploy its ?view=fleet URL separately as USER_ACCESSING (Google sign-in).
 * Never route these operations through the driver doPost endpoint.
 */
var FLEET_ADMIN_ = Object.freeze({
  journal: '_運転日報_車両管理',
  panel: '車両管理ツール', panelMetadata: 'DRIVE_FLEET_PANEL', cleanupMetadata: 'DRIVE_FLEET_LEGACY_CLEANUP',
  inputs: { renameVehicle: [8, 3], renameNumber: [9, 3], stopVehicle: [8, 7], restoreVehicle: [17, 3],
    number: [17, 7], model: [18, 7], fuel: [19, 7], inspection: [20, 7], initialOil: [21, 7], initialOdometer: [22, 7] },
  legacyInputs: { renameVehicle: [5, 11], renameNumber: [6, 11], stopVehicle: [10, 11], restoreVehicle: [14, 11],
    number: [18, 11], model: [19, 11], fuel: [20, 11], inspection: [21, 11], initialOil: [22, 11], initialOdometer: [23, 11], transmission: [24, 11] },
  headers: ['requestId', 'adminEmail', 'fingerprint', 'state', 'operationJson', 'responseJson', 'createdAt'],
  models: ['ハイエース', 'ハイゼット', 'サクシード', 'プロボックス', 'トヨエース'],
  optional: { stableId: ['車両ID'], usage: ['使用状況'], transmission: ['変速機', 'ミッション'] }
});

// The only public management RPC. An owner-executed anonymous deployment must
// not infer authorization from effectiveUser (which would be the owner).
function fleetAdminRpc(request) {
  var accepted = false, lock = null;
  try {
    var access = fleetAdminAccess_();
    fleetValidateRequest_(request);
    lock = LockService.getScriptLock();
    try { lock.waitLock(25000); } catch (_) { lock = null; fail_('BUSY', '処理中です。少し待って再度お試しください。'); }
    var ss = access.ss;
    if (request.action === 'bootstrap') return { ok: true, data: fleetBootstrap_(ss, access.email), requestId: request.requestId };
    var journal = ss.getSheetByName(FLEET_ADMIN_.journal);
    var existing = journal && findRequest_(journal, request.requestId);
    var fingerprint = stableJson_({ operation: request.operation, payload: request.payload || {}, expectedRevision: request.expectedRevision });
    if (request.action === 'apply' && existing) {
      if (existing.values[1] !== access.email || existing.values[2] !== fingerprint) fail_('REQUEST_ID_REUSED', '同じ通信IDに別の操作または管理者が指定されています。');
      if (existing.values[3] === 'committed') return JSON.parse(existing.values[5]);
      accepted = true;
      fleetValidateJournal_(journal);
      if (existing.values[3] !== 'pending') fail_('SCHEMA_ERROR', '管理処理の保存状態を確認してください。');
      return fleetFinishJournal_(ss, journal, existing.row, JSON.parse(existing.values[4]));
    }
    if (journal) fleetValidateJournal_(journal);
    fleetRequireInstalled_(ss);
    var plan = fleetPlan_(ss, request, access.email);
    if (request.action === 'preview') return { ok: true, data: { summary: plan.summary, expectedRevision: plan.revision }, requestId: request.requestId };
    if (typeof request.expectedRevision !== 'string' || request.expectedRevision !== plan.revision) fail_('REVISION_CONFLICT', '車両情報が変更されました。読み直して確認してください。');
    journal = fleetJournal_(ss, true);
    var row = journal.getLastRow() + 1;
    accepted = true; // A lost acknowledgement must retain the immutable request.
    journal.getRange(row, 1, 1, 7).setValues([[request.requestId, access.email, fingerprint, 'pending', JSON.stringify(plan.operation), '', nowJst_()]]);
    SpreadsheetApp.flush();
    return fleetFinishJournal_(ss, journal, row, plan.operation);
  } catch (error) {
    var response = errorResponse_(error, request && request.requestId);
    if (accepted) response.error = { code: 'FLEET_SAVE_PENDING', message: '保存結果の確認が必要です。同じ内容のまま再送してください。', commitState: 'pending', causeCode: response.error.code };
    return response;
  } finally {
    if (lock) { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
  }
}

function fleetAdminAccess_() {
  var active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!active || active !== effective) fail_('UNAUTHORIZED', 'Googleアカウントで管理用URLを開いてください。');
  var ss = spreadsheet_(), master = ss.getSheetByName(DRIVE_LOG_.master);
  if (!master || !master.getRange(1, 1, Math.max(master.getLastRow(), 1), Math.max(master.getLastColumn(), 1)).canEdit()) {
    fail_('FORBIDDEN', 'この運転日誌の編集権限が必要です。');
  }
  return { email: active, ss: ss };
}

function fleetValidateRequest_(request) {
  if (!request || request.version !== 1 || ['bootstrap', 'preview', 'apply'].indexOf(request.action) < 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(request.requestId || '')) ||
      request.action !== 'bootstrap' && (['rename', 'setStatus', 'add'].indexOf(request.operation) < 0 ||
        !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))) {
    fail_('VALIDATION_ERROR', '管理操作の形式を確認してください。');
  }
}

function fleetBootstrap_(ss, email) {
  var vehicles = loadVehicles_(ss);
  var pending = fleetPendingVehicleIds_(ss);
  var management = ss.getSheetByName(FLEET_ADMIN_.panel);
  var masterUrl = sheetUrl_(ss, ss.getSheetByName(DRIVE_LOG_.master).getSheetId());
  return { adminEmail: email, vehicles: vehicles.filter(function (v) { return pending.indexOf(v.id) < 0; }).map(function (v) { return fleetPublicVehicle_(ss, v); }),
    models: FLEET_ADMIN_.models.slice(), fuels: ['ガソリン', '軽油'], masterUrl: masterUrl,
    managementUrl: fleetPanelInstalled_(management) ? sheetUrl_(ss, management.getSheetId()) : masterUrl, panel: fleetReadPanel_(ss, vehicles) };
}

function fleetPublicVehicle_(ss, vehicle) {
  var sheet = resolveVehicleSheet_(ss, vehicle);
  return Object.assign({}, publicVehicle_(vehicle), { initialOil: vehicle.initialOil, initialOdometer: vehicle.initialOdometer,
    currentOdometer: vehicle.currentOdometer, sheetUrl: sheetUrl_(ss, sheet.getSheetId()), revision: fleetRevision_(ss, vehicle) });
}

function fleetVehicleSnapshot_(ss, vehicle) {
  var sheet = resolveVehicleSheet_(ss, vehicle);
  return { id: vehicle.id, number: vehicle.number, model: vehicle.model, fuelType: vehicle.fuelType,
    inspectionDue: vehicle.inspectionDue, initialOil: vehicle.initialOil, initialOdometer: vehicle.initialOdometer,
    currentOdometer: vehicle.currentOdometer, requiresClutch: vehicle.requiresClutch, active: vehicle.active,
    masterRow: vehicle.masterRow, sheetId: sheet.getSheetId(), sheetName: sheet.getName() };
}

function fleetRevision_(ss, vehicle) {
  return sha256_(stableJson_({ headers: table_(vehicle.masterSheet, MASTER_SCHEMA_).headers, vehicle: fleetVehicleSnapshot_(ss, vehicle) }));
}

function fleetAddRevision_(ss) {
  var master = ss.getSheetByName(DRIVE_LOG_.master), template = ss.getSheetByName(DRIVE_LOG_.template);
  fleetValidateTemplate_(template);
  return sha256_(stableJson_({ headers: table_(master, MASTER_SCHEMA_).headers,
    vehicles: loadVehicles_(ss).map(function (v) { return fleetVehicleSnapshot_(ss, v); }),
    lastRow: master.getLastRow(), templateId: template.getSheetId(), templateHeaders: table_(template, TRIP_SCHEMA_).headers }));
}

function fleetRequireInstalled_(ss) {
  var master = ss.getSheetByName(DRIVE_LOG_.master), table = table_(master, MASTER_SCHEMA_);
  var optional = headerMap_(table.headers, FLEET_ADMIN_.optional, false);
  if (optional.stableId == null || optional.usage == null) fail_('FLEET_NOT_INSTALLED', '管理者による車両管理の初期設定が必要です。');
  var count = master.getLastRow() - table.headerRow;
  if (count > 0 && master.getRange(table.headerRow + 1, 1, count, table.width).getValues().some(function (row) {
    return !blank_(row[table.map.number]) && blank_(row[optional.stableId]);
  })) fail_('FLEET_NOT_INSTALLED', '既存車両の車両IDを先に固定してください。');
  var gids = {};
  loadVehicles_(ss).forEach(function (v) {
    var gid = resolveVehicleSheet_(ss, v).getSheetId();
    if (gids[gid]) fail_('SCHEMA_ERROR', '複数の車両が同じ日報シートを参照しています。');
    gids[gid] = true;
  });
  return { sheet: master, table: table, optional: optional };
}

function fleetNumber_(value) {
  var number = text_(value, '車番', 80, true).normalize('NFKC').replace(/\s+/g, ' ');
  if (/[\u0000-\u001f\u007f\[\]:*?\/\\]/.test(number) || /^['=+\-@]|'$/.test(number)) fail_('VALIDATION_ERROR', '車番に使用できない文字が含まれています。');
  if ([DRIVE_LOG_.master, DRIVE_LOG_.template, DRIVE_LOG_.trips, DRIVE_LOG_.requests, FLEET_ADMIN_.journal, FLEET_ADMIN_.panel].indexOf(number) >= 0) fail_('VALIDATION_ERROR', '管理用シート名は車番に使用できません。');
  return number;
}

function fleetPlan_(ss, request, email) {
  var meta = fleetRequireInstalled_(ss), p = request.payload;
  var vehicles = loadVehicles_(ss), vehicle = null, sheet = null;
  var summary = { operation: request.operation }, operation = { requestId: request.requestId, operation: request.operation,
    adminEmail: email, createdAt: nowJst_(), headerToken: stableJson_(meta.table.headers) };
  var revision;
  if (request.operation === 'add') {
    if (fleetPendingVehicleIds_(ss).length) fail_('VEHICLE_PENDING', '保存途中の車両管理があります。先に保存結果を確認してください。');
    var number = fleetNumber_(p.number);
    if (FLEET_ADMIN_.models.indexOf(p.model) < 0 || ['ガソリン', '軽油'].indexOf(p.fuelType) < 0) fail_('VALIDATION_ERROR', '車種・燃料を確認してください。');
    var inspection = dateValue_(p.inspectionDue), initialOil = numeric_(p.initialOil, '初回オイル交換距離', true), initial = numeric_(p.initialOdometer, '初回確認時の距離', false);
    fleetAssertNumberFree_(ss, vehicles, number, null);
    fleetValidateTemplate_(ss.getSheetByName(DRIVE_LOG_.template));
    revision = fleetAddRevision_(ss);
    Object.assign(operation, { vehicleId: request.requestId.toLowerCase(), masterRow: meta.sheet.getLastRow() + 1, sheetId: null,
      temporarySheetName: '_車両登録_' + request.requestId.toLowerCase(), sheetName: number,
      templateId: ss.getSheetByName(DRIVE_LOG_.template).getSheetId(), before: null,
      fields: { number: number, model: p.model, fuel: p.fuelType, inspection: inspection,
        initialOil: initialOil, initialOdometer: initial, currentOdometer: initial, stableId: request.requestId.toLowerCase(), usage: '使用中', transmission: 'AT' } });
    Object.assign(summary, { vehicleId: '', previousNumber: '', number: number, active: true, model: p.model, fuelType: p.fuelType,
      inspectionDue: inspection, initialOil: initialOil, initialOdometer: initial, currentOdometer: initial, requiresClutch: false, sheetUrl: '' });
  } else {
    vehicle = vehicles.filter(function (v) { return v.id === normalizeId_(p.vehicleId); })[0];
    if (!vehicle) fail_('VEHICLE_NOT_FOUND', '車両を選び直してください。');
    fleetAssertVehicleIdle_(ss, vehicle.id);
    if (fleetPendingVehicleIds_(ss).indexOf(vehicle.id) >= 0) fail_('VEHICLE_PENDING', 'この車両の管理処理を保存中です。同じ操作を再送してください。');
    sheet = resolveVehicleSheet_(ss, vehicle);
    revision = fleetRevision_(ss, vehicle);
    Object.assign(operation, { vehicleId: vehicle.id, masterRow: vehicle.masterRow, sheetId: sheet.getSheetId(),
      sheetName: sheet.getName(), previousSheetName: sheet.getName(), before: fleetVehicleSnapshot_(ss, vehicle), fields: {} });
    Object.assign(summary, fleetPublicVehicle_(ss, vehicle), { operation: request.operation, vehicleId: vehicle.id, previousNumber: vehicle.number });
    if (request.operation === 'rename') {
      var changedNumber = fleetNumber_(p.number);
      fleetAssertNumberFree_(ss, vehicles, changedNumber, vehicle.id);
      operation.fields.number = changedNumber; operation.sheetName = changedNumber;
      summary.number = changedNumber;
    } else {
      if (typeof p.active !== 'boolean') fail_('VALIDATION_ERROR', '使用状況を選択してください。');
      operation.fields.usage = p.active ? '使用中' : '使用停止'; summary.active = p.active;
    }
  }
  operation.summary = summary;
  return { summary: summary, operation: operation, revision: revision };
}

function fleetAssertNumberFree_(ss, vehicles, number, exceptId) {
  if (vehicles.some(function (v) { return v.id !== exceptId && normalizeId_(v.number) === normalizeId_(number); })) fail_('DUPLICATE_VEHICLE_NUMBER', '同じ車番が既に登録されています。');
  var named = ss.getSheetByName(number);
  if (named && (!exceptId || resolveVehicleSheet_(ss, vehicles.filter(function (v) { return v.id === exceptId; })[0]).getSheetId() !== named.getSheetId())) {
    fail_('SHEET_NAME_CONFLICT', '同じ名前のシートがあります。車番を確認してください。');
  }
}

function fleetAssertVehicleIdle_(ss, vehicleId, allowActive) {
  var trips = ss.getSheetByName(DRIVE_LOG_.trips), requests = ss.getSheetByName(DRIVE_LOG_.requests);
  if (!!trips !== !!requests) fail_('SCHEMA_ERROR', '運転記録の管理シートを確認してください。');
  if (!trips) return;
  var store = existingStore_(ss);
  var active = activeTrip_(store, vehicleId);
  if (active && !allowActive) fail_('VEHICLE_IN_USE', 'この車両は運転中です。完了後に変更してください。');
  if (active && String(active.sheetId) !== String(resolveVehicleSheet_(ss, requireVehicle_(ss, vehicleId)).getSheetId())) {
    fail_('SCHEMA_ERROR', '運転中の記録と車両の日報リンクが一致しません。初期設定を停止しました。');
  }
  var count = requests.getLastRow() - 1;
  if (count > 0 && requests.getRange(2, 4, count, 2).getValues().some(function (row) {
    if (row[0] !== 'pending') return false;
    var op = JSON.parse(row[1]); return op.trip && op.trip.vehicleId === vehicleId;
  })) fail_('VEHICLE_PENDING', 'この車両の運転記録を保存中です。保存結果を先に確認してください。');
}

function fleetValidateTemplate_(sheet) {
  if (!sheet) fail_('SCHEMA_ERROR', '運転日報ひな形が見つかりません。');
  var table = table_(sheet, TRIP_SCHEMA_);
  if (sheet.getLastRow() > table.headerRow) fail_('SCHEMA_ERROR', 'ひな形に入力済みデータがあります。空のひな形を確認してください。');
  return table;
}

function fleetJournal_(ss, create) {
  var sheet = ss.getSheetByName(FLEET_ADMIN_.journal);
  if (!sheet && !create) return null;
  return create ? helperSheet_(ss, FLEET_ADMIN_.journal, FLEET_ADMIN_.headers) : fleetValidateJournal_(sheet);
}

function fleetValidateJournal_(sheet) {
  if (JSON.stringify(sheet.getRange(1, 1, 1, 7).getValues()[0]) !== JSON.stringify(FLEET_ADMIN_.headers)) fail_('SCHEMA_ERROR', '車両管理ログの見出しを確認してください。');
  return sheet;
}

function fleetPendingVehicleIds_(ss) {
  var sheet = fleetJournal_(ss, false), ids = [];
  if (!sheet || sheet.getLastRow() <= 1) return ids;
  sheet.getRange(2, 4, sheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
    if (row[0] === 'pending') ids.push(JSON.parse(row[1]).vehicleId);
  });
  return ids;
}

// Called only while this project's ScriptLock is held. Startup stays read-only.
function fleetRecoverPending_(ss) {
  var journal = fleetJournal_(ss, false);
  if (!journal || journal.getLastRow() <= 1) return;
  journal.getRange(2, 4, journal.getLastRow() - 1, 2).getValues().forEach(function (row, index) {
    if (row[0] === 'pending') fleetFinishJournal_(ss, journal, index + 2, JSON.parse(row[1]));
  });
}

function fleetFinishJournal_(ss, journal, row, operation) {
  var data = fleetApplyOperation_(ss, journal, row, operation);
  var response = { ok: true, data: data, requestId: operation.requestId };
  journal.getRange(row, 6).setValue(JSON.stringify(response));
  SpreadsheetApp.flush();
  journal.getRange(row, 4).setValue('committed');
  SpreadsheetApp.flush();
  return response;
}

function fleetApplyOperation_(ss, journal, row, operation) {
  var meta = fleetRequireInstalled_(ss);
  if (stableJson_(meta.table.headers) !== operation.headerToken) fail_('SCHEMA_ERROR', '保存中に社用車一覧の見出しが変更されました。');
  fleetAssertVehicleIdle_(ss, operation.vehicleId);
  var vehicles = loadVehicles_(ss), sheet;
  if (operation.operation === 'add') {
    var ownVehicle = vehicles.filter(function (v) { return v.id === operation.vehicleId; })[0];
    if (ownVehicle && ownVehicle.masterRow !== operation.masterRow) fail_('ROW_CONFLICT', '新車登録先の行が移動しています。');
    if (vehicles.some(function (v) { return v.id !== operation.vehicleId && normalizeId_(v.number) === normalizeId_(operation.fields.number); })) fail_('DUPLICATE_VEHICLE_NUMBER', '登録先の車番が重複しました。');
    sheet = operation.sheetId == null ? ss.getSheetByName(operation.temporarySheetName) : sheetById_(ss, operation.sheetId);
    var named = ss.getSheetByName(operation.sheetName);
    if (named && (!sheet || named.getSheetId() !== sheet.getSheetId())) fail_('SHEET_NAME_CONFLICT', '登録先と同名のシートが作成されています。');
    if (!sheet) {
      var template = sheetById_(ss, operation.templateId); fleetValidateTemplate_(template);
      sheet = ss.insertSheet(operation.temporarySheetName, { template: template });
    }
    if (operation.sheetId == null) {
      fleetValidateTemplate_(sheet);
      operation.sheetId = sheet.getSheetId();
      journal.getRange(row, 5).setValue(JSON.stringify(operation));
      SpreadsheetApp.flush();
    }
    if ([operation.temporarySheetName, operation.sheetName].indexOf(sheet.getName()) < 0) fail_('ROW_CONFLICT', '新しい日報シート名が変更されています。');
    if (sheet.getName() !== operation.sheetName) sheet.setName(operation.sheetName);
    var fields = Object.assign({}, operation.fields, { link: '=HYPERLINK("' + sheetUrl_(ss, sheet.getSheetId()) + '","運転日リンク")' });
    fleetWriteNewMasterRow_(meta, operation.masterRow, fields);
  } else {
    var vehicle = vehicles.filter(function (v) { return v.id === operation.vehicleId; })[0];
    if (!vehicle || vehicle.masterRow !== operation.masterRow) fail_('ROW_CONFLICT', '変更対象の車両行が移動しています。');
    sheet = sheetById_(ss, operation.sheetId);
    if (!sheet || resolveVehicleSheet_(ss, vehicle).getSheetId() !== operation.sheetId) fail_('ROW_CONFLICT', '変更対象の日報リンクが変更されています。');
    var current = fleetVehicleSnapshot_(ss, vehicle), allowed = Object.assign({}, operation.before);
    if (operation.operation === 'rename') allowed.number = operation.fields.number;
    else allowed.active = operation.fields.usage === '使用中';
    current.sheetName = operation.before.sheetName; allowed.sheetName = operation.before.sheetName;
    if (Object.keys(current).some(function (key) { return current[key] !== operation.before[key] && current[key] !== allowed[key]; })) fail_('ROW_CONFLICT', '保存中に車両情報が変更されています。');
    if ([operation.previousSheetName, operation.sheetName].indexOf(sheet.getName()) < 0) fail_('ROW_CONFLICT', '保存中に日報シート名が変更されています。');
    if (operation.operation === 'rename') {
      fleetAssertNumberFree_(ss, vehicles, operation.fields.number, vehicle.id);
      if (sheet.getName() !== operation.sheetName) sheet.setName(operation.sheetName);
      meta.sheet.getRange(operation.masterRow, meta.table.map.number + 1).setValue(safeCellText_(operation.fields.number));
    } else meta.sheet.getRange(operation.masterRow, meta.optional.usage + 1).setValue(operation.fields.usage);
  }
  var updated = requireVehicle_(ss, operation.vehicleId), publicVehicle = fleetPublicVehicle_(ss, updated);
  fleetRefreshPanel_(ss);
  return { vehicle: publicVehicle, summary: Object.assign({}, operation.summary, { vehicleId: updated.id, sheetUrl: publicVehicle.sheetUrl }),
    sheetUrl: publicVehicle.sheetUrl, message: operation.operation === 'add' ? '車両を登録しました。' : operation.operation === 'rename' ? '車番を変更しました。' : updated.active ? '運用に戻しました。' : '運用から外しました。' };
}

function fleetWriteNewMasterRow_(meta, row, fields) {
  var map = Object.assign({}, meta.table.map, meta.optional), desired = Array(meta.table.width).fill('');
  Object.keys(fields).forEach(function (key) { if (map[key] != null) desired[map[key]] = fields[key] === null ? '' : fields[key]; });
  var range = meta.sheet.getRange(row, 1, 1, meta.table.width), current = range.getValues()[0], formulas = range.getFormulas()[0];
  current.forEach(function (value, index) {
    var expected = desired[index];
    if (map.link === index && formulas[index]) value = formulas[index];
    if (map.inspection === index && !blank_(value)) value = dateValue_(value);
    if (!blank_(value) && !sameCell_(value, expected)) fail_('ROW_CONFLICT', '新車登録先の行に別の値があります。');
  });
  range.setValues([desired]);
}

// Owner/editor setup only; call from a temporary manual editor wrapper. This
// preserves every existing vehicle ID and never rewrites odometer baselines.
function installFleetManagement_(adminUrl) {
  var access = fleetAdminAccess_();
  var url = fleetAdminUrl_(adminUrl);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var ss = access.ss, vehicles = loadVehicles_(ss), master = ss.getSheetByName(DRIVE_LOG_.master);
    fleetAssertPanelArea_(master);
    fleetAssertManagementSheet_(ss.getSheetByName(FLEET_ADMIN_.panel));
    if (fleetPendingVehicleIds_(ss).length) fail_('VEHICLE_PENDING', '保存途中の管理操作があります。');
    vehicles.forEach(function (v) { fleetAssertVehicleIdle_(ss, v.id, true); resolveVehicleSheet_(ss, v); });
    var table = table_(master, MASTER_SCHEMA_), optional = headerMap_(table.headers, FLEET_ADMIN_.optional, false);
    var preferred = { usage: 8, stableId: 9 }, next = Math.max(table.width, fleetLegacyPanelInstalled_(master) ? 16 : 10);
    ['usage', 'stableId'].forEach(function (key) {
      if (optional[key] == null) {
        var column = preferred[key], proposed = master.getRange(table.headerRow, column + 1, Math.max(master.getLastRow() - table.headerRow + 1, 1), 1);
        var occupied = proposed.getValues(), formulas = proposed.getFormulas();
        if (occupied.some(function (row, index) { return !blank_(row[0]) || !!formulas[index][0]; })) column = next++;
        optional[key] = column; master.getRange(table.headerRow, column + 1).setValue(FLEET_ADMIN_.optional[key][0]);
      }
    });
    vehicles.forEach(function (v) {
      master.getRange(v.masterRow, optional.stableId + 1).setValue(v.id);
      master.getRange(v.masterRow, optional.usage + 1).setValue(v.active ? '使用中' : '使用停止');
      master.getRange(v.masterRow, table.map.link + 1).setValue('=HYPERLINK("' + sheetUrl_(ss, resolveVehicleSheet_(ss, v).getSheetId()) + '","運転日リンク")');
    });
    fleetJournal_(ss, true);
    fleetInstallPanel_(ss, url);
    SpreadsheetApp.flush();
    fleetRequireInstalled_(ss);
    return { installed: true, vehicles: vehicles.length, adminUrl: url, panelRange: FLEET_ADMIN_.panel + '!A1:I27',
      managementUrl: sheetUrl_(ss, ss.getSheetByName(FLEET_ADMIN_.panel).getSheetId()) };
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}

function fleetAdminUrl_(adminUrl) {
  var pattern = /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\/s\/[A-Za-z0-9_-]+\/exec(?:\?view=fleet)?$/;
  if (typeof adminUrl !== 'string' || !pattern.test(adminUrl)) fail_('VALIDATION_ERROR', '管理用Webアプリの公開URLを指定してください。');
  return adminUrl.replace(/\?view=fleet$/, '') + '?view=fleet';
}

// Existing installations use this command instead of rerunning ID/master setup.
// Stage one leaves the legacy panel available to the previously deployed UI.
function migrateFleetManagementPanel_(adminUrl) {
  var access = fleetAdminAccess_(), url = fleetAdminUrl_(adminUrl);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    fleetRequireInstalled_(access.ss);
    var sheet = fleetInstallPanel_(access.ss, url);
    return { migrated: true, managementUrl: sheetUrl_(access.ss, sheet.getSheetId()),
      panelRange: FLEET_ADMIN_.panel + '!A1:I27', legacyRetained: fleetLegacyPanelInstalled_(access.ss.getSheetByName(DRIVE_LOG_.master)) };
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}

function fleetPanelMeta_(sheet, key) {
  if (!sheet) return null;
  return sheet.getDeveloperMetadata().filter(function (entry) { return entry.getKey() === key; })[0] || null;
}

function fleetSetPanelMeta_(sheet, key, value) {
  var existing = fleetPanelMeta_(sheet, key);
  if (existing) existing.setValue(value); else sheet.addDeveloperMetadata(key, value);
}

function fleetPanelInstalled_(sheet) {
  var marker = fleetPanelMeta_(sheet, FLEET_ADMIN_.panelMetadata);
  return !!(sheet && sheet.getName() === FLEET_ADMIN_.panel && sheet.getRange(2, 2).getValue() === FLEET_ADMIN_.panel && marker && marker.getValue() === 'ready');
}

function fleetLegacyPanelInstalled_(master) { return master.getRange(1, 10).getValue() === '社用車 管理ツール'; }

function fleetLegacyLabels_() {
  return { '1:10': ['社用車 管理ツール'], '2:10': ['入力後、右の「内容を確認・実行」を押してください'], '3:10': ['運転中・保存中の車両は変更できません'],
    '4:10': ['番号変更'], '5:10': ['対象車両'], '6:10': ['新しい車番'], '9:10': ['運用から外す'], '10:10': ['対象車両'],
    '13:10': ['運用に戻す'], '14:10': ['対象車両'], '17:10': ['新規追加'], '18:10': ['車番'], '19:10': ['車種'], '20:10': ['燃料'],
    '21:10': ['車検満了日'], '22:10': ['前回オイル交換時メーター (km)', '初回オイル交換距離'],
    '23:10': ['初回確認時の距離 (km)', '初回確認時の距離'], '24:10': ['変速機 (AT/MT)'] };
}

function fleetManagementLabels_() {
  return { '2:2': FLEET_ADMIN_.panel, '5:2': '車番を変更', '5:6': '運用から外す', '14:2': '運用に戻す', '14:6': '車両を追加',
    '8:2': '対象車両', '9:2': '新しい車番', '8:6': '対象車両', '17:2': '対象車両', '17:6': '車番', '18:6': '車種', '19:6': '燃料',
    '20:6': '車検満了日（任意）', '21:6': '前回オイル交換時\nの距離 km（任意）', '22:6': '初回距離 km' };
}

function fleetManagementButtons_() {
  return [{ row: 11, col: 2, operation: 'rename', label: '変更内容を確認' }, { row: 11, col: 6, operation: 'stop', label: '外す車両を確認' },
    { row: 20, col: 2, operation: 'restore', label: '戻す車両を確認' }, { row: 25, col: 6, operation: 'add', label: '登録内容を確認' }];
}

function fleetPanelLinkMatches_(formula, operation, label) {
  var match = /^=HYPERLINK\("([^"]+)","([^"]+)"\)$/i.exec(String(formula || ''));
  if (!match || match[2] !== label || !match[1].endsWith('&operation=' + operation)) return false;
  try { return fleetAdminUrl_(match[1].slice(0, -('&operation=' + operation).length)) === match[1].slice(0, -('&operation=' + operation).length); }
  catch (_) { return false; }
}

function fleetAssertPanelArea_(master) {
  if (fleetLegacyPanelInstalled_(master)) { fleetValidateLegacyPanel_(master); return; }
  var table = table_(master, MASTER_SCHEMA_), optional = headerMap_(table.headers, FLEET_ADMIN_.optional, false), ownedColumns = {};
  ['stableId', 'usage'].forEach(function (key) { if (optional[key] != null) ownedColumns[optional[key]] = true; });
  var range = master.getRange(1, 10, 25, 7), values = range.getValues(), formulas = range.getFormulas();
  if (values.some(function (row, index) { return row.some(function (value, column) { return !ownedColumns[column + 9] && (!blank_(value) || !!formulas[index][column]); }); })) {
    fail_('PANEL_AREA_CONFLICT', '社用車一覧のJ〜P列に既存データがあります。既存データを保持して停止しました。');
  }
}

function fleetValidateLegacyPanel_(master) {
  var labels = fleetLegacyLabels_(), inputs = {}, buttons = { '4:14': 'rename', '9:14': 'stop', '13:14': 'restore', '17:14': 'add' };
  Object.keys(FLEET_ADMIN_.legacyInputs).forEach(function (key) { inputs[FLEET_ADMIN_.legacyInputs[key].join(':')] = true; });
  var range = master.getRange(1, 10, 25, 7), values = range.getValues(), formulas = range.getFormulas();
  for (var row = 0; row < 25; row++) for (var col = 0; col < 7; col++) {
    var key = (row + 1) + ':' + (col + 10), value = values[row][col], formula = formulas[row][col];
    if (inputs[key] && !formula) {
      if (key === FLEET_ADMIN_.legacyInputs.transmission.join(':') && !blank_(value) && ['AT', 'MT'].indexOf(normalizeId_(value).toUpperCase()) < 0) fail_('PANEL_AREA_CONFLICT', '旧変速機欄に想定外の値があります。入力を保持して停止しました。');
      continue;
    }
    if (buttons[key] && fleetPanelLinkMatches_(formula, buttons[key], '内容を確認・実行')) continue;
    if (!formula && labels[key] && labels[key].indexOf(String(value)) >= 0) continue;
    if (!blank_(value) || formula) fail_('PANEL_AREA_CONFLICT', '旧管理表に想定外の値があります。旧表を保持して停止しました。');
  }
  Object.keys(labels).forEach(function (key) {
    var parts = key.split(':').map(Number);
    if (labels[key].indexOf(String(master.getRange(parts[0], parts[1]).getValue())) < 0) fail_('PANEL_AREA_CONFLICT', '旧管理表を識別できません。旧表を保持して停止しました。');
  });
  Object.keys(buttons).forEach(function (key) {
    var parts = key.split(':').map(Number);
    if (!fleetPanelLinkMatches_(master.getRange(parts[0], parts[1]).getFormulas()[0][0], buttons[key], '内容を確認・実行')) fail_('PANEL_AREA_CONFLICT', '旧管理リンクを識別できません。旧表を保持して停止しました。');
  });
}

function fleetAssertManagementSheet_(sheet) {
  if (!sheet || sheet.getLastRow() === 0) return;
  if (sheet.getRange(2, 2).getValue() !== FLEET_ADMIN_.panel || sheet.getLastRow() > 27 || sheet.getLastColumn() > 9) {
    fail_('PANEL_AREA_CONFLICT', '同名のシートに既存データがあります。変更せず停止しました。');
  }
  var labels = fleetManagementLabels_(), inputs = {}, buttons = {};
  Object.keys(FLEET_ADMIN_.inputs).forEach(function (key) { inputs[FLEET_ADMIN_.inputs[key].join(':')] = true; });
  fleetManagementButtons_().forEach(function (button) { buttons[button.row + ':' + button.col] = button; });
  var range = sheet.getRange(1, 1, 27, 9), values = range.getValues(), formulas = range.getFormulas();
  for (var row = 0; row < 27; row++) for (var col = 0; col < 9; col++) {
    var key = (row + 1) + ':' + (col + 1), value = values[row][col], formula = formulas[row][col];
    if (!formula && (inputs[key] || labels[key] === value)) continue;
    if (!formula && key === '23:6' && value === '変速機') continue;
    if (!formula && key === '23:7' && (blank_(value) || ['AT', 'MT'].indexOf(normalizeId_(value).toUpperCase()) >= 0)) continue;
    if (buttons[key] && fleetPanelLinkMatches_(formula, buttons[key].operation, buttons[key].label)) continue;
    if (!blank_(value) || formula) fail_('PANEL_AREA_CONFLICT', '管理タブに想定外の値があります。既存入力を保持して停止しました。');
  }
}

function fleetRemoveTransmissionInput_(sheet) {
  if (!sheet) return false;
  fleetAssertManagementSheet_(sheet);
  var range = sheet.getRange(23, 6, 1, 2), values = range.getValues()[0], formulas = range.getFormulas()[0];
  if (formulas.some(function (value) { return !!value; }) || !blank_(values[0]) && values[0] !== '変速機' || !blank_(values[1]) && ['AT', 'MT'].indexOf(normalizeId_(values[1]).toUpperCase()) < 0) {
    fail_('PANEL_AREA_CONFLICT', '旧変速機欄に想定外の値があります。入力を保持して停止しました。');
  }
  range.clearContent().clearFormat().clearDataValidations();
  return true;
}

function fleetPanelValues_(sheet, map) {
  var values = {};
  Object.keys(map).forEach(function (key) { values[key] = sheet ? sheet.getRange(map[key][0], map[key][1]).getValue() : ''; });
  return values;
}

function fleetPanelSameValue_(key, left, right) {
  if (blank_(left) && blank_(right)) return true;
  if (key === 'inspection') { try { return dateValue_(left) === dateValue_(right); } catch (_) { return sameCell_(left, right); } }
  if (['renameVehicle', 'stopVehicle', 'restoreVehicle'].indexOf(key) >= 0) return normalizeId_(left) === normalizeId_(right);
  return sameCell_(left, right);
}

function fleetMergedPanelValues_(ss, sheet) {
  var master = ss.getSheetByName(DRIVE_LOG_.master), values = fleetPanelValues_(sheet, FLEET_ADMIN_.inputs);
  if (!fleetLegacyPanelInstalled_(master)) return values;
  fleetValidateLegacyPanel_(master);
  var legacy = fleetPanelValues_(master, FLEET_ADMIN_.legacyInputs);
  Object.keys(legacy).forEach(function (key) {
    if (key === 'transmission' || blank_(legacy[key])) return;
    if (!blank_(values[key]) && !fleetPanelSameValue_(key, values[key], legacy[key])) fail_('PANEL_AREA_CONFLICT', '新旧の管理表に異なる入力があります。両方の入力を保持して停止しました。');
    if (blank_(values[key])) values[key] = legacy[key];
  });
  return values;
}

function fleetInstallPanel_(ss, url) {
  var sheet = ss.getSheetByName(FLEET_ADMIN_.panel);
  fleetAssertManagementSheet_(sheet);
  var values = fleetMergedPanelValues_(ss, sheet);
  if (sheet) fleetRemoveTransmissionInput_(sheet);
  if (!sheet) sheet = ss.insertSheet(FLEET_ADMIN_.panel, ss.getSheetByName(DRIVE_LOG_.master).getIndex());
  sheet.getRange(2, 2).setValue(FLEET_ADMIN_.panel); // An interrupted stage can be safely resumed.
  sheet.getRange(1, 1, 27, 9).breakApart().clearFormat().setBackground('#faf9f6').setFontFamily('Arial').setFontSize(10).setFontColor('#253247').setWrap(true).setVerticalAlignment('middle');
  [16, 136, 172, 16, 30, 136, 172, 16, 16].forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });
  for (var row = 1; row <= 27; row++) sheet.setRowHeight(row, 24);
  [6, 7, 15, 16].forEach(function (row) { sheet.setRowHeight(row, 9); });
  sheet.setRowHeight(2, 34); sheet.setRowHeight(21, 36);
  sheet.setHiddenGridlines(true);
  [[5, 2, 7, 3], [5, 6, 7, 3], [14, 2, 7, 3], [14, 6, 12, 3]].forEach(function (card) {
    sheet.getRange(card[0], card[1], card[2], card[3]).setBackground('#ffffff').setBorder(true, true, true, true, false, false, '#e2e1dc', null);
  });
  var labels = fleetManagementLabels_();
  Object.keys(labels).forEach(function (key) { var parts = key.split(':').map(Number); sheet.getRange(parts[0], parts[1]).setValue(labels[key]); });
  sheet.getRange(2, 2, 1, 7).merge().setBackground('#23334d').setFontColor('#ffffff').setFontSize(17).setFontWeight('bold');
  [[5, 2], [5, 6], [14, 2], [14, 6]].forEach(function (position) {
    sheet.getRange(position[0], position[1], 1, 3).merge().setBackground('#efeee9').setFontWeight('bold').setFontSize(11);
  });
  Object.keys(FLEET_ADMIN_.inputs).forEach(function (key) {
    var position = FLEET_ADMIN_.inputs[key];
    sheet.getRange(position[0], position[1]).setValue(values[key]).setBackground('#edf1f8').setBorder(null, null, true, null, null, null, '#aebbd1', null);
  });
  sheet.getRange(20, 7).setNumberFormat('yyyy-mm-dd');
  [21, 22].forEach(function (row) { sheet.getRange(row, 7).setNumberFormat('0'); });
  fleetManagementButtons_().forEach(function (button) {
    sheet.getRange(button.row, button.col, 1, 3).merge().setValue('=HYPERLINK("' + url + '&operation=' + button.operation + '","' + button.label + '")')
      .setBackground('#526ba5').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setRowHeight(button.row, 32);
  });
  fleetRefreshPanel_(ss, sheet);
  SpreadsheetApp.flush();
  var saved = fleetPanelValues_(sheet, FLEET_ADMIN_.inputs);
  if (Object.keys(values).some(function (key) { return !fleetPanelSameValue_(key, values[key], saved[key]); })) fail_('PANEL_AREA_CONFLICT', '入力の移設結果を確認できません。旧表は保持されています。');
  fleetSetPanelMeta_(sheet, FLEET_ADMIN_.panelMetadata, 'ready');
  SpreadsheetApp.flush();
  return sheet;
}

function fleetRefreshPanel_(ss, onlySheet) {
  var vehicles = loadVehicles_(ss), targets = [], management = ss.getSheetByName(FLEET_ADMIN_.panel), master = ss.getSheetByName(DRIVE_LOG_.master);
  if (onlySheet) targets.push({ sheet: onlySheet, map: FLEET_ADMIN_.inputs });
  else {
    if (fleetPanelInstalled_(management)) targets.push({ sheet: management, map: FLEET_ADMIN_.inputs });
    if (fleetLegacyPanelInstalled_(master)) targets.push({ sheet: master, map: FLEET_ADMIN_.legacyInputs });
  }
  var active = vehicles.filter(function (v) { return v.active; }).map(function (v) { return v.number; });
  targets.forEach(function (target) {
    function dropdown(key, list) {
      var position = target.map[key], range = target.sheet.getRange(position[0], position[1]);
      if (!list.length) range.clearDataValidations();
      else range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
    }
    dropdown('renameVehicle', active); dropdown('stopVehicle', active);
    dropdown('restoreVehicle', vehicles.filter(function (v) { return !v.active; }).map(function (v) { return v.number; }));
    dropdown('model', FLEET_ADMIN_.models); dropdown('fuel', ['ガソリン', '軽油']);
  });
}

function fleetReadPanel_(ss, vehicles) {
  var sheet = ss.getSheetByName(FLEET_ADMIN_.panel), map = FLEET_ADMIN_.inputs;
  var result = { rename: {}, stop: {}, restore: {}, add: {} };
  if (!fleetPanelInstalled_(sheet)) { sheet = ss.getSheetByName(DRIVE_LOG_.master); map = FLEET_ADMIN_.legacyInputs; if (!fleetLegacyPanelInstalled_(sheet)) return result; }
  var values = fleetPanelValues_(sheet, map);
  function selected(key, active) { return vehicles.filter(function (v) { return v.active === active && normalizeId_(v.number) === normalizeId_(values[key]); })[0]; }
  var rename = selected('renameVehicle', true), stop = selected('stopVehicle', true), restore = selected('restoreVehicle', false);
  if (rename) result.rename = { vehicleId: rename.id, number: String(values.renameNumber || '') };
  if (stop) result.stop = { vehicleId: stop.id, active: false };
  if (restore) result.restore = { vehicleId: restore.id, active: true };
  if (['number', 'model', 'fuel', 'inspection', 'initialOil', 'initialOdometer'].some(function (key) { return !blank_(values[key]); })) {
    var inspection = values.inspection;
    try { inspection = dateValue_(inspection); } catch (_) { inspection = String(inspection || ''); }
    result.add = { number: String(values.number || ''), model: String(values.model || ''), fuelType: String(values.fuel || ''), inspectionDue: inspection,
      initialOil: blank_(values.initialOil) ? null : values.initialOil, initialOdometer: blank_(values.initialOdometer) ? null : values.initialOdometer };
  }
  return result;
}

// Stage two: run only after the new deployment and its dedicated tab work.
function removeLegacyFleetPanel_() {
  var access = fleetAdminAccess_(), lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var ss = access.ss, master = ss.getSheetByName(DRIVE_LOG_.master), sheet = ss.getSheetByName(FLEET_ADMIN_.panel);
    if (!fleetPanelInstalled_(sheet)) fail_('FLEET_NOT_INSTALLED', '先に新しい管理タブの設置と公開を確認してください。');
    if (fleetPendingVehicleIds_(ss).length) fail_('VEHICLE_PENDING', '保存途中の車両管理があります。保存結果を確認してから旧表を撤去してください。');
    fleetAssertManagementSheet_(sheet);
    var legacy = fleetLegacyPanelInstalled_(master), cleanup = fleetPanelMeta_(sheet, FLEET_ADMIN_.cleanupMetadata);
    if (!legacy && (!cleanup || cleanup.getValue() !== 'pending')) return { removed: false, managementUrl: sheetUrl_(ss, sheet.getSheetId()) };
    if (legacy) {
      var previous = fleetPanelValues_(sheet, FLEET_ADMIN_.inputs);
      var values = fleetMergedPanelValues_(ss, sheet);
      Object.keys(values).forEach(function (key) {
        if (blank_(previous[key]) && !blank_(values[key])) { var position = FLEET_ADMIN_.inputs[key]; sheet.getRange(position[0], position[1]).setValue(values[key]); }
      });
      SpreadsheetApp.flush();
      var saved = fleetPanelValues_(sheet, FLEET_ADMIN_.inputs);
      if (Object.keys(values).some(function (key) { return !fleetPanelSameValue_(key, values[key], saved[key]); })) fail_('PANEL_AREA_CONFLICT', '入力の引継ぎを確認できません。旧表を保持しました。');
      fleetSetPanelMeta_(sheet, FLEET_ADMIN_.cleanupMetadata, 'pending');
      SpreadsheetApp.flush();
    } else {
      var oldRange = master.getRange(1, 10, 25, 7), oldValues = oldRange.getValues(), oldFormulas = oldRange.getFormulas();
      if (oldValues.some(function (row, index) { return row.some(function (value, col) { return !blank_(value) || !!oldFormulas[index][col]; }); })) {
        fail_('PANEL_AREA_CONFLICT', '旧表の撤去中に別の値が追加されています。変更せず停止しました。');
      }
    }
    var resetFormats = [[21, 'yyyy-mm-dd'], [22, '0'], [23, '0']].filter(function (entry) { return master.getRange(entry[0], 11).getNumberFormat() === entry[1]; });
    master.getRange(1, 10, 25, 7).clearContent().clearFormat().clearDataValidations().breakApart();
    resetFormats.forEach(function (entry) { master.getRange(entry[0], 11).setNumberFormat('General'); });
    [[10, 210], [11, 230], [12, 16], [13, 16], [14, 190], [15, 16], [16, 16]].forEach(function (entry) {
      if (master.getColumnWidth(entry[0]) === entry[1]) master.setColumnWidth(entry[0], 100);
    });
    SpreadsheetApp.flush();
    fleetSetPanelMeta_(sheet, FLEET_ADMIN_.cleanupMetadata, 'done');
    return { removed: true, managementUrl: sheetUrl_(ss, sheet.getSheetId()) };
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}
