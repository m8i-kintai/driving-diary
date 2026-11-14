import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function showWarnings(');
const end = source.indexOf('function newRequest(', start);
assert.ok(start >= 0 && end > start, '実際の通知表示関数を取得できること');
const showWarningsSource = source.slice(start, end);

function fixture() {
  const element = tag => {
    const classes = new Set();
    return {
      tag, children: [], textContent: '', className: '',
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; }
    };
  };
  const content = element('div');
  const dialog = {
    open: false, showCount: 0, closeCount: 0,
    showModal() { this.open = true; this.showCount++; },
    close() { this.open = false; this.closeCount++; }
  };
  const nodes = { 'warnings-content': content, 'warnings-dialog': dialog };
  const context = vm.createContext({ $: id => nodes[id], document: { createElement: element } });
  vm.runInContext(showWarningsSource, context);
  return { show: warnings => context.showWarnings(warnings), content, dialog };
}

test('inspection-only warnings do not open the vehicle notification dialog', () => {
  const f = fixture();
  f.show([
    { type: 'inspection', level: 'info', title: '車検のお知らせ', message: '3か月前です。' },
    { type: 'inspection', level: 'danger', title: '車検のお知らせ', message: '満了日を確認してください。' }
  ]);
  assert.equal(f.dialog.showCount, 0);
  assert.equal(f.dialog.open, false);
  assert.equal(f.content.children.length, 0);
});

test('mixed warnings retain oil notices and overdue severity while excluding inspection', () => {
  const f = fixture();
  f.show([
    { type: 'oil', level: 'warning', title: 'オイル交換時期', message: '目安まで残り40kmです。' },
    { type: 'inspection', level: 'danger', title: '車検のお知らせ', message: '車検満了です。' },
    { type: 'oil', level: 'danger', title: 'オイル交換時期', message: '交換の目安距離に達しています。' }
  ]);
  assert.equal(f.dialog.showCount, 1);
  assert.equal(f.content.children.length, 2);
  const [nearDue, overdue] = f.content.children;
  assert.deepEqual(nearDue.children.map(node => node.textContent), ['オイル交換時期', '目安まで残り40kmです。']);
  assert.deepEqual(overdue.children.map(node => node.textContent), ['オイル交換時期', '交換の目安距離に達しています。']);
  assert.equal(nearDue.classList.contains('is-critical'), false);
  assert.equal(overdue.classList.contains('is-critical'), true);
});

test('no remaining notice closes a stale dialog and removes its previous content', () => {
  for (const warnings of [[], [{ type: 'inspection', title: '車検のお知らせ' }]]) {
    const f = fixture();
    f.dialog.open = true;
    f.content.children.push({ textContent: '以前のお知らせ' });
    f.show(warnings);
    assert.equal(f.dialog.open, false);
    assert.equal(f.dialog.closeCount, 1);
    assert.equal(f.dialog.showCount, 0);
    assert.equal(f.content.children.length, 0);
  }
});
