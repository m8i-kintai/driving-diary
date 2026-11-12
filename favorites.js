export const MAX_FAVORITES = 10;

export function favoriteStorageKey(employeeId) {
  const id = String(employeeId ?? '').trim();
  if (!id) throw new Error('お気に入りの保存には本人確認が必要です。');
  return `favorites:v1:${encodeURIComponent(id)}`;
}

export function normalizeFavoriteIds(values, vehicles) {
  const available = new Set(vehicles.map(vehicle => String(vehicle.id)));
  const unique = [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' || typeof value === 'number').map(String))];
  return unique.filter(id => available.has(id)).slice(0, MAX_FAVORITES);
}

export function favoriteVehicles(vehicles, ids) {
  const selected = new Set(normalizeFavoriteIds(ids, vehicles));
  return vehicles.filter(vehicle => selected.has(String(vehicle.id)));
}
