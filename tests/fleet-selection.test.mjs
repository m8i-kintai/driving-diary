import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pendingForEmployee, resolveJourney } from '../journey.js';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function fixture() {
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { value: '', checked: false });
    return fields.get(id);
  };
  field('vehicle').value = 'car-a'; field('department').value = '管理G';
  const employee = { id: '1', name: 'テスト運転者' };
  const pending = { requestId: 'original-request', actorEmployeeId: '1', payload: { vehicleId: 'car-a', expectedVehicleNumber: '変更前の車番' } };
  const state = { phase: 'start', busy: false, employee, pendingStart: pending, pendingFinish: null, context: null, contextLoading: false };
  const calls = { fleetRefreshes: 0, errors: [], storage: [], starts: [] };
  const api = {
    async startTrip(payload, requestId) { calls.starts.push({ payload, requestId }); throw { code: calls.failure || 'VEHICLE_INACTIVE' }; },
    async vehicleContext() { return { vehicle: { id: 'car-a', number: '変更後の車番' }, activeTrip: null }; }
  };
  const context = vm.createContext({
    state, api, $: field, contextGeneration: 0, navigator: { onLine: true }, CHECKS: [['brakes']],
    pendingForEmployee, resolveJourney, currentVehicle: () => ({ id: 'car-a', number: '変更前の車番' }),
    checks: () => ({ brakes: true }), alcohol: () => ({ confirmed: false, reading: null, presence: '無' }),
    setAlcohol() {}, saveDraft() {}, clearError() {}, renderControls() {}, renderVehicle() {},
    selectionIssue: () => '',
    newRequest() { throw new Error('保存結果確認で新しい通信IDを作成してはいけない'); },
    showError: error => calls.errors.push(error.code),
    writeStore: (key, value) => calls.storage.push({ key, value }),
    showDeparture() { throw new Error('古い車番のまま出発画面を開いてはいけない'); },
    enterTrip() { throw new Error('古い車番のまま運転画面を開いてはいけない'); },
    applyVehicleContext() { throw new Error('表示した車番を黙って置き換えてはいけない'); },
    async initialize() {
      calls.fleetRefreshes++;
      context.contextGeneration++;
      state.contextLoading = false; state.phase = 'select'; state.trip = null;
      context.resetVehicleSelection();
    }
  });
  const errorsLine = source.split('\n').find(line => line.startsWith('const DEFINITIVE_ERRORS = '));
  vm.runInContext([
    errorsLine,
    section('function startPayload(', 'function finishPayload('),
    section('function resetVehicleSelection(', 'function restoreFinish('),
    section('async function continueSelection(', 'function returnToSelection('),
    section('async function loadVehicle(', 'function showWarnings('),
    section('async function submitStart(', 'function enterTrip(')
  ].join('\n'), context);
  return { context, calls, state, pending, field };
}

test('departure payload binds the vehicle number that the driver saw', () => {
  const f = fixture();
  const payload = f.context.startPayload();
  assert.equal(payload.vehicleId, 'car-a');
  assert.equal(payload.expectedVehicleNumber, '変更前の車番');
});

test('inactive or renumbered vehicles end the old pending start and refresh selection', async () => {
  for (const failure of ['VEHICLE_INACTIVE', 'VEHICLE_CHANGED']) {
    const f = fixture(); f.calls.failure = failure;
    await f.context.submitStart(true);
    assert.equal(f.calls.starts[0].payload, f.pending.payload);
    assert.equal(f.calls.starts[0].requestId, 'original-request');
    assert.equal(f.state.pendingStart, null);
    assert.ok(f.calls.storage.some(x => x.key === 'pending-start' && x.value === null));
    assert.equal(f.calls.fleetRefreshes, 1);
    assert.equal(f.field('vehicle').value, '');
    assert.equal(f.state.phase, 'select');
    assert.equal(f.state.busy, false);
    assert.deepEqual(f.calls.errors, [failure]);
  }
});

test('an unknown start save outcome retains its original request for confirmation', async () => {
  const f = fixture(); f.calls.failure = 'INTERNAL_ERROR';
  await f.context.submitStart(true);
  assert.equal(f.state.pendingStart, f.pending);
  assert.equal(f.calls.fleetRefreshes, 0);
  assert.ok(!f.calls.storage.some(x => x.key === 'pending-start' && x.value === null));
});

test('Next and reconnect do not silently replace the number already shown', async () => {
  for (const action of ['continueSelection', 'loadVehicle']) {
    const f = fixture();
    f.state.pendingStart = null;
    f.state.phase = action === 'continueSelection' ? 'select' : 'start';
    await f.context[action]();
    assert.equal(f.calls.fleetRefreshes, 1);
    assert.equal(f.state.phase, 'select');
    assert.equal(f.field('vehicle').value, '');
    assert.equal(f.state.context, null);
    assert.deepEqual(f.calls.errors, ['VEHICLE_CHANGED']);
  }
});
