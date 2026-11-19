/** Fleet administration shares this project's ScriptLock with driving writes.
 * Deploy its ?view=fleet URL separately as USER_ACCESSING (Google sign-in).
 * Never route these operations through the driver doPost endpoint.
 */
var FLEET_ADMIN_ = Object.freeze({
  journal: '_運転日報_車両管理',
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
  return { adminEmail: email, vehicles: vehicles.filter(function (v) { return pending.indexOf(v.id) < 0; }).map(function (v) { return fleetPublicVehicle_(ss, v); }),
    models: FLEET_ADMIN_.models.slice(), fuels: ['ガソリン', '軽油'], masterUrl: sheetUrl_(ss, ss.getSheetByName(DRIVE_LOG_.master).getSheetId()), panel: fleetReadPanel_(ss, vehicles) };
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
  if ([DRIVE_LOG_.master, DRIVE_LOG_.template, DRIVE_LOG_.trips, DRIVE_LOG_.requests, FLEET_ADMIN_.journal].indexOf(number) >= 0) fail_('VALIDATION_ERROR', '管理用シート名は車番に使用できません。');
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
    if (FLEET_ADMIN_.models.indexOf(p.model) < 0 || ['ガソリン', '軽油'].indexOf(p.fuelType) < 0 || typeof p.requiresClutch !== 'boolean') fail_('VALIDATION_ERROR', '車種・燃料・変速機を確認してください。');
    var inspection = dateValue_(p.inspectionDue), initialOil = numeric_(p.initialOil, '初回オイル交換距離', true), initial = numeric_(p.initialOdometer, '初回確認時の距離', false);
    fleetAssertNumberFree_(ss, vehicles, number, null);
    fleetValidateTemplate_(ss.getSheetByName(DRIVE_LOG_.template));
    revision = fleetAddRevision_(ss);
    Object.assign(operation, { vehicleId: request.requestId.toLowerCase(), masterRow: meta.sheet.getLastRow() + 1, sheetId: null,
      temporarySheetName: '_車両登録_' + request.requestId.toLowerCase(), sheetName: number,
      templateId: ss.getSheetByName(DRIVE_LOG_.template).getSheetId(), before: null,
      fields: { number: number, model: p.model, fuel: p.fuelType, inspection: inspection,
        initialOil: initialOil, initialOdometer: initial, currentOdometer: initial, stableId: request.requestId.toLowerCase(), usage: '使用中', transmission: p.requiresClutch ? 'MT' : 'AT' } });
    Object.assign(summary, { vehicleId: '', previousNumber: '', number: number, active: true, model: p.model, fuelType: p.fuelType,
      inspectionDue: inspection, initialOil: initialOil, initialOdometer: initial, currentOdometer: initial, requiresClutch: p.requiresClutch, sheetUrl: '' });
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
  var adminUrlPattern = /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})\/s\/[A-Za-z0-9_-]+\/exec(?:\?view=fleet)?$/;
  if (typeof adminUrl !== 'string' || !adminUrlPattern.test(adminUrl)) fail_('VALIDATION_ERROR', '管理用Webアプリの公開URLを指定してください。');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var ss = access.ss, vehicles = loadVehicles_(ss), master = ss.getSheetByName(DRIVE_LOG_.master);
    fleetAssertPanelArea_(master);
    if (fleetPendingVehicleIds_(ss).length) fail_('VEHICLE_PENDING', '保存途中の管理操作があります。');
    vehicles.forEach(function (v) { fleetAssertVehicleIdle_(ss, v.id, true); resolveVehicleSheet_(ss, v); });
    var table = table_(master, MASTER_SCHEMA_), optional = headerMap_(table.headers, FLEET_ADMIN_.optional, false);
    var preferred = { stableId: 8, usage: 16, transmission: 17 }, next = Math.max(table.width, 18) + 1;
    ['stableId', 'usage', 'transmission'].forEach(function (key) {
      if (optional[key] == null) {
        var column = preferred[key];
        if (!blank_(master.getRange(table.headerRow, column + 1).getValue())) column = next++ - 1;
        optional[key] = column; master.getRange(table.headerRow, column + 1).setValue(FLEET_ADMIN_.optional[key][0]);
      }
    });
    vehicles.forEach(function (v) {
      master.getRange(v.masterRow, optional.stableId + 1).setValue(v.id);
      master.getRange(v.masterRow, optional.usage + 1).setValue(v.active ? '使用中' : '使用停止');
      if (blank_(master.getRange(v.masterRow, optional.transmission + 1).getValue())) master.getRange(v.masterRow, optional.transmission + 1).setValue(v.requiresClutch ? 'MT' : 'AT');
      master.getRange(v.masterRow, table.map.link + 1).setValue('=HYPERLINK("' + sheetUrl_(ss, resolveVehicleSheet_(ss, v).getSheetId()) + '","運転日リンク")');
    });
    fleetJournal_(ss, true);
    var url = adminUrl.replace(/\?view=fleet$/, '') + '?view=fleet';
    fleetInstallPanel_(ss, url);
    SpreadsheetApp.flush();
    fleetRequireInstalled_(ss);
    return { installed: true, vehicles: vehicles.length, adminUrl: url, panelRange: 'J1:P25' };
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}

function fleetPanelInstalled_(master) { return master.getRange(1, 10).getValue() === '社用車 管理ツール'; }

function fleetAssertPanelArea_(master) {
  if (!fleetPanelInstalled_(master) && master.getRange(1, 10, 25, 7).getValues().some(function (row) { return row.some(function (value) { return !blank_(value); }); })) {
    fail_('PANEL_AREA_CONFLICT', '社用車一覧のJ〜P列に既存データがあります。管理パネルを設置せず停止しました。');
  }
}

function fleetInstallPanel_(ss, url) {
  var master = ss.getSheetByName(DRIVE_LOG_.master);
  var labels = { 1: '社用車 管理ツール', 2: '入力後、右の「内容を確認・実行」を押してください', 3: '運転中・保存中の車両は変更できません',
    4: '番号変更', 5: '対象車両', 6: '新しい車番', 9: '運用から外す', 10: '対象車両',
    13: '運用に戻す', 14: '対象車両', 17: '新規追加', 18: '車番', 19: '車種', 20: '燃料',
    21: '車検満了日', 22: '前回オイル交換時メーター (km)', 23: '初回確認時の距離 (km)', 24: '変速機 (AT/MT)' };
  Object.keys(labels).forEach(function (row) { master.getRange(Number(row), 10).setValue(labels[row]); });
  [[4, 'rename'], [9, 'stop'], [13, 'restore'], [17, 'add']].forEach(function (entry) {
    master.getRange(entry[0], 14).setValue('=HYPERLINK("' + url + '&operation=' + entry[1] + '","内容を確認・実行")');
    master.getRange(entry[0], 10, 1, 7).setBackground('#1e3a5f').setFontColor('#ffffff').setFontWeight('bold');
    master.getRange(entry[0], 14).setBackground('#435bd3').setFontColor('#ffffff');
  });
  master.getRange(1, 10, 25, 7).setFontFamily('Arial').setFontSize(10).setWrap(true);
  master.getRange(1, 10).setFontSize(14).setFontWeight('bold');
  [5, 6, 10, 14, 18, 19, 20, 21, 22, 23, 24].forEach(function (row) { master.getRange(row, 11).setBackground('#edf3ff'); });
  master.setColumnWidth(10, 210); master.setColumnWidth(11, 230); master.setColumnWidth(14, 190);
  [12, 13, 15, 16].forEach(function (column) { master.setColumnWidth(column, 16); });
  master.getRange(21, 11).setNumberFormat('yyyy-mm-dd');
  [22, 23].forEach(function (row) { master.getRange(row, 11).setNumberFormat('0'); });
  fleetRefreshPanel_(ss);
}

function fleetRefreshPanel_(ss) {
  var master = ss.getSheetByName(DRIVE_LOG_.master);
  if (!fleetPanelInstalled_(master)) return;
  var vehicles = loadVehicles_(ss);
  function dropdown(row, values) {
    var range = master.getRange(row, 11);
    if (!values.length) range.clearDataValidations();
    else range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  }
  var active = vehicles.filter(function (v) { return v.active; }).map(function (v) { return v.number; });
  dropdown(5, active); dropdown(10, active);
  dropdown(14, vehicles.filter(function (v) { return !v.active; }).map(function (v) { return v.number; }));
  dropdown(19, FLEET_ADMIN_.models); dropdown(20, ['ガソリン', '軽油']); dropdown(24, ['AT', 'MT']);
}

function fleetReadPanel_(ss, vehicles) {
  var master = ss.getSheetByName(DRIVE_LOG_.master), result = { rename: {}, stop: {}, restore: {}, add: {} };
  if (!fleetPanelInstalled_(master)) return result;
  function value(row) { return master.getRange(row, 11).getValue(); }
  function selected(row, active) {
    var key = normalizeId_(value(row));
    return vehicles.filter(function (v) { return v.active === active && normalizeId_(v.number) === key; })[0];
  }
  var rename = selected(5, true), stop = selected(10, true), restore = selected(14, false);
  if (rename) result.rename = { vehicleId: rename.id, number: String(value(6) || '') };
  if (stop) result.stop = { vehicleId: stop.id, active: false };
  if (restore) result.restore = { vehicleId: restore.id, active: true };
  if ([18, 19, 20, 21, 22, 23, 24].some(function (row) { return !blank_(value(row)); })) {
    var inspection = value(21);
    try { inspection = dateValue_(inspection); } catch (_) { inspection = String(inspection || ''); }
    result.add = { number: String(value(18) || ''), model: String(value(19) || ''), fuelType: String(value(20) || ''),
      inspectionDue: inspection, initialOil: blank_(value(22)) ? null : value(22), initialOdometer: blank_(value(23)) ? null : value(23),
      requiresClutch: normalizeId_(value(24)).toUpperCase() === 'MT' };
  }
  return result;
}
