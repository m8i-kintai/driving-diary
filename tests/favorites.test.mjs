import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FAVORITES, favoriteStorageKey, normalizeFavoriteIds, favoriteVehicles } from '../favorites.js';

const fleet = Array.from({ length: 48 }, (_, index) => ({ id: String(index + 1), number: `サンプル${index + 1}`, model: 'ハイゼット' }));

test('no favorites means no selectable vehicles, including first use and corrupt storage', () => {
  for (const input of [null, undefined, {}, '1', [], ['removed-vehicle']]) {
    assert.deepEqual(favoriteVehicles(fleet, input), []);
  }
});

test('only explicitly registered vehicles appear in the main dropdown', () => {
  assert.deepEqual(favoriteVehicles(fleet, ['3', '25']).map(vehicle => vehicle.id), ['3', '25']);
  assert.equal(fleet.length, 48);
});

test('persisted favorites never exceed ten, even with tampered or old storage', () => {
  assert.equal(MAX_FAVORITES, 10);
  assert.deepEqual(normalizeFavoriteIds(fleet.map(vehicle => vehicle.id), fleet), fleet.slice(0, 10).map(vehicle => vehicle.id));
});

test('deleted vehicles and duplicate IDs cannot consume favorite slots', () => {
  assert.deepEqual(normalizeFavoriteIds(['missing', '2', 2, null, {}, '5', '2'], fleet), ['2', '5']);
});

test('a changed fleet retains only available registered vehicles without adding replacements', () => {
  assert.deepEqual(favoriteVehicles(fleet.filter(vehicle => vehicle.id !== '2'), ['2', '3']).map(vehicle => vehicle.id), ['3']);
  assert.deepEqual(favoriteVehicles(fleet, []), []);
});

test('favorite storage is bound to the verified person and rejects an anonymous identity', () => {
  assert.notEqual(favoriteStorageKey('25'), favoriteStorageKey('26'));
  assert.equal(favoriteStorageKey(25), favoriteStorageKey('25'));
  assert.throws(() => favoriteStorageKey(''));
  assert.throws(() => favoriteStorageKey(null));
});
