import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../demo.js';

const CHECKS = ['brakes', 'tires', 'engine', 'battery', 'lights', 'washer', 'wipers', 'glass', 'body', 'clutch'];
function setup(employee) {
  const data = new Map();
  const env = { localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) } };
  let clock = new Date('2026-11-12T08:00:00+09:00');
  const options = { clock: () => clock, ...(employee ? { employee } : {}) };
  return { env, options, api: createDemoApi(env, options), advance() { clock = new Date(clock.getTime() + 3600_000); } };
}
async function startPayload(api, overrides = {}) {
  const { vehicles, departments } = await api.bootstrap();
  return { vehicleId: vehicles[0].id, department: departments[0], checks: Object.fromEntries(CHECKS.map(key => [key, true])), before: { confirmed: false, reading: null, presence: '無' }, ...overrides };
}
function finishPayload(trip, overrides = {}) {
  return { tripId: trip.id, destination: 'プレビューの現場', endOdometer: trip.startOdometer + 60, refueled: false, fuelLiters: null, oilChanged: false, notes: '', after: { confirmed: false, reading: null, presence: '無' }, ...overrides };
}

test('preview exposes 48 fictitious vehicles, all five models and an unregistered initial odometer', async () => {
  const { api } = setup();
  const result = await api.bootstrap();
  assert.equal(result.vehicles.length, 48);
  assert.equal(new Set(result.vehicles.map(vehicle => vehicle.id)).size, 48);
  assert.deepEqual(new Set(result.vehicles.map(vehicle => vehicle.modelKey)), new Set(['hiace', 'hijet', 'succeed', 'probox', 'toyoace']));
  assert.ok(result.vehicles.every(vehicle => vehicle.number.includes('サンプル')));
  assert.equal(result.departments.length, 13);
  assert.ok(result.departments.includes('建設2G'));
  assert.equal(result.serverTime, '2026-11-11T23:00:00.000Z');
  const unregistered = result.vehicles.find(vehicle => vehicle.currentOdometer === null);
  assert.ok(unregistered);
  assert.equal((await api.vehicleContext(unregistered.id)).startOdometer, null);
  await assert.rejects(api.startTrip(await startPayload(api, { vehicleId: unregistered.id }), 'unregistered-start'), { code: 'INITIAL_ODOMETER_REQUIRED' });
});

test('preview bootstraps its authenticated employee and records that identity without a lookup', async () => {
  const { api } = setup();
  const result = await api.bootstrap();
  assert.deepEqual(result.employee, { id: '1001', name: 'デモ運転者' });
  assert.equal(api.launchContext.employeeId, '1001');
  assert.equal(api.lookupEmployee, undefined);
  result.employee.name = 'outside mutation';
  assert.equal((await api.bootstrap()).employee.name, 'デモ運転者');
  const { trip } = await api.startTrip(await startPayload(api, { employeeName: '任意の氏名' }), 'identity-start');
  assert.equal(trip.employeeId, '1001');
  assert.equal(trip.employeeName, 'デモ運転者');
});

test('a different employee ID cannot replace the authenticated preview driver', async () => {
  const { api } = setup();
  const payload = await startPayload(api, { employeeId: '2002' });
  await assert.rejects(api.startTrip(payload, 'identity-mismatch'), { code: 'EMPLOYEE_MISMATCH' });
  assert.equal((await api.listHistory(payload.vehicleId)).trips.length, 0);
  const { trip } = await api.startTrip({ ...payload, employeeId: '1001' }, 'identity-match');
  assert.equal(trip.employeeName, 'デモ運転者');
});

test('another authenticated employee can complete the departure and both trusted names are recorded', async () => {
  const first = { id: '1001', name: '出発者A' };
  const second = { id: '2002', name: '完了者B' };
  const { api, env, options } = setup(first);
  const completingApi = createDemoApi(env, { ...options, employee: second });
  const started = await api.startTrip(await startPayload(api), 'handover-start');
  assert.equal(started.trip.recordedDriverName, '出発者A');
  assert.equal('completedDepartment' in started.trip, false);
  const context = await completingApi.vehicleContext(started.trip.vehicleId);
  assert.equal(context.activeTrip.id, started.trip.id);
  assert.equal(context.activeTrip.recordedDriverName, '出発者A');
  const payload = finishPayload(started.trip, { employeeName: '偽の氏名', completedByEmployeeId: '9999', completedByEmployeeName: '偽の完了者', recordedDriverName: '任意の表示' });
  const completed = await completingApi.finishTrip(payload, 'handover-finish');
  assert.equal(completed.trip.employeeId, first.id);
  assert.equal(completed.trip.employeeName, first.name);
  assert.equal(completed.trip.completedByEmployeeId, second.id);
  assert.equal(completed.trip.completedByEmployeeName, second.name);
  assert.equal(completed.trip.recordedDriverName, '出発者A ／ 完了者B');
  assert.equal((await api.getTrip(started.trip.id)).trip.recordedDriverName, '出発者A ／ 完了者B');
  assert.equal((await api.listHistory(started.trip.vehicleId)).trips[0].recordedDriverName, '出発者A ／ 完了者B');
  assert.equal((await api.vehicleContext(started.trip.vehicleId)).activeTrip, null);
  assert.equal((await api.listHistory(started.trip.vehicleId)).trips.length, 1);
});

test('recorded driver names are combined by employee ID rather than spelling', async () => {
  for (const [completer, expected] of [
    [{ id: '1001', name: '更新後の氏名' }, '出発時氏名'],
    [{ id: '2002', name: '出発時氏名' }, '出発時氏名 ／ 出発時氏名'],
  ]) {
    const { api, env, options } = setup({ id: '1001', name: '出発時氏名' });
    const { trip } = await api.startTrip(await startPayload(api), 'name-start');
    const completingApi = createDemoApi(env, { ...options, employee: completer });
    assert.deepEqual((await completingApi.bootstrap()).employee, completer);
    const result = await completingApi.finishTrip(finishPayload(trip), 'name-finish');
    assert.equal(result.trip.recordedDriverName, expected);
    assert.equal(result.trip.completedByEmployeeName, completer.name);
  }
});

test('mutation receipts can only be retried by the authenticated employee who made that action', async () => {
  const { api, env, options } = setup({ id: '1001', name: '出発者A' });
  const other = createDemoApi(env, { ...options, employee: { id: '2002', name: '完了者B' } });
  const start = await startPayload(api);
  const started = await api.startTrip(start, 'owned-start');
  await assert.rejects(other.startTrip(start, 'owned-start'), { code: 'EMPLOYEE_MISMATCH' });
  assert.deepEqual(await api.startTrip(start, 'owned-start'), started);
  const finish = finishPayload(started.trip);
  const completed = await other.finishTrip(finish, 'owned-finish');
  await assert.rejects(api.finishTrip(finish, 'owned-finish'), { code: 'EMPLOYEE_MISMATCH' });
  assert.deepEqual(await other.finishTrip(finish, 'owned-finish'), completed);
  await assert.rejects(api.finishTrip(finish, 'new-finish'), { code: 'TRIP_ALREADY_COMPLETED' });
  assert.equal((await api.listHistory(start.vehicleId)).trips.length, 1);
});

test('legacy finish receipts without a completed-by employee belong to the departure employee', async () => {
  const { api, env, options } = setup({ id: '1001', name: '以前の運転者' });
  const { trip } = await api.startTrip(await startPayload(api), 'legacy-start');
  const finish = finishPayload(trip);
  await api.finishTrip(finish, 'legacy-finish');
  const key = 'drivelog.demo.v1';
  const saved = JSON.parse(env.localStorage.getItem(key));
  const receipt = saved.receipts.find(item => item.id === 'legacy-finish');
  delete receipt.ownerEmployeeId;
  delete receipt.result.trip.completedByEmployeeId;
  delete receipt.result.trip.completedByEmployeeName;
  delete receipt.result.trip.recordedDriverName;
  env.localStorage.setItem(key, JSON.stringify(saved));
  const restored = createDemoApi(env, options);
  assert.equal((await restored.finishTrip(finish, 'legacy-finish')).trip.recordedDriverName, '以前の運転者');
  const other = createDemoApi(env, { ...options, employee: { id: '2002', name: '別の運転者' } });
  await assert.rejects(other.finishTrip(finish, 'legacy-finish'), { code: 'EMPLOYEE_MISMATCH' });
});

test('completion stores the selected department while retaining the departure department', async () => {
  const { api, env, options } = setup({ id: '1001', name: '出発者A' });
  const payload = await startPayload(api, { department: '建設1G' });
  const { trip } = await api.startTrip(payload, 'department-start');
  const other = createDemoApi(env, { ...options, employee: { id: '2002', name: '完了者B' } });
  const result = await other.finishTrip(finishPayload(trip, { department: '建設2G' }), 'department-finish');
  assert.equal(result.trip.department, '建設1G');
  assert.equal(result.trip.completedDepartment, '建設2G');
  const saved = (await api.getTrip(trip.id)).trip;
  assert.equal(saved.department, '建設1G');
  assert.equal(saved.completedDepartment, '建設2G');
});

test('an omitted completion department falls back while explicit invalid departments are rejected', async () => {
  const { api } = setup();
  const { trip } = await api.startTrip(await startPayload(api, { department: '管理G' }), 'department-fallback-start');
  for (const department of [null, '', '未登録の部門']) {
    await assert.rejects(api.finishTrip(finishPayload(trip, { department }), 'department-fallback-finish'), { code: 'VALIDATION_ERROR', message: '稼働部門を選択してください。' });
  }
  assert.equal((await api.getTrip(trip.id)).trip.status, 'active');
  const completed = await api.finishTrip(finishPayload(trip), 'department-fallback-finish');
  assert.equal(completed.trip.department, '管理G');
  assert.equal(completed.trip.completedDepartment, '管理G');
});

test('pre-drive alcohol presence blocks departure without creating a record', async () => {
  const { api } = setup();
  const payload = await startPayload(api, { before: { confirmed: true, reading: 0.12, presence: '有' } });
  await assert.rejects(api.startTrip(payload, 'alcohol-blocked'), { code: 'ALCOHOL_PRESENT', message: '酒気帯びが「有」のため出発できません。' });
  assert.equal((await api.vehicleContext(payload.vehicleId)).activeTrip, null);
  assert.equal((await api.listHistory(payload.vehicleId)).trips.length, 0);
  const corrected = { ...payload, before: { confirmed: true, reading: 0, presence: '無' } };
  const { trip } = await api.startTrip(corrected, 'alcohol-blocked');
  assert.equal(trip.before.presence, '無');
  assert.equal((await api.listHistory(payload.vehicleId)).trips.length, 1);
});

test('departure requires every applicable check and an explicit alcohol absence', async () => {
  const { api } = setup();
  const payload = await startPayload(api);
  for (const key of CHECKS.filter(key => key !== 'clutch')) {
    await assert.rejects(api.startTrip({ ...payload, checks: { ...payload.checks, [key]: false } }, 'missing-' + key), { code: 'VALIDATION_ERROR' });
  }
  for (const presence of [undefined, '', '未確認']) {
    await assert.rejects(api.startTrip({ ...payload, before: { ...payload.before, presence } }, 'unconfirmed-' + String(presence)), { code: 'VALIDATION_ERROR' });
  }
  assert.equal((await api.listHistory(payload.vehicleId)).trips.length, 0);
});

test('post-drive alcohol presence remains recordable at completion', async () => {
  const { api } = setup();
  const { trip } = await api.startTrip(await startPayload(api), 'after-presence-start');
  const result = await api.finishTrip(finishPayload(trip, { after: { confirmed: true, reading: 0.12, presence: '有' } }), 'after-presence-finish');
  assert.equal(result.trip.status, 'completed');
  assert.deepEqual(result.trip.after, { confirmed: true, reading: 0.12, presence: '有' });
  assert.equal((await api.getTrip(trip.id)).trip.after.presence, '有');
});

test('optional alcohol measurements preserve the difference between null and zero', async () => {
  const { api } = setup();
  const payload = await startPayload(api);
  const first = await api.startTrip(payload, 'alcohol-null');
  assert.equal(first.trip.before.reading, null);
  assert.equal(first.trip.before.confirmed, false);
  const completed = await api.finishTrip(finishPayload(first.trip, { after: { confirmed: true, reading: 0, presence: '無' } }), 'alcohol-zero');
  assert.equal(completed.trip.after.reading, 0);
  assert.equal(completed.trip.after.confirmed, true);
  const second = await api.startTrip({ ...payload, before: { confirmed: false, reading: 0, presence: '無' } }, 'before-zero');
  assert.equal(second.trip.before.reading, 0);
});

test('start and finish are idempotent across retries and a restored preview instance', async () => {
  const { api, env, options, advance } = setup();
  const payload = await startPayload(api);
  const started = await api.startTrip(payload, 'idempotent-start');
  advance();
  assert.deepEqual(await api.startTrip(payload, 'idempotent-start'), started);
  const restored = createDemoApi(env, options);
  assert.deepEqual(await restored.startTrip(payload, 'idempotent-start'), started);
  assert.equal((await restored.listHistory(payload.vehicleId)).trips.length, 1);
  const finish = finishPayload(started.trip);
  const completed = await restored.finishTrip(finish, 'idempotent-finish');
  advance();
  assert.deepEqual(await restored.finishTrip(finish, 'idempotent-finish'), completed);
  assert.deepEqual(await createDemoApi(env, options).finishTrip(finish, 'idempotent-finish'), completed);
  assert.equal((await restored.listHistory(payload.vehicleId)).trips.length, 1);
});

test('reusing a request ID with different data is rejected with the production contract code', async () => {
  const { api } = setup();
  const payload = await startPayload(api);
  await api.startTrip(payload, 'conflicting-start');
  await assert.rejects(api.startTrip({ ...payload, employeeId: '2002' }, 'conflicting-start'), { code: 'REQUEST_ID_REUSED' });
});

test('another start cannot use a vehicle that is already active', async () => {
  const { api } = setup();
  const payload = await startPayload(api);
  await api.startTrip(payload, 'first-device');
  await assert.rejects(api.startTrip(payload, 'another-device'), { code: 'VEHICLE_IN_USE' });
  assert.equal((await api.listHistory(payload.vehicleId)).trips.length, 1);
});

test('a decreasing meter does not mutate the trip and a corrected retry can complete it', async () => {
  const { api } = setup();
  const { trip } = await api.startTrip(await startPayload(api), 'meter-start');
  await assert.rejects(api.finishTrip(finishPayload(trip, { endOdometer: trip.startOdometer - 1 }), 'meter-finish'), { code: 'ODOMETER_DECREASE' });
  assert.equal((await api.getTrip(trip.id)).trip.status, 'active');
  const result = await api.finishTrip(finishPayload(trip), 'meter-finish');
  assert.equal(result.trip.status, 'completed');
  assert.equal(result.trip.distance, 60);
});

test('unchecked fuel ignores stale liters, while checked fuel requires a positive quantity', async () => {
  const { api } = setup();
  const { trip } = await api.startTrip(await startPayload(api), 'fuel-start');
  await assert.rejects(api.finishTrip(finishPayload(trip, { refueled: true, fuelLiters: null }), 'invalid-fuel'), { code: 'VALIDATION_ERROR' });
  const result = await api.finishTrip(finishPayload(trip, { refueled: false, fuelLiters: 99 }), 'fuel-finish');
  assert.equal(result.trip.refueled, false);
  assert.equal(result.trip.fuelLiters, null);
});

test('oil change updates the baseline and the latest end meter becomes the next start', async () => {
  const { api, advance } = setup();
  const payload = await startPayload(api);
  const { trip } = await api.startTrip(payload, 'oil-start');
  advance();
  const completed = await api.finishTrip(finishPayload(trip, { oilChanged: true }), 'oil-finish');
  const context = await api.vehicleContext(payload.vehicleId);
  assert.equal(context.startOdometer, completed.trip.endOdometer);
  assert.equal(context.oil.baseline, completed.trip.endOdometer);
  assert.equal(context.oil.remaining, context.oil.interval);
  assert.equal(context.oil.status, 'ok');
  assert.equal(context.activeTrip, null);
  const next = await api.startTrip(payload, 'oil-next-start');
  assert.equal(next.trip.startOdometer, completed.trip.endOdometer);
});

test('active and completed history survive reload and returned records cannot mutate storage', async () => {
  const { api, env, options, advance } = setup();
  const payload = await startPayload(api);
  const { trip } = await api.startTrip(payload, 'restore-start');
  const restored = createDemoApi(env, options);
  assert.equal((await restored.vehicleContext(payload.vehicleId)).activeTrip.id, trip.id);
  assert.equal((await restored.getTrip(trip.id)).trip.status, 'active');
  advance();
  await restored.finishTrip(finishPayload(trip, { notes: 'テスト用の報告' }), 'restore-finish');
  const reloaded = createDemoApi(env, options);
  const history = await reloaded.listHistory(payload.vehicleId);
  assert.equal(history.trips.length, 1);
  assert.equal(history.trips[0].status, 'completed');
  assert.equal(history.trips[0].notes, 'テスト用の報告');
  history.trips[0].notes = 'outside mutation';
  assert.equal((await reloaded.getTrip(trip.id)).trip.notes, 'テスト用の報告');
  assert.equal((await reloaded.vehicleContext(payload.vehicleId)).activeTrip, null);
});

test('an applicable MT clutch check is required and missing inspection never creates a trip', async () => {
  const { api } = setup();
  const { vehicles } = await api.bootstrap();
  const mt = vehicles.find(vehicle => vehicle.requiresClutch && vehicle.currentOdometer !== null);
  const payload = await startPayload(api, { vehicleId: mt.id });
  payload.checks.clutch = false;
  await assert.rejects(api.startTrip(payload, 'missing-clutch'), { code: 'VALIDATION_ERROR' });
  assert.equal((await api.listHistory(mt.id)).trips.length, 0);
});
