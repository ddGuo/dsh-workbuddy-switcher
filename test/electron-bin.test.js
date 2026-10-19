import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// 用户反馈的 bug 回归测试：导入当前账号报
//   spawnSync D:\WorkBuddy\WorkBuddy.exe ENOENT
//
// 原因：lib/index.js 把作者机器的安装路径写死成兜底
//     const electron = process.env['WORKBUDDY_ELECTRON_BIN'] ?? 'D:\\WorkBuddy\\WorkBuddy.exe';
// WorkBuddy 的默认安装位置是 %LOCALAPPDATA%\Programs\WorkBuddy，
// 所以「默认安装 + 没设环境变量」的用户必然失败。
//
// 这里用 vm 把 electronBinCandidates() / electronBin() 抽出来，配上假的
// env / existsSync / 注册表输出跑，验证四处来源与顺序。
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 function ${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} 大括号不平衡`);
}

/**
 * 在隔离上下文里跑 electronBinCandidates()/electronBin()。
 *
 * @param options.env 环境变量
 * @param options.existing 判定存在的文件集合
 * @param options.registry 假注册表输出（key -> reg query 文本）
 */
function harness({ env = {}, existing = [], registry = {} } = {}) {
  const queried = [];
  const context = vm.createContext({
    process: { env },
    join: (...parts) => parts.join('\\'),
    existsSync: (path) => existing.includes(path),
    execFileSync: (command, args) => {
      assert.equal(command, 'reg');
      // 调用形如 execFileSync('reg', ['query', <key>, '/s', '/f', 'WorkBuddy'])
      assert.equal(args[0], 'query');
      queried.push(args[1]);
      const text = registry[args[1]];
      if (text === undefined) throw new Error('registry miss');
      return text;
    },
  });
  vm.runInContext(
    `${sliceFunction('electronBinCandidates')}\n${sliceFunction('electronBin')}\nglobalThis.candidates = electronBinCandidates;\nglobalThis.pick = electronBin;`,
    context,
  );
  return {
    candidates: () => vm.runInContext('candidates()', context),
    pick: () => vm.runInContext('pick()', context),
    queried,
  };
}

test('环境变量优先，且不再回退到作者机器的 D:\\WorkBuddy', () => {
  const explicit = 'E:\\custom\\WorkBuddy.exe';
  const h = harness({ env: { WORKBUDDY_ELECTRON_BIN: explicit }, existing: [explicit] });
  const list = h.candidates();
  assert.equal(list[0], explicit, '显式覆盖必须是第一候选');
  assert.ok(
    !list.includes('D:\\WorkBuddy\\WorkBuddy.exe'),
    `不应再出现写死的作者路径，实际候选：${JSON.stringify(list)}`,
  );
  assert.equal(h.pick(), explicit);
});

test('默认安装位置 %LOCALAPPDATA%\\Programs\\WorkBuddy 能被发现', () => {
  const expected = 'C:\\Users\\someone\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe';
  const h = harness({
    env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' },
    existing: [expected],
  });
  assert.ok(h.candidates().includes(expected), '应当把默认安装位置列为候选');
  assert.equal(h.pick(), expected);
});

test('自定义安装目录靠注册表 DisplayIcon 发现', () => {
  const custom = 'F:\\Apps\\WorkBuddy\\WorkBuddy.exe';
  const h = harness({
    env: {},
    existing: [custom],
    registry: {
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall':
        'HKEY_CURRENT_USER\\...\\BFD312E9\r\n    DisplayName    REG_SZ    WorkBuddy 5.8.3\r\n' +
        `    DisplayIcon    REG_SZ    ${custom},0\r\n`,
    },
  });
  assert.ok(h.candidates().includes(custom), '注册表里的 DisplayIcon 应当成为候选');
  assert.equal(h.pick(), custom);
});

test('注册表 InstallLocation 目录也能拼出可执行文件', () => {
  const dir = 'F:\\Apps\\WorkBuddy';
  const h = harness({
    env: {},
    existing: [`${dir}\\WorkBuddy.exe`],
    registry: {
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall':
        `    InstallLocation    REG_SZ    ${dir}\r\n`,
    },
  });
  assert.equal(h.pick(), `${dir}\\WorkBuddy.exe`);
});

test('Program Files 系列也作为候选', () => {
  const expected = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  const h = harness({ env: { ProgramFiles: 'C:\\Program Files' }, existing: [expected] });
  assert.ok(h.candidates().includes(expected));
  assert.equal(h.pick(), expected);
});

test('全都找不到时抛出可操作的中文错误（含环境变量名与已查找路径）', () => {
  const h = harness({ env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' } });
  assert.throws(
    () => h.pick(),
    (error) => {
      assert.match(error.message, /没找到 WorkBuddy 可执行文件/);
      assert.match(error.message, /WORKBUDDY_ELECTRON_BIN/);
      assert.match(error.message, /WorkBuddy\.exe/);
      return true;
    },
  );
});

test('候选列表去重（环境变量与探测结果重合时）', () => {
  const same = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
  const h = harness({
    env: { WORKBUDDY_ELECTRON_BIN: same, ProgramFiles: 'C:\\Program Files' },
    existing: [same],
  });
  assert.equal(h.candidates().filter((path) => path === same).length, 1);
});
