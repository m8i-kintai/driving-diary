/** Private owner-run layout maintenance. No public RPC and no vehicle ID reset. */
var FLEET_MASTER_COLUMNS_ = Object.freeze({
  note: '自動管理・編集しない', protection: '運転日報・自動管理列 I:J'
});

function compactFleetMasterColumns_() {
  var access = fleetAdminAccess_(), lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = access.ss, master = ss.getSheetByName(DRIVE_LOG_.master);
    if (fleetPendingVehicleIds_(ss).length) fail_('VEHICLE_PENDING', '保存途中の車両管理があります。保存結果を確認してから列を整理してください。');
    var table = table_(master, MASTER_SCHEMA_);
    var optional = headerMap_(table.headers, { stableId: ['車両ID'], usage: ['使用状況'], transmission: ['変速機', 'ミッション'] }, false);
    var completed = optional.usage === 8 && optional.stableId === 9;
    if (!completed && !(optional.stableId === 8 && optional.usage === 16)) fail_('SCHEMA_ERROR', '車両ID・使用状況の列配置を確認してください。変更せず停止しました。');
    if (optional.transmission != null && optional.transmission !== 17) fail_('SCHEMA_ERROR', '変速機の列が想定と異なります。変更せず停止しました。');
    var lastRow = Math.max(master.getLastRow(), table.headerRow);
    var vehicles = loadVehicles_(ss);
    vehicles.forEach(function (vehicle) {
      if (blank_(master.getRange(vehicle.masterRow, optional.stableId + 1).getValue())) fail_('SCHEMA_ERROR', '固定済みの車両IDがない車両があります。変更せず停止しました。');
    });
    var originalBusiness = fleetMasterBusinessSnapshot_(master, lastRow);
    var originalIdentity = fleetMasterIdentitySnapshot_(ss, vehicles);
    var originalTransmission = fleetMasterTransmissionSnapshot_(master, table.headerRow, lastRow, vehicles);
    if (!completed) {
      // moveColumns moves every row of Q, even though the selector is one cell.
      // Destination 9 is evaluated before the move: Q becomes I; old I becomes J.
      master.moveColumns(master.getRange(1, 17, 1, 1), 9);
      SpreadsheetApp.flush();
    }
    fleetVerifyMasterCompaction_(ss, master, lastRow, originalBusiness, originalIdentity);
    var currentTransmission = fleetMasterTransmissionSnapshot_(master, table.headerRow, lastRow, vehicles);
    if (currentTransmission.signature !== originalTransmission.signature) fail_('ROW_CONFLICT', '整理中にR列が変更されています。値を保持して停止しました。');
    if (currentTransmission.populated) {
      master.getRange(table.headerRow, 18, lastRow - table.headerRow + 1, 1).clearContent();
      SpreadsheetApp.flush();
    }
    fleetVerifyMasterCompaction_(ss, master, lastRow, originalBusiness, originalIdentity);
    var remaining = master.getRange(table.headerRow, 18, lastRow - table.headerRow + 1, 1);
    if (remaining.getValues().some(function (row) { return !blank_(row[0]); }) || remaining.getFormulas().some(function (row) { return !!row[0]; })) {
      fail_('ROW_CONFLICT', 'R列の撤去結果を確認できません。');
    }
    [9, 10].forEach(function (column) { master.getRange(table.headerRow, column).setNote(FLEET_MASTER_COLUMNS_.note); });
    master.setColumnWidth(9, 100); master.setColumnWidth(10, 140);
    var protection = fleetProtectMasterColumns_(master);
    SpreadsheetApp.flush();
    return { compacted: true, moved: !completed, vehicles: vehicles.length,
      businessColumnsUnchanged: true, identitiesUnchanged: true, statusesUnchanged: true,
      transmissionCleared: !!currentTransmission.populated, warningOnly: protection.isWarningOnly(), protectedColumns: 'I:J' };
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}

function fleetMasterBusinessSnapshot_(master, lastRow) {
  var range = master.getRange(1, 1, lastRow, 8);
  return JSON.stringify({ values: range.getValues(), formulas: range.getFormulas() });
}

function fleetMasterIdentitySnapshot_(ss, vehicles) {
  return stableJson_(vehicles.map(function (vehicle) {
    return { row: vehicle.masterRow, id: vehicle.id, active: vehicle.active, gid: resolveVehicleSheet_(ss, vehicle).getSheetId() };
  }));
}

function fleetVerifyMasterCompaction_(ss, master, lastRow, originalBusiness, originalIdentity) {
  var table = table_(master, MASTER_SCHEMA_);
  var optional = headerMap_(table.headers, { stableId: ['車両ID'], usage: ['使用状況'] }, false);
  if (optional.usage !== 8 || optional.stableId !== 9 || master.getLastRow() > lastRow ||
      fleetMasterBusinessSnapshot_(master, lastRow) !== originalBusiness || fleetMasterIdentitySnapshot_(ss, loadVehicles_(ss)) !== originalIdentity) {
    fail_('ROW_CONFLICT', '列整理後の車両情報が一致しません。追加の変更をせず停止しました。');
  }
}

function fleetMasterTransmissionSnapshot_(master, headerRow, lastRow, vehicles) {
  var range = master.getRange(headerRow, 18, lastRow - headerRow + 1, 1);
  var values = range.getValues(), formulas = range.getFormulas(), header = values[0][0];
  var knownHeader = blank_(header) || ['変速機', 'ミッション'].map(normalizeHeader_).indexOf(normalizeHeader_(header)) >= 0;
  if (!knownHeader || formulas.some(function (row) { return !!row[0]; })) fail_('SCHEMA_ERROR', 'R列に想定外の見出しまたは数式があります。変更せず停止しました。');
  var vehicleRows = {};
  vehicles.forEach(function (vehicle) { vehicleRows[vehicle.masterRow] = true; });
  for (var index = 1; index < values.length; index++) {
    var value = values[index][0];
    if (!blank_(value) && (blank_(header) || !vehicleRows[headerRow + index] || normalizeId_(value).toUpperCase() !== 'AT')) {
      fail_('SCHEMA_ERROR', 'R列にAT以外または対象外行の値があります。値を保持して停止しました。');
    }
  }
  return { signature: JSON.stringify({ values: values, formulas: formulas }), populated: values.some(function (row) { return !blank_(row[0]); }) };
}

// Warning-only avoids changing the Google editors allowed to use the tool.
// Reuse the owned protection and extend it to the current sheet height on rerun.
function fleetProtectMasterColumns_(master) {
  var existing = master.getProtections(SpreadsheetApp.ProtectionType.RANGE).filter(function (protection) {
    return protection.getDescription() === FLEET_MASTER_COLUMNS_.protection;
  });
  var range = master.getRange(1, 9, master.getMaxRows(), 2);
  var protection = existing[0] || range.protect().setDescription(FLEET_MASTER_COLUMNS_.protection);
  protection.setRange(range).setWarningOnly(true);
  return protection;
}
