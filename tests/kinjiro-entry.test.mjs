import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const sourcePath = process.env.KINJIRO_INDEX_PATH || 'C:/kintai-web/kintai-pwa-main/index.html';
const backupPath = fileURLToPath(new URL('../.local-preview/kinjiro-index.before.html', import.meta.url));
const previewPath = fileURLToPath(new URL('../preview/kinjiro-entry.html', import.meta.url));
const hasSource = fs.existsSync(sourcePath);
const sourceBytes = hasSource ? fs.readFileSync(sourcePath) : null;
const source = sourceBytes?.toString('utf8') || '';
const sourceOptions = { skip: hasSource ? false : 'The external Kinjiro checkout is not present.' };

function entryBlock(kind) {
  const markers = {
    css: [/^  \/\* drive-diary-css:start \*\/\n/m, /^  \/\* drive-diary-css:end \*\/\n/m],
    html: [/^  <!-- drive-diary-entry:start -->\n/m, /^  <!-- drive-diary-entry:end -->\n/m],
    script: [/^  \/\/ drive-diary-script:start\n/m, /^  \/\/ drive-diary-script:end\n/m],
  };
  const [startPattern, endPattern] = markers[kind];
  const start = startPattern.exec(source);
  const end = endPattern.exec(source);
  assert.ok(start && end && end.index > start.index, kind + ' markers must enclose one block');
  return source.slice(start.index, end.index + end[0].length);
}

function launch({ appUrl = '', user = { id: '000123' }, token = 'fixture-token+/#?&=', department = '建設2G', host = 'kinjiro.example.test' } = {}) {
  const opened = [];
  const toasts = [];
  const code = entryBlock('script').replace(
    /const DRIVE_DIARY_APP_URL = [^\n]*;/,
    'const DRIVE_DIARY_APP_URL = ' + JSON.stringify(appUrl) + ';',
  );
  vm.runInNewContext(code + '\nopenDrivingDiary();', {
    URL, URLSearchParams,
    currentUser: user,
    currentAuthToken: token,
    showToast: (message) => toasts.push(message),
    document: { getElementById: (id) => id === 'work-dept' ? { value: department } : null },
    window: { location: { hostname: host }, open: (...args) => opened.push(args) },
  }, { timeout: 1000 });
  return { opened, toasts };
}

test('entry preview links to the local diary demo without real account data', () => {
  const preview = fs.readFileSync(previewPath, 'utf8');
  assert.match(preview, /href="\.\.\/\?demo=1"/);
  assert.match(preview, /稼働情報（必須）/);
  assert.match(preview, /車両点検・出発・帰着の記録/);
  assert.doesNotMatch(preview, /script\.google\.com|docs\.google\.com|kinjiroToken=/);
});

test('entry is placed after work details and before hidden history', sourceOptions, () => {
  const block = entryBlock('html');
  assert.equal(source.split('<!-- drive-diary-entry:start -->').length, 2);
  assert.ok(source.indexOf('id="work-content"') < source.indexOf(block));
  assert.ok(source.indexOf(block) < source.indexOf('<!-- 履歴（非表示） -->'));
  assert.match(block, /type="button"/);
  assert.match(block, /aria-label="運転日報を開く"/);
  assert.match(block, /aria-describedby="drive-diary-description"/);
  assert.match(block, /<svg/);
});

test('entry styling covers keyboard focus and light theme', sourceOptions, () => {
  const css = entryBlock('css');
  assert.match(css, /\.drive-diary-entry:focus-visible/);
  assert.match(css, /body\.light \.drive-diary-entry/);
  assert.match(css, /prefers-reduced-motion/);
});

test('existing BOM and newline style are preserved', {
  skip: hasSource && fs.existsSync(backupPath) ? false : 'The local original backup is not present.',
}, () => {
  const backup = fs.readFileSync(backupPath);
  const before = backup.toString('utf8');
  assert.deepEqual(sourceBytes.subarray(0,3), backup.subarray(0,3));
  assert.equal(source.includes('\r\n'), before.includes('\r\n'));
  assert.equal(/(?<!\r)\n/.test(source), /(?<!\r)\n/.test(before));
});

test('unconfigured entry explains publication is being prepared', sourceOptions, () => {
  const result = launch();
  assert.equal(result.opened.length, 0);
  assert.deepEqual(result.toasts, ['運転日報の公開準備中です']);
});

test('configured entry requires the existing Kinjiro session', sourceOptions, () => {
  for (const options of [{ user: null }, { user: { id: '' } }, { token: '' }]) {
    const result = launch({ appUrl: 'https://diary.example.test/app/', ...options });
    assert.equal(result.opened.length, 0);
    assert.deepEqual(result.toasts, ['キンジロウに再ログインしてから開いてください']);
  }
});

test('session and selected department travel only in the URL fragment', sourceOptions, () => {
  const result = launch({ appUrl: 'https://diary.example.test/app/?version=1#view=start' });
  assert.equal(result.opened.length, 1);
  const [href, target, features] = result.opened[0];
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.search, '?version=1');
  assert.equal(url.searchParams.has('kinjiroToken'), false);
  assert.equal(fragment.get('kinjiroEmployeeId'), '000123');
  assert.equal(fragment.get('kinjiroToken'), 'fixture-token+/#?&=');
  assert.equal(fragment.get('department'), '建設2G');
  assert.equal(fragment.get('view'), 'start');
  assert.equal(target, '_blank');
  assert.equal(features, 'noopener,noreferrer');
});

test('unsafe or nonabsolute publication URLs do not open a window', sourceOptions, () => {
  for (const appUrl of ['javascript:alert(1)', 'http://diary.example.test/', '/relative-app/', 'https://name:password@diary.example.test/']) {
    const result = launch({ appUrl });
    assert.equal(result.opened.length, 0);
    assert.deepEqual(result.toasts, ['運転日報の公開URLを確認してください']);
  }
});

test('HTTP preview is permitted only when both pages are local', sourceOptions, () => {
  assert.equal(launch({ appUrl: 'http://127.0.0.1:4173/?demo=1', host: 'localhost' }).opened.length, 1);
  assert.equal(launch({ appUrl: 'http://127.0.0.1:4173/?demo=1' }).opened.length, 0);
  assert.equal(launch({ appUrl: 'http://diary.example.test/', host: 'localhost' }).opened.length, 0);
});

