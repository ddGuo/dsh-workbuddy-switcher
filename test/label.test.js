import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// 用户反馈：账号库里几个账号全显示成一串 uid，分不清谁是谁。
// 名字现在是「手动改名 > 导入时解密的昵称 > uid」，两边各自验证。
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到 ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `找不到 ${from} 的结尾 ${to}`);
  return source.slice(start, end);
}

test('savedLabel 忽略空、空白和非字符串，只认有内容的名字', () => {
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(slice(host, 'function savedLabel(', '/** Archive whatever credential'), context);
  const call = (state) => vm.runInContext('savedLabel', context)(state, 'abc.json');
  assert.equal(call({}), undefined);
  assert.equal(call({ labels: null }), undefined);
  assert.equal(call({ labels: { 'abc.json': '   ' } }), undefined);
  assert.equal(call({ labels: { 'abc.json': 7 } }), undefined);
  assert.equal(call({ labels: { 'other.json': '别的号' } }), undefined);
  assert.equal(call({ labels: { 'abc.json': '公司号' } }), '公司号');
});

test('显示名按 手动改名 > 昵称 > uid 兜底', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(slice(client, 'function shortUid(', '    /** Shared data layer'), context);
  const call = (account) => vm.runInContext('labelOf', context)(account);
  assert.equal(call({ label: '公司号', nickname: '昵称', uid: 'a'.repeat(20) }), '公司号');
  assert.equal(call({ label: null, nickname: '昵称', uid: 'a'.repeat(20) }), '昵称');
  assert.equal(call({ label: null, nickname: '', uid: '6f282726-adda-414c' }), '6f282726…414c');
});
