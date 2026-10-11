// Run with: node --test .agents/skills/impeccable/scripts/runtime-check.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('live session remains usable when the localStorage getter is blocked', () => {
  const root = {};
  Object.defineProperty(root, 'localStorage', {
    get() { throw new Error('Storage access denied'); },
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'live-browser-session.js'), 'utf8'), { window: root });
  const state = root.__IMPECCABLE_LIVE_SESSION__.createLiveBrowserSessionState({ prefix: 'test', idFactory: () => 'owner' });
  state.saveSession({ id: 'session' });
  assert.equal(state.loadSession(), null);
  assert.equal(state.nextCheckpointRevision(), 1);
  state.markHandled('session');
  state.clearSession();
});

test('Windows launcher returns from a PATH batch shim probe and preserves its exit status', { skip: process.platform !== 'win32' }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-launcher-'));
  try {
    const launcher = path.join(fixture, 'launcher.cmd');
    fs.copyFileSync(path.join(__dirname, 'impeccable.cmd'), launcher);
    fs.writeFileSync(path.join(fixture, 'VERSION'), '0.1.14');
    fs.writeFileSync(path.join(fixture, 'impeccable.cmd'), [
      '@echo off',
      'if "%~1"=="engine-probe" goto probe',
      'echo ran-engine',
      'exit /b 7',
      ':probe',
      'echo impeccable-engine 0.1.14',
      'exit /b 0',
      '',
    ].join('\r\n'));
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher, 'context'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env,
        PATH: fixture + path.delimiter + process.env.PATH,
        USERPROFILE: fixture,
        IMPECCABLE_HOME: path.join(fixture, 'cache'),
        IMPECCABLE_BIN: '',
        IMPECCABLE_LAUNCHER_PROBE: '',
      },
    });
    assert.ifError(result.error);
    assert.match(result.stdout, /ran-engine/);
    assert.equal(result.status, 7);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
test('POSIX launcher rejects a failing engine probe even when its output matches', { skip: !fs.existsSync(bash) }, () => {
  const source = fs.readFileSync(path.join(__dirname, 'impeccable'), 'utf8').replace(/\r\n/g, '\n');
  const probe = source.match(/probe_ok\(\) \{[\s\S]*?\n\}/)[0];
  const result = spawnSync(bash, ['-s'], {
    input: probe + '\nengine() { echo impeccable-engine 0.1.14; return 9; }\nif probe_ok engine; then exit 1; fi\nengine() { echo impeccable-engine 0.1.14; return 0; }\nprobe_ok engine\n',
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
});
