function invalidContext() {
  return Object.assign(new Error('車両の最新状態を確認できません。もう一度「次へ進む」を押してください。'), { code: 'INVALID_RESPONSE' });
}

export function resolveJourney(context, vehicleId) {
  const id = String(vehicleId || '');
  if (!id || !context?.vehicle || String(context.vehicle.id) !== id || !Object.hasOwn(context, 'activeTrip')) throw invalidContext();
  if (context.activeTrip === null) return { phase: 'start', trip: null };
  const trip = context.activeTrip;
  if (!trip || typeof trip.id !== 'string' || !trip.id || trip.status !== 'active' || String(trip.vehicleId) !== id) throw invalidContext();
  return { phase: 'active', trip };
}

export function recordedDriverName(trip, completingEmployee) {
  if (!trip) return '';
  if (!completingEmployee && typeof trip.recordedDriverName === 'string') return trip.recordedDriverName;
  const second = completingEmployee || { id: trip.completedByEmployeeId, name: trip.completedByEmployeeName };
  return second.id && String(second.id) !== String(trip.employeeId) && second.name
    ? `${trip.employeeName || ''} ／ ${second.name}` : trip.employeeName || '';
}

export function pendingForEmployee(pending, employeeId) {
  return pending && pending.actorEmployeeId && String(pending.actorEmployeeId) === String(employeeId)
    ? pending : null;
}

export function canRestoreDeparture(basis, vehicleId, odometer) {
  return !!basis && String(basis.vehicleId) === String(vehicleId)
    && typeof odometer === 'number' && Number.isFinite(odometer) && basis.startOdometer === odometer;
}
