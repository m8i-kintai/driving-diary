import { api, isDemo } from './api.js';
import { MAX_FAVORITES, favoriteStorageKey, normalizeFavoriteIds, favoriteVehicles } from './favorites.js';
import { resolveJourney, recordedDriverName, pendingForEmployee, canRestoreDeparture } from './journey.js';

const $ = id => document.getElementById(id);
const CHECKS = [
  ['brakes', 'ブレーキ'], ['tires', 'タイヤ'], ['engine', 'エンジン'],
  ['battery', 'バッテリー'], ['lights', '灯火・方向指示器'], ['washer', 'ウォッシャー液'],
  ['wipers', 'ワイパー'], ['glass', 'ガラス'], ['body', '車両傷'], ['clutch', 'クラッチ', 'MTのみ'],
];
const MODELS = new Set(['hiace', 'hijet', 'succeed', 'probox', 'toyoace']);
const STORE = `drive-log:${isDemo ? 'preview' : 'live'}:v1:`;
const PERSONAL_KEYS = new Set(['draft', 'pending-start', 'pending-finish', 'active-trip']);
let storageEmployeeId = '';
const DEFINITIVE_ERRORS = new Set(['VALIDATION_ERROR', 'EMPLOYEE_NOT_FOUND', 'VEHICLE_NOT_FOUND', 'INITIAL_ODOMETER_REQUIRED', 'VEHICLE_IN_USE', 'TRIP_NOT_FOUND', 'TRIP_ALREADY_COMPLETED', 'ODOMETER_DECREASE', 'REQUEST_ID_REUSED', 'EMPLOYEE_MISMATCH', 'UNAUTHORIZED', 'KINJIRO_SESSION_EXPIRED', 'CONFIGURATION_ERROR', 'UNCONFIGURED', 'ROW_CONFLICT', 'SCHEMA_ERROR', 'ALCOHOL_PRESENT']);
const state = {
  phase: 'loading', vehicles: [], departments: [], context: null, contextLoading: false,
  employee: null, favorites: [], trip: null, busy: false,
  pendingStart: null, pendingFinish: null,
  serverOffset: null, sheetUrl: null,
};
let contextGeneration = 0;
let favoriteDraft = new Set();
let toastTimer;
let confirmAction;
let historyGeneration = 0;

function readStore(key) {
  if (PERSONAL_KEYS.has(key) && !storageEmployeeId) return null;
  try { return JSON.parse(localStorage.getItem(storeKey(key)) || 'null'); } catch { return null; }
}
function storeKey(key) { return STORE + (PERSONAL_KEYS.has(key) ? `person:${encodeURIComponent(storageEmployeeId)}:` : '') + key; }
function readLegacyStore(key) { try { return JSON.parse(localStorage.getItem(STORE + key) || 'null'); } catch { return null; } }
function restorePersonalState() {
  storageEmployeeId = String(state.employee.id);
  const legacyDraft = readLegacyStore('draft');
  if (!readStore('draft') && String(legacyDraft?.start?.employeeId) === storageEmployeeId) writeStore('draft', legacyDraft);
  for (const [key, property] of [['pending-start', 'pendingStart'], ['pending-finish', 'pendingFinish']]) {
    state[property] = pendingForEmployee(readStore(key), storageEmployeeId);
    if (!state[property]) {
      const legacy = readLegacyStore(key);
      const owned = pendingForEmployee(legacy, storageEmployeeId) || (key === 'pending-start' && legacy?.payload && String(legacy.payload.employeeId) === storageEmployeeId ? { ...legacy, actorEmployeeId: storageEmployeeId } : null);
      // Unowned legacy completion requests are retained in storage, but cannot
      // be sent under a different or unknown person's identity.
      if (owned) { writeStore(key, owned, true); state[property] = owned; try { localStorage.removeItem(STORE + key); } catch { /* The personal copy is already safe. */ } }
    }
  }
}
function writeStore(key, value, required = false) {
  if (PERSONAL_KEYS.has(key) && !storageEmployeeId) return false;
  try {
    if (value === null) localStorage.removeItem(storeKey(key));
    else localStorage.setItem(storeKey(key), JSON.stringify(value));
    return true;
  } catch {
    if (required) throw new Error('この端末に送信情報を保持できません。ブラウザの保存設定をご確認ください。');
    return false;
  }
}
function numberOrNull(value) { return String(value ?? '').trim() === '' ? null : Number(value); }
function validNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
function km(value) { return validNumber(value) ? new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value) : '—'; }
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
function setDate() {
  if (state.serverOffset === null) return;
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + state.serverOffset));
  const value = type => parts.find(part => part.type === type)?.value || '';
  $('today').textContent = `${value('year')}.${value('month')}.${value('day')}`;
}
function errorMessage(error) {
  if (error?.code === 'UNCONFIGURED' || error?.code === 'CONFIGURATION_ERROR') return 'このアプリはまだ利用準備中です。管理担当者に連絡してください。';
  if (['UNAUTHORIZED', 'AUTH_REQUIRED', 'KINJIRO_SESSION_EXPIRED'].includes(error?.code)) return 'キンジロー君の運転日報ボタンから開いてください。';
  if (error?.code === 'KINJIRO_VERIFICATION_UNAVAILABLE') return '本人確認の通信ができませんでした。入力を保持しています。少し待って再度お試しください。';
  if (error?.code === 'ROW_CONFLICT') return '記録の行が変更されているため保存を止めました。入力は保持されています。管理担当者に確認してください。';
  if (error?.code === 'SCHEMA_ERROR') return '車両台帳の内容を確認できません。入力は保持されています。管理担当者に確認してください。';
  return error?.message || '通信できませんでした。入力を保持しています。電波状況をご確認ください。';
}
function showError(error) {
  $('global-error').textContent = errorMessage(error);
  $('global-error').hidden = false;
  $('global-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function clearError() { $('global-error').hidden = true; $('global-error').textContent = ''; }
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function currentVehicle() { return state.vehicles.find(vehicle => String(vehicle.id) === $('vehicle').value) || null; }
function alcohol(prefix) {
  return { confirmed: $(`${prefix}-confirmed`).checked, reading: numberOrNull($(`${prefix}-reading`).value), presence: document.querySelector(`input[name="${prefix}-presence"]:checked`)?.value || '無' };
}
function setAlcohol(prefix, value = {}) {
  $(`${prefix}-confirmed`).checked = value.confirmed === true;
  $(`${prefix}-reading`).value = value.reading ?? '';
  document.querySelectorAll(`input[name="${prefix}-presence"]`).forEach(input => { input.checked = input.value === (value.presence === '有' ? '有' : '無'); });
}
function checks() {
  const result = {};
  CHECKS.forEach(([key]) => { result[key] = $(`check-${key}`).checked; });
  if (!currentVehicle()?.requiresClutch) result.clutch = false;
  return result;
}
function startPayload() {
  return { vehicleId: $('vehicle').value, employeeId: state.employee?.id || '', department: $('department').value, checks: checks(), before: alcohol('before') };
}
function finishPayload() {
  return { tripId: state.trip?.id, department: $('department').value, destination: $('destination').value.trim(), endOdometer: numberOrNull($('end-odometer').value), refueled: $('refueled').checked, fuelLiters: $('refueled').checked ? numberOrNull($('fuel-liters').value) : null, oilChanged: $('oil-changed').checked, notes: $('notes').value.trim(), after: alcohol('after') };
}
function saveDraft() {
  if (state.phase === 'loading') return;
  const previous = readStore('draft');
  const inspectionBasis = state.phase === 'start' && state.context ? { vehicleId: $('vehicle').value, startOdometer: state.context.startOdometer } : previous?.inspectionBasis || null;
  writeStore('draft', { start: startPayload(), finish: state.trip ? finishPayload() : previous?.finish || null, inspectionBasis });
}
function restoreStart(draft) {
  if (!draft) return;
  if (state.departments.includes(draft.department)) $('department').value = draft.department;
  const sameVehicle = state.favorites.includes(String(draft.vehicleId));
  $('vehicle').value = sameVehicle ? String(draft.vehicleId) : '';
  CHECKS.forEach(([key]) => { $(`check-${key}`).checked = sameVehicle && draft.checks?.[key] === true; });
  setAlcohol('before', sameVehicle ? draft.before : {});
}
function restoreFinish(draft) {
  if (!draft || String(draft.tripId) !== String(state.trip?.id)) {
    $('destination').value = ''; $('end-odometer').value = ''; $('refueled').checked = false;
    $('fuel-liters').value = ''; $('oil-changed').checked = false; $('notes').value = ''; setAlcohol('after');
    return;
  }
  $('destination').value = draft.destination || '';
  $('end-odometer').value = draft.endOdometer ?? '';
  $('refueled').checked = draft.refueled === true;
  $('fuel-liters').value = draft.fuelLiters ?? '';
  $('oil-changed').checked = draft.oilChanged === true;
  $('notes').value = draft.notes || '';
  setAlcohol('after', draft.after);
}
function buildChecks() {
  CHECKS.forEach(([key, label, note]) => {
    const row = document.createElement('label'); row.className = 'inspection-item'; row.id = `inspection-${key}`;
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = `check-${key}`; input.name = key;
    input.required = key !== 'clutch';
    const dot = document.createElement('span'); dot.className = 'check-dot'; dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = label;
    if (note) { const small = document.createElement('small'); small.textContent = `（${note}）`; text.append(small); }
    const arrow = document.createElement('span'); arrow.className = 'item-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›';
    row.append(input, dot, text, arrow); $('inspection-grid').append(row);
  });
}
function renderVehicleOptions(preferredId = $('vehicle').value) {
  const vehicles = favoriteVehicles(state.vehicles, state.favorites);
  $('vehicle').replaceChildren(new Option(vehicles.length ? '車両を選択してください' : 'お気に入りを登録してください', ''));
  vehicles.forEach(vehicle => $('vehicle').add(new Option(vehicle.number, String(vehicle.id))));
  if (vehicles.some(vehicle => String(vehicle.id) === String(preferredId))) $('vehicle').value = String(preferredId);
  $('vehicle').disabled = !vehicles.length;
  $('register-favorites').hidden = vehicles.length > 0;
  $('favorites-help').textContent = vehicles.length ? `お気に入りの ${vehicles.length} 台を表示しています。変更は右上の「お気に入り」から。` : '右上の「お気に入り」から、使う車両を登録してください。';
}
function renderFavoritePicker() {
  const search = $('favorites-search').value.normalize('NFKC').replace(/\s/g, '').toLowerCase();
  $('favorites-list').replaceChildren();
  let shown = 0;
  for (const vehicle of state.vehicles) {
    const labelText = `${vehicle.number} ${vehicle.model || ''}`;
    if (search && !labelText.normalize('NFKC').replace(/\s/g, '').toLowerCase().includes(search)) continue;
    shown++;
    const id = String(vehicle.id);
    const row = document.createElement('label'); row.className = 'favorite-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = id;
    input.checked = favoriteDraft.has(id); input.disabled = !input.checked && favoriteDraft.size >= MAX_FAVORITES;
    input.setAttribute('aria-label', labelText);
    const copy = document.createElement('span');
    addText(copy, 'strong', vehicle.number); addText(copy, 'small', vehicle.model || '車種未登録');
    const star = document.createElement('span'); star.className = 'favorite-star'; star.setAttribute('aria-hidden', 'true'); star.textContent = input.checked ? '★' : '☆';
    input.addEventListener('change', () => {
      if (input.checked && favoriteDraft.size >= MAX_FAVORITES) { input.checked = false; return; }
      if (input.checked) favoriteDraft.add(id); else favoriteDraft.delete(id);
      $('favorites-error').hidden = true;
      renderFavoritePicker();
      const nextInput = [...$('favorites-list').querySelectorAll('input')].find(item => item.value === id);
      nextInput?.focus({ preventScroll: true });
    });
    row.append(input, copy, star); $('favorites-list').append(row);
  }
  $('favorites-count').textContent = `${favoriteDraft.size} / ${MAX_FAVORITES}`;
  $('favorites-count').classList.toggle('is-complete', favoriteDraft.size === MAX_FAVORITES);
  $('favorites-no-results').hidden = shown > 0;
}
function openFavorites() {
  if (state.busy || state.pendingStart || state.pendingFinish || !state.employee || state.phase !== 'select') return;
  favoriteDraft = new Set(state.favorites);
  $('favorites-search').value = ''; $('favorites-error').hidden = true;
  renderFavoritePicker(); $('favorites-dialog').showModal();
}
async function saveFavorites() {
  if (!state.employee || state.busy || state.pendingStart || state.pendingFinish || state.phase !== 'select') return;
  const next = normalizeFavoriteIds([...favoriteDraft], state.vehicles);
  if (!writeStore(favoriteStorageKey(state.employee.id), next)) {
    $('favorites-error').textContent = 'お気に入りを保存できません。ブラウザの保存設定をご確認ください。'; $('favorites-error').hidden = false; return;
  }
  const previous = $('vehicle').value;
  state.favorites = next; renderVehicleOptions(previous);
  if (previous !== $('vehicle').value) { CHECKS.forEach(([key]) => { $(`check-${key}`).checked = false; }); setAlcohol('before'); }
  $('favorites-dialog').close(); saveDraft(); renderControls();
  if (previous !== $('vehicle').value) { state.context = null; renderVehicle(); }
  toast(next.length ? `お気に入りを ${next.length} 台登録しました` : 'お気に入りを解除しました');
}
function renderChecks() {
  const applies = currentVehicle()?.requiresClutch === true;
  const row = $('inspection-clutch'); row.classList.toggle('is-na', !applies);
  $('check-clutch').disabled = !applies;
  $('check-clutch').required = applies;
  if (!applies) $('check-clutch').checked = false;
  const selected = CHECKS.filter(([key]) => (key !== 'clutch' || applies) && $(`check-${key}`).checked).length;
  const total = applies ? 10 : 9;
  $('inspection-count').textContent = selected === total ? '✓ 確認済み' : `${selected} / ${total}`;
  $('inspection-count').classList.toggle('is-complete', selected === total);
  return total - selected;
}
function setVehicleImage(image, vehicle, fallback) {
  const modelKey = vehicle?.modelKey;
  image.hidden = !MODELS.has(modelKey);
  if (fallback) fallback.hidden = MODELS.has(modelKey);
  if (!MODELS.has(modelKey)) { image.removeAttribute('src'); return; }
  image.alt = `黒色の${vehicle.model || modelKey}`;
  const nextUrl = new URL(`./assets/vehicles/${modelKey}.png`, import.meta.url).href;
  if (image.src !== nextUrl) image.src = nextUrl;
  image.onerror = () => { image.hidden = true; if (fallback) { fallback.hidden = false; fallback.querySelector('span').textContent = '車両画像を読み込めませんでした'; } };
}
function renderVehicle() {
  const vehicle = currentVehicle();
  $('start-model').textContent = vehicle?.model || '今日の車両';
  $('vehicle-placeholder').querySelector('span').textContent = vehicle ? '車両情報を読み込んでいます' : '車両を選択してください';
  setVehicleImage($('start-vehicle-image'), vehicle, $('vehicle-placeholder'));
  const meter = state.context?.startOdometer;
  $('start-odometer').value = state.contextLoading ? '確認中' : km(meter);
  $('meter-help').textContent = !vehicle ? '前回の終了メーターを自動で表示します。' : state.contextLoading ? '最新のメーターを確認しています。' : validNumber(meter) ? '前回の終了メーターを自動で表示しています。' : '出発メーター未登録。管理担当者による登録が必要です。';
  $('meter-help').classList.toggle('error-text', !!vehicle && !state.contextLoading && !!state.context && !validNumber(meter));
  const oil = state.context?.oil;
  $('oil-status').hidden = !oil;
  if (oil) {
    $('oil-status').classList.toggle('is-warning', ['warning', 'overdue'].includes(oil.status));
    $('oil-status').textContent = oil.status === 'unregistered' || !validNumber(oil.baseline) ? 'オイル交換：基準未登録' : validNumber(oil.remaining) ? oil.remaining < 0 ? `オイル交換の目安を ${km(Math.abs(oil.remaining))} km 超過しています` : `オイル交換まで あと ${km(oil.remaining)} km` : 'オイル交換の情報を確認できません。';
  }
  const active = state.context?.activeTrip;
  $('active-vehicle-notice').hidden = !active;
  $('active-vehicle-description').textContent = active ? `${active.employeeName || '運転者'}　${time(active.startedAt)} 出発` : '';
  renderChecks();
}
function startIssue() {
  if (state.busy) return '出発の保存結果を確認しています。';
  if (state.pendingStart) return '保存結果を上のボタンから再確認してください。';
  if (!navigator.onLine) return '通信が戻ると記録できます。';
  if (!$('department').value) return '稼働部門を選択してください。';
  if (!state.favorites.length) return 'お気に入りに使う車両を登録してください。';
  if (!$('vehicle').value) return '車両を選択してください。';
  if (state.contextLoading) return '車両情報を確認しています。';
  if (!state.context) return '車両情報を確認できていません。車両を選び直してください。';
  if (state.context.activeTrip) return 'この車両の運転中の記録を開けます。';
  if (!state.employee?.name) return 'キンジロー君の運転日報ボタンから開いて、運転者を確認してください。';
  if (!validNumber(state.context.startOdometer)) return '出発メーター未登録のため、まだ出発できません。';
  if (alcohol('before').presence !== '無') return '酒気帯びが「有」のため出発できません。';
  const remaining = renderChecks();
  if (remaining) return `車両点検を確認してください（残り ${remaining} 項目）。`;
  const reading = alcohol('before').reading;
  if (reading !== null && (!validNumber(reading) || reading < 0)) return 'アルコール測定値を正しく入力してください。';
  return '';
}
function selectionIssue() {
  if (state.busy) return '車両の状態を確認しています。';
  if (state.pendingStart || state.pendingFinish) return '前回の保存結果を上のボタンから再確認してください。';
  if (!navigator.onLine) return '通信が戻ると次へ進めます。';
  if (!state.employee?.name) return 'キンジロー君から開いて運転者を確認してください。';
  if (!$('department').value) return '稼働部門を選択してください。';
  if (!state.favorites.length) return 'お気に入りに使う車両を登録してください。';
  if (!$('vehicle').value) return '車両を選択してください。';
  return '';
}
function applyVehicleContext(context) {
  state.context = context;
  const index = state.vehicles.findIndex(item => String(item.id) === String(context.vehicle.id));
  if (index >= 0) state.vehicles[index] = { ...state.vehicles[index], ...context.vehicle };
}
function showDeparture() {
  const draft = readStore('draft');
  if (!canRestoreDeparture(draft?.inspectionBasis, $('vehicle').value, state.context?.startOdometer)) {
    CHECKS.forEach(([key]) => { $(`check-${key}`).checked = false; }); setAlcohol('before');
  }
  state.trip = null; state.phase = 'start';
  $('departure-department').textContent = $('department').value;
  $('departure-number').textContent = currentVehicle()?.number || '—';
  $('departure-driver').textContent = state.employee?.name || '—';
  saveDraft(); renderVehicle(); renderControls(); window.scrollTo({ top: 0, behavior: 'instant' }); $('departure-title').focus({ preventScroll: true });
}
async function continueSelection() {
  const issue = selectionIssue();
  if (state.phase !== 'select' || issue) { if (issue) toast(issue); return; }
  clearError(); saveDraft(); const generation = ++contextGeneration; state.contextLoading = false; state.busy = true; renderControls();
  try {
    const vehicleId = $('vehicle').value;
    const context = await api.vehicleContext(vehicleId);
    if (generation !== contextGeneration || $('vehicle').value !== vehicleId) return;
    const route = resolveJourney(context, vehicleId);
    applyVehicleContext(context);
    if (route.phase === 'active') enterTrip(route.trip);
    else showDeparture();
    if (context.warnings?.length) showWarnings(context.warnings);
  } catch (error) { state.context = null; state.phase = 'select'; showError(error); }
  finally { state.busy = false; renderControls(); }
}
function returnToSelection() {
  if (state.busy || state.pendingStart || state.pendingFinish) return;
  saveDraft(); ++contextGeneration; state.contextLoading = false; state.phase = 'select'; state.trip = null; state.context = null; state.sheetUrl = null;
  renderVehicle(); renderControls(); window.scrollTo({ top: 0, behavior: 'instant' }); $('selection-title').focus({ preventScroll: true });
}
function finishIssue() {
  if (state.busy) return '完了の保存結果を確認しています。';
  if (state.pendingFinish) return '保存結果を上のボタンから再確認してください。';
  if (!navigator.onLine) return '通信が戻ると記録できます。';
  const payload = finishPayload();
  if (!validNumber(state.trip?.startOdometer)) return '出発時のメーターを確認できません。画面を読み込み直してください。';
  if (!payload.destination) return '行き先を入力してください。';
  if (!validNumber(payload.endOdometer) || !Number.isInteger(payload.endOdometer)) return '終了後メーターを整数で入力してください。';
  if (payload.endOdometer < state.trip?.startOdometer) return '終了後メーターは出発時以上にしてください。';
  if (payload.refueled && (!validNumber(payload.fuelLiters) || payload.fuelLiters <= 0)) return '給油量（L）を入力してください。';
  if (payload.after.reading !== null && (!validNumber(payload.after.reading) || payload.after.reading < 0)) return 'アルコール測定値を正しく入力してください。';
  return '';
}
function renderControls() {
  $('selection-screen').hidden = state.phase !== 'select';
  $('start-form').hidden = state.phase !== 'start';
  $('finish-form').hidden = state.phase !== 'active';
  $('completed-screen').hidden = state.phase !== 'completed';
  $('boot-status').hidden = !['loading', 'error'].includes(state.phase);
  $('offline-banner').hidden = navigator.onLine;
  const pending = ['select', 'start', 'active'].includes(state.phase) ? state.pendingStart || state.pendingFinish : null;
  $('pending-notice').hidden = !pending || state.busy;
  if (pending) {
    const payload = pending.payload;
    const isStart = pending === state.pendingStart;
    const vehicle = state.vehicles.find(item => String(item.id) === String(isStart ? payload.vehicleId : state.trip?.vehicleId));
    const driver = isStart ? String(payload.employeeId) === String(state.employee?.id) ? state.employee.name : '本人認証の再確認が必要' : recordedDriverName(state.trip, state.employee) || '氏名確認中';
    const parts = [vehicle?.number || '車両情報を確認できません', isStart ? payload.department : payload.department || state.trip?.department, `運転者 ${driver}`];
    if (isStart) {
      parts.push(`点検 ${Object.values(payload.checks || {}).filter(value => value === true).length}項目`);
      const before = payload.before || {};
      parts.push(`運転前対面確認 ${before.confirmed ? '確認済み' : '未確認'} / 測定値 ${before.reading == null ? '未入力' : before.reading + ' mg/L'} / 酒気帯び ${before.presence || '無'}`);
    } else parts.push(`行き先 ${payload.destination || '未入力'} / 終了メーター ${km(payload.endOdometer)} km`);
    $('pending-summary').textContent = parts.filter(Boolean).join('　／　');
  }
  $('pending-retry').disabled = state.busy || !navigator.onLine;
  $('start-fields').disabled = state.busy || !!state.pendingStart || !!state.pendingFinish;
  $('inspection-fields').disabled = state.busy || !!state.pendingStart;
  $('before-alcohol').disabled = state.busy || !!state.pendingStart;
  $('finish-fields').disabled = state.busy || !!state.pendingFinish;
  $('open-active-trip').disabled = state.busy;
  $('next-drive').disabled = state.busy;
  $('history-button').disabled = state.busy || (!state.trip && !$('vehicle').value) || state.phase === 'loading' || state.phase === 'error';
  $('favorites-button').disabled = state.busy || !!state.pendingStart || !!state.pendingFinish || !state.employee || state.phase !== 'select';
  $('change-start-selection').disabled = state.busy || !!state.pendingStart;
  $('change-finish-selection').disabled = state.busy || !!state.pendingFinish;
  const selectionReason = state.phase === 'select' ? selectionIssue() : '準備中';
  $('continue-button').disabled = state.phase !== 'select' || !!selectionReason;
  $('continue-button').textContent = state.busy && state.phase === 'select' ? '車両の状態を確認しています…' : '次へ進む →';
  $('selection-guidance').textContent = selectionReason || 'この車両の状態を確認して、次の画面へ進みます。';
  $('before-alcohol-block').hidden = alcohol('before').presence === '無';
  const startReason = state.phase === 'start' ? startIssue() : '準備中';
  const finishReason = state.phase === 'active' ? finishIssue() : '準備中';
  $('start-guidance').textContent = startReason || '準備ができました。気をつけていってらっしゃい。';
  $('finish-guidance').textContent = finishReason || '記録内容を確認して、運転を完了してください。';
  startSlider.setEnabled(state.phase === 'start' && !startReason, state.busy && state.phase === 'start');
  finishSlider.setEnabled(state.phase === 'active' && !finishReason, state.busy && state.phase === 'active');
  $('start-alternative').disabled = state.phase !== 'start' || !!startReason;
  $('finish-alternative').disabled = state.phase !== 'active' || !!finishReason;
  document.querySelector('.app-shell').setAttribute('aria-busy', String(state.busy));
}

// The slider changes visual position while dragging; only release at the end saves.
class SlideControl {
  constructor(id, submit) {
    this.root = $(id); this.thumb = this.root.querySelector('.slide-thumb'); this.submit = submit;
    this.progress = 0; this.enabled = false; this.pointerId = null; this.startX = 0;
    this.thumb.addEventListener('pointerdown', event => {
      if (!this.enabled || event.button > 0) return;
      this.pointerId = event.pointerId; this.startX = event.clientX;
      this.thumb.setPointerCapture(event.pointerId); this.root.classList.add('is-dragging');
      event.preventDefault();
    });
    this.thumb.addEventListener('pointermove', event => {
      if (event.pointerId !== this.pointerId) return;
      this.setProgress((event.clientX - this.startX) / this.travel() * 100);
    });
    this.thumb.addEventListener('pointerup', event => {
      if (event.pointerId !== this.pointerId) return;
      const complete = this.enabled && this.progress >= 94;
      this.reset();
      if (complete) this.submit();
    });
    this.thumb.addEventListener('pointercancel', () => this.reset());
    this.thumb.addEventListener('lostpointercapture', () => this.reset());
    this.thumb.addEventListener('keydown', event => {
      if (!this.enabled) return;
      const keys = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'Enter', ' '];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Enter' || event.key === ' ') { this.reset(); this.submit(); return; }
      this.setProgress(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : this.progress + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 20 : -20));
    });
    this.thumb.addEventListener('blur', () => this.reset());
  }
  travel() { return Math.max(1, this.root.clientWidth - this.thumb.offsetWidth - 12); }
  setProgress(value) {
    this.progress = Math.max(0, Math.min(100, value));
    this.root.style.setProperty('--offset', `${this.travel() * this.progress / 100}px`);
    this.root.style.setProperty('--progress', String(this.progress));
    this.thumb.setAttribute('aria-valuenow', String(Math.round(this.progress)));
    this.thumb.setAttribute('aria-valuetext', `${Math.round(this.progress)}%。Enterキーでも記録できます`);
  }
  reset() { this.pointerId = null; this.root.classList.remove('is-dragging'); this.setProgress(0); }
  setEnabled(enabled, busy) {
    this.enabled = enabled; this.thumb.setAttribute('aria-disabled', String(!enabled));
    this.root.classList.toggle('is-disabled', !enabled); this.root.classList.toggle('is-busy', !!busy);
    this.root.querySelector('.slide-label').textContent = busy ? '保存を確認しています…' : this.root.id === 'start-slider' ? 'スライドして出発' : 'スライドして完了';
    if (!enabled) this.reset();
  }
}
const startSlider = new SlideControl('start-slider', () => submitStart());
const finishSlider = new SlideControl('finish-slider', () => submitFinish());

async function loadVehicle({ warnings = true } = {}) {
  const generation = ++contextGeneration;
  const vehicle = currentVehicle();
  state.context = null; state.contextLoading = !!vehicle;
  renderVehicle(); renderControls();
  if (!vehicle) return;
  try {
    const context = await api.vehicleContext(vehicle.id);
    if (generation !== contextGeneration || $('vehicle').value !== String(vehicle.id)) return;
    resolveJourney(context, vehicle.id);
    state.context = context;
    if (context.vehicle) {
      const index = state.vehicles.findIndex(item => String(item.id) === String(vehicle.id));
      state.vehicles[index] = { ...state.vehicles[index], ...context.vehicle };
    }
    if (warnings && context.warnings?.length && state.phase === 'start') showWarnings(context.warnings);
  } catch (error) { if (generation === contextGeneration) showError(error); }
  finally { if (generation === contextGeneration) { state.contextLoading = false; renderVehicle(); renderControls(); } }
}
function showWarnings(warnings) {
  $('warnings-content').replaceChildren();
  warnings.forEach(warning => {
    const card = document.createElement('article'); card.className = 'warning-card';
    card.classList.toggle('is-critical', ['critical', 'danger', 'error'].includes(warning.level));
    const title = document.createElement('h3'); title.textContent = warning.title || '車両のお知らせ';
    const message = document.createElement('p'); message.textContent = warning.message || '';
    card.append(title, message); $('warnings-content').append(card);
  });
  if (!$('warnings-dialog').open) $('warnings-dialog').showModal();
}
function newRequest(payload, key) {
  if (typeof crypto.randomUUID !== 'function') throw new Error('安全な接続で開き直してください。');
  const pending = { requestId: crypto.randomUUID(), payload, actorEmployeeId: String(state.employee.id) };
  writeStore(key, pending, true);
  return pending;
}
async function submitStart(retry = false) {
  if (state.busy || state.phase !== 'start') return;
  if (retry && !pendingForEmployee(state.pendingStart, state.employee?.id)) { showError(new Error('この送信内容を作成した方で開き直してください。')); return; }
  if (!retry && startIssue()) { toast(startIssue()); return; }
  if (!navigator.onLine) { showError(new Error('オフラインのため保存できません。通信が戻ってから再確認してください。')); return; }
  clearError();
  try { if (!state.pendingStart) state.pendingStart = newRequest(startPayload(), 'pending-start'); }
  catch (error) { showError(error); return; }
  saveDraft(); state.busy = true; renderControls();
  try {
    const result = await api.startTrip(state.pendingStart.payload, state.pendingStart.requestId);
    if (!result.trip?.id) throw new Error('保存結果を確認できませんでした。同じ内容で再確認してください。');
    writeStore('active-trip', result.trip.id, true);
    state.pendingStart = null; writeStore('pending-start', null);
    CHECKS.forEach(([key]) => { $(`check-${key}`).checked = false; }); setAlcohol('before');
    writeStore('draft', { start: startPayload(), finish: null, inspectionBasis: null });
    enterTrip(result.trip);
    toast(isDemo ? 'プレビュー：出発画面を切り替えました' : '出発を記録しました');
  } catch (error) {
    if (DEFINITIVE_ERRORS.has(error?.code)) { state.pendingStart = null; writeStore('pending-start', null); }
    showError(error);
    if (error?.code === 'VEHICLE_IN_USE') {
      try {
        const generation = ++contextGeneration;
        const vehicleId = $('vehicle').value;
        state.contextLoading = false;
        const context = await api.vehicleContext(vehicleId);
        if (generation !== contextGeneration || $('vehicle').value !== vehicleId) return;
        const route = resolveJourney(context, vehicleId);
        applyVehicleContext(context);
        if (route.phase === 'active') { enterTrip(route.trip); toast('この車両は出発済みのため、完了画面へ切り替えました。'); }
        else showDeparture();
      } catch (refreshError) { showError(refreshError); }
    }
  } finally { state.busy = false; renderControls(); }
}
function enterTrip(trip) {
  state.trip = trip;
  if (trip.status === 'completed') { completeTrip(trip); return; }
  state.phase = 'active';
  $('trip-department').textContent = trip.department || '—';
  $('trip-model').textContent = trip.model || '車両';
  $('trip-number').textContent = trip.vehicleNumber || state.vehicles.find(item => String(item.id) === String(trip.vehicleId))?.number || '—';
  $('trip-driver').textContent = `出発した人 ${trip.employeeName || ''}`;
  $('trip-completer').textContent = `今回の運転者 ${state.employee?.name || ''}`;
  $('completion-department').textContent = $('department').value || trip.department || '—';
  const handover = String(trip.employeeId) !== String(state.employee?.id);
  $('handover-note').hidden = !handover;
  $('handover-note').textContent = handover ? `引き継いで完了を記録します。日報の運転者欄には「${recordedDriverName(trip, state.employee)}」と記載します。` : '';
  $('trip-started').textContent = `${time(trip.startedAt)} 出発`;
  $('trip-start-meter').textContent = km(trip.startOdometer);
  setVehicleImage($('trip-vehicle-image'), trip);
  const pending = state.pendingFinish;
  const draft = readStore('draft')?.finish;
  restoreFinish(pending && String(pending.payload.tripId) === String(trip.id) ? pending.payload : draft);
  if (pending && String(pending.payload.tripId) !== String(trip.id)) { state.pendingFinish = null; writeStore('pending-finish', null); }
  renderFinish(); renderControls();
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('finish-form').querySelector('h2').setAttribute('tabindex', '-1');
  $('finish-form').querySelector('h2').focus({ preventScroll: true });
}
function renderFinish() {
  $('fuel-liters-field').hidden = !$('refueled').checked;
  const end = numberOrNull($('end-odometer').value);
  const start = state.trip?.startOdometer;
  const valid = validNumber(end) && validNumber(start) && end >= start;
  $('trip-distance').textContent = valid ? km(end - start) : '—';
  $('end-meter-error').textContent = end !== null && (!validNumber(end) || !Number.isInteger(end)) ? 'メーターは整数で入力してください。' : end !== null && validNumber(start) && end < start ? '出発時のメーターより小さくなっています。' : '';
  if (validNumber(start)) $('end-odometer').min = String(start);
}
async function submitFinish(retry = false) {
  if (state.busy || state.phase !== 'active') return;
  if (retry && !pendingForEmployee(state.pendingFinish, state.employee?.id)) { showError(new Error('この送信内容を作成した方で開き直してください。')); return; }
  if (!retry && finishIssue()) { toast(finishIssue()); return; }
  if (!navigator.onLine) { showError(new Error('オフラインのため保存できません。通信が戻ってから再確認してください。')); return; }
  clearError();
  try { if (!state.pendingFinish) state.pendingFinish = newRequest(finishPayload(), 'pending-finish'); }
  catch (error) { showError(error); return; }
  saveDraft(); state.busy = true; renderControls();
  try {
    const result = await api.finishTrip(state.pendingFinish.payload, state.pendingFinish.requestId);
    if (!result.trip?.id || result.trip.status !== 'completed') throw new Error('保存結果を確認できませんでした。同じ内容で再確認してください。');
    completeTrip(result.trip, result.sheetUrl);
    toast(isDemo ? 'プレビュー：保存は行っていません' : '運転完了を記録しました');
  } catch (error) {
    if (error?.code === 'TRIP_ALREADY_COMPLETED') {
      try { const result = await api.getTrip(state.trip.id); if (result.trip?.status === 'completed') { completeTrip(result.trip); $('completed-title').textContent = 'この運転は完了済みです'; toast('保存済みの内容を表示しました。'); return; } } catch { /* Keep the original error visible. */ }
    }
    if (DEFINITIVE_ERRORS.has(error?.code)) { state.pendingFinish = null; writeStore('pending-finish', null); }
    showError(error);
  } finally { state.busy = false; renderControls(); }
}
function safeLink(element, url) {
  element.hidden = true; element.removeAttribute('href');
  if (!url) return;
  try { const parsed = new URL(url); if (parsed.protocol === 'https:') { element.href = parsed.href; element.hidden = false; } } catch { /* Invalid links are omitted. */ }
}
function completeTrip(trip, sheetUrl) {
  state.trip = trip; state.phase = 'completed'; state.sheetUrl = sheetUrl || trip.sheetUrl || null;
  state.pendingFinish = null; writeStore('pending-finish', null); writeStore('active-trip', null);
  $('completed-number').textContent = trip.vehicleNumber || '運転完了';
  $('completed-distance').textContent = km(trip.distance ?? (trip.endOdometer - trip.startOdometer));
  $('completed-time').textContent = `${time(trip.startedAt)} 出発 → ${time(trip.completedAt)} 完了`;
  $('completed-destination').textContent = trip.destination || '';
  $('completed-drivers').textContent = `運転者 ${recordedDriverName(trip)}`;
  $('completed-title').textContent = isDemo ? '運転完了のプレビュー' : '運転を記録しました';
  safeLink($('completed-sheet'), state.sheetUrl);
  renderControls(); window.scrollTo({ top: 0, behavior: 'instant' }); $('completed-title').focus({ preventScroll: true });
}
async function openActiveTrip() {
  const id = state.context?.activeTrip?.id;
  if (!id || state.busy) return;
  state.busy = true; clearError(); renderControls();
  try {
    const result = await api.getTrip(id);
    if (!result.trip?.id || String(result.trip.vehicleId) !== $('vehicle').value) throw new Error('選択車両の運転記録を取得できませんでした。');
    writeStore('active-trip', result.trip.id, true);
    state.pendingStart = null; writeStore('pending-start', null);
    enterTrip(result.trip);
  } catch (error) { showError(error); }
  finally { state.busy = false; renderControls(); }
}
async function nextDrive() {
  ++contextGeneration; state.contextLoading = false; state.phase = 'select'; state.trip = null; state.context = null; state.sheetUrl = null; clearError();
  CHECKS.forEach(([key]) => { $(`check-${key}`).checked = false; });
  setAlcohol('before'); restoreFinish(null); writeStore('draft', { start: startPayload(), finish: null }); renderControls();
  renderVehicle();
  $('department').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' });
}
function addText(parent, tag, text, className) {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  parent.append(element); return element;
}
async function openHistory() {
  const vehicleId = state.trip?.vehicleId || $('vehicle').value;
  if (!vehicleId) return;
  const generation = ++historyGeneration;
  $('history-content').replaceChildren();
  $('history-vehicle').textContent = state.vehicles.find(vehicle => String(vehicle.id) === String(vehicleId))?.number || state.trip?.vehicleNumber || '';
  addText($('history-content'), 'p', '記録を読み込んでいます…', 'history-state');
  if (!$('history-dialog').open) $('history-dialog').showModal();
  try {
    const result = await api.listHistory(vehicleId);
    if (generation !== historyGeneration) return;
    $('history-content').replaceChildren();
    if (!result.trips?.length) { addText($('history-content'), 'p', 'この車両の運転記録はまだありません。', 'history-state'); return; }
    result.trips.forEach(trip => {
      const card = document.createElement('article'); card.className = 'history-entry';
      addText(card, 'h3', `${time(trip.startedAt)} 出発`);
      addText(card, 'p', `${trip.department || ''}　${recordedDriverName(trip) || '氏名未登録'}`, 'history-meta');
      if (trip.status === 'active') addText(card, 'p', '運転中');
      else { addText(card, 'p', `${km(trip.distance ?? (trip.endOdometer - trip.startOdometer))} km`, 'history-distance'); addText(card, 'p', `${time(trip.completedAt)} 完了`, 'history-meta'); }
      if (trip.destination) addText(card, 'p', trip.destination);
      const link = addText(card, 'a', '日報を開く ↗', 'text-link'); link.target = '_blank'; link.rel = 'noopener noreferrer'; safeLink(link, trip.sheetUrl);
      $('history-content').append(card);
    });
  } catch (error) {
    if (generation !== historyGeneration) return;
    $('history-content').replaceChildren();
    const status = addText($('history-content'), 'p', errorMessage(error), 'history-state');
    const retry = addText(status, 'button', 'もう一度読み込む', 'secondary-button'); retry.type = 'button'; retry.addEventListener('click', openHistory);
  }
}
function confirmSubmission(kind) {
  const isStart = kind === 'start';
  if (isStart ? startIssue() : finishIssue()) return;
  confirmAction = isStart ? () => submitStart() : () => submitFinish();
  $('confirm-title').textContent = isStart ? '出発を記録しますか？' : '運転を完了しますか？';
  $('confirm-message').textContent = isStart ? `${currentVehicle()?.number || ''}　${state.employee?.name || ''} さん` : `${state.trip?.vehicleNumber || ''}　走行距離 ${$('trip-distance').textContent} km`;
  $('confirm-submit').textContent = isStart ? '出発を記録' : '完了を記録';
  $('confirm-dialog').showModal();
}
async function initialize() {
  ++contextGeneration; state.contextLoading = false;
  state.phase = 'loading'; clearError(); renderControls();
  $('boot-title').textContent = '車両情報を読み込んでいます'; $('boot-message').textContent = 'しばらくお待ちください。'; $('boot-retry').hidden = true;
  $('boot-status').querySelector('.loading-orbit').hidden = false;
  try {
    const bootstrap = await api.bootstrap();
    if (!bootstrap.employee?.id || typeof bootstrap.employee.name !== 'string' || !bootstrap.employee.name.trim()) throw { code: 'AUTH_REQUIRED' };
    state.employee = { id: String(bootstrap.employee.id), name: bootstrap.employee.name };
    restorePersonalState();
    $('driver-name').value = state.employee.name;
    state.vehicles = bootstrap.vehicles || []; state.departments = bootstrap.departments || [];
    state.favorites = normalizeFavoriteIds(readStore(favoriteStorageKey(state.employee.id)), state.vehicles);
    const serverTimestamp = new Date(bootstrap.serverTime).getTime();
    state.serverOffset = Number.isFinite(serverTimestamp) ? serverTimestamp - Date.now() : null; setDate();
    $('department').replaceChildren(new Option('選択してください', ''));
    state.departments.forEach(department => { const value = typeof department === 'string' ? department : department.name || department.id; $('department').add(new Option(value, value)); });
    state.departments = state.departments.map(department => typeof department === 'string' ? department : department.name || department.id);
    renderVehicleOptions();
    const draft = readStore('draft');
    restoreStart(state.pendingStart?.payload || draft?.start);
    const launch = api.launchContext || {};
    if (launch.department && state.departments.includes(launch.department) && !state.pendingStart) $('department').value = launch.department;
    state.phase = 'select'; state.trip = null; state.context = null;
    // Always start at selection. Only resolve an unfinished submission here;
    // a previously active vehicle never selects the next screen by itself.
    if (state.pendingFinish?.payload?.tripId) {
      try {
        const result = await api.getTrip(state.pendingFinish.payload.tripId);
        if (result.trip?.id) state.trip = result.trip;
        else throw new Error('運転中の記録を確認できませんでした。');
      } catch (error) {
        if (error?.code === 'TRIP_NOT_FOUND') { writeStore('active-trip', null); state.pendingFinish = null; writeStore('pending-finish', null); }
        else { state.phase = 'error'; throw error; }
      }
    }
    renderVehicle();
    renderControls();
  } catch (error) {
    state.phase = 'error'; $('boot-title').textContent = 'アプリを開けませんでした'; $('boot-message').textContent = errorMessage(error);
    $('boot-retry').hidden = false; $('boot-status').querySelector('.loading-orbit').hidden = true; renderControls();
  }
}

buildChecks();
$('demo-banner').hidden = !isDemo;
$('start-form').addEventListener('submit', event => event.preventDefault());
$('finish-form').addEventListener('submit', event => event.preventDefault());
$('department').addEventListener('change', () => { saveDraft(); renderControls(); });
$('vehicle').addEventListener('change', () => {
  ++contextGeneration; state.contextLoading = false;
  clearError(); CHECKS.forEach(([key]) => { $(`check-${key}`).checked = false; }); setAlcohol('before');
  state.context = null; saveDraft(); renderControls();
});
['inspection-fields', 'before-alcohol'].forEach(id => $(id).addEventListener('input', () => { saveDraft(); renderControls(); }));
$('finish-fields').addEventListener('input', () => { renderFinish(); saveDraft(); renderControls(); });
$('refueled').addEventListener('change', () => { if ($('refueled').checked) $('fuel-liters').focus(); });
$('history-button').addEventListener('click', openHistory);
$('favorites-button').addEventListener('click', openFavorites);
$('register-favorites').addEventListener('click', openFavorites);
$('favorites-search').addEventListener('input', renderFavoritePicker);
$('favorites-save').addEventListener('click', saveFavorites);
$('continue-button').addEventListener('click', continueSelection);
$('change-start-selection').addEventListener('click', returnToSelection);
$('change-finish-selection').addEventListener('click', returnToSelection);
$('open-active-trip').addEventListener('click', openActiveTrip);
$('next-drive').addEventListener('click', nextDrive);
$('boot-retry').addEventListener('click', initialize);
$('pending-retry').addEventListener('click', async () => {
  if (state.pendingStart) { state.phase = 'start'; renderControls(); await submitStart(true); }
  else if (state.pendingFinish && state.trip) { enterTrip(state.trip); await submitFinish(true); }
});
$('start-alternative').addEventListener('click', () => confirmSubmission('start'));
$('finish-alternative').addEventListener('click', () => confirmSubmission('finish'));
$('confirm-cancel').addEventListener('click', () => { $('confirm-dialog').close(); confirmAction = null; });
$('confirm-submit').addEventListener('click', () => { const action = confirmAction; confirmAction = null; $('confirm-dialog').close(); action?.(); });
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
window.addEventListener('online', () => { renderControls(); if (state.phase === 'start') loadVehicle(); toast('通信が戻りました'); });
window.addEventListener('offline', renderControls);
document.addEventListener('visibilitychange', () => { if (!document.hidden) setDate(); });
if ('serviceWorker' in navigator && !isDemo) window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => { /* The app remains usable without installation. */ }); });
initialize();
