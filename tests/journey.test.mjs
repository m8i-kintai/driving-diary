import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveJourney, recordedDriverName, pendingForEmployee, canRestoreDeparture } from '../journey.js';

const active = { id: 'trip-a', vehicleId: 'car-a', status: 'active', employeeId: '1', employeeName: '出発者 A' };
const context = trip => ({ vehicle: { id: 'car-a' }, activeTrip: trip });

test('the selected idle vehicle proceeds to departure', () => {
  assert.deepEqual(resolveJourney(context(null), 'car-a'), { phase: 'start', trip: null });
});

test('an active vehicle proceeds to completion regardless of who started it', () => {
  assert.deepEqual(resolveJourney(context(active), 'car-a'), { phase: 'active', trip: active });
});

test('a stale response for another vehicle cannot select either form', () => {
  assert.throws(() => resolveJourney(context(active), 'car-b'), { code: 'INVALID_RESPONSE' });
  assert.throws(() => resolveJourney(context({ ...active, vehicleId: 'car-b' }), 'car-a'), { code: 'INVALID_RESPONSE' });
});

test('missing or contradictory state cannot be treated as an idle vehicle', () => {
  for (const value of [null, {}, { vehicle: { id: 'car-a' } }, context(undefined), context({ ...active, status: 'completed' }), context({ ...active, id: '' })]) {
    assert.throws(() => resolveJourney(value, 'car-a'), { code: 'INVALID_RESPONSE' });
  }
});

test('handover displays both authenticated participants in departure order', () => {
  assert.equal(recordedDriverName(active, { id: '2', name: '完了者 B' }), '出発者 A ／ 完了者 B');
});

test('the same employee is displayed once even if their current name changed', () => {
  assert.equal(recordedDriverName(active, { id: '1', name: '更新後の氏名' }), '出発者 A');
});

test('completed history uses the server recorded names and supports old records', () => {
  assert.equal(recordedDriverName({ ...active, recordedDriverName: '出発者 A ／ 完了者 B' }), '出発者 A ／ 完了者 B');
  assert.equal(recordedDriverName(active), '出発者 A');
  assert.equal(recordedDriverName({ ...active, completedByEmployeeId: '2', completedByEmployeeName: '完了者 B' }), '出発者 A ／ 完了者 B');
});

test('a pending request can only be resumed by its recorded creator', () => {
  const pending = { requestId: 'request-b', actorEmployeeId: '2', payload: { tripId: 'trip-a' } };
  assert.equal(pendingForEmployee(pending, '2'), pending);
  assert.equal(pendingForEmployee(pending, '3'), null);
  assert.equal(pendingForEmployee(pending, '1'), null);
});

test('an unowned completion payload is never reassigned to the current person', () => {
  assert.equal(pendingForEmployee({ requestId: 'old-request', payload: { tripId: 'trip-a' } }, '2'), null);
  assert.equal(pendingForEmployee(null, '2'), null);
});

test('unfinished inspection can resume only for the same vehicle and meter', () => {
  const basis = { vehicleId: 'car-a', startOdometer: 120000 };
  assert.equal(canRestoreDeparture(basis, 'car-a', 120000), true);
  assert.equal(canRestoreDeparture(basis, 'car-b', 120000), false);
  assert.equal(canRestoreDeparture(basis, 'car-a', 120025), false);
  assert.equal(canRestoreDeparture(null, 'car-a', 120000), false);
  assert.equal(canRestoreDeparture(basis, 'car-a', null), false);
});
