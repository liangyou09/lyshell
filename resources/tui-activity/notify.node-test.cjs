'use strict';

/**
 * notify.cjs 黑盒测试：全部通过真实子进程 + 回环 HTTP server 验证行为，
 * 不导入模块内部实现，也不修改用户/项目的 Claude、Codex 配置。
 *
 * 运行：node --test resources/tui-activity/notify.node-test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'notify.cjs');
const TOKEN = 'tui-activity-test-token';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childEnv(options) {
  const env = { ...process.env };
  delete env.LYSHELL_TUI_ACTIVITY_ENDPOINT;
  delete env.LYSHELL_TUI_ACTIVITY_TOKEN;
  if (Object.prototype.hasOwnProperty.call(options, 'endpoint')) {
    if (options.endpoint !== undefined) {
      env.LYSHELL_TUI_ACTIVITY_ENDPOINT = options.endpoint;
    }
  }
  if (Object.prototype.hasOwnProperty.call(options, 'token')) {
    if (options.token !== undefined) {
      env.LYSHELL_TUI_ACTIVITY_TOKEN = options.token;
    }
  }
  return env;
}

/**
 * 启动一次 notify.cjs 子进程。
 * options: { input, endpoint, token, holdStdin, waitMs }
 */
function runNode(args, options = {}) {
  const env = childEnv(options);
  const waitMs = options.waitMs || 10000;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // 超过 stdin 上限时子进程会提前退出，父进程写入收到 EPIPE 属预期。
    });

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略：进程可能已经退出。
      }
    }, waitMs);

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try {
        child.stdin.destroy();
      } catch {
        // 忽略：stdin 可能已关闭。
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsed: Date.now() - started,
      });
    };

    child.on('close', finish);

    if (!options.holdStdin) {
      const input =
        options.input === undefined ? '' : options.input;
      try {
        child.stdin.end(input);
      } catch {
        // 忽略：子进程可能已退出。
      }
    }
  });
}

/**
 * 回环事件接收端。options.onRequest(req, res, record) 可自定义响应/断开行为；
 * 默认返回 200 JSON。
 */
async function startServer(options = {}) {
  const requests = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      if (options.onRequest) {
        options.onRequest(req, res, record);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;

  return {
    port,
    requests,
    endpoint: `http://127.0.0.1:${port}/events`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function hookBody(overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'session-1',
    ...overrides,
  });
}

function parseBody(record) {
  return JSON.parse(record.raw);
}

function assertHookNoop(result) {
  assert.equal(result.code, 0, `exit code, stderr=${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
}

test('hook 转发 SessionStart 身份字段、token header，并输出空对象', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const before = Date.now();
  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: hookBody(),
  });
  const after = Date.now();

  assertHookNoop(result);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(srv.requests.length, 1);

  const record = srv.requests[0];
  assert.equal(record.method, 'POST');
  assert.equal(record.url, '/events');
  assert.equal(record.headers['content-type'], 'application/json');
  assert.equal(record.headers['x-lyshell-tui-token'], TOKEN);
  assert.equal(record.headers.authorization, undefined);

  const body = parseBody(record);
  assert.deepEqual(Object.keys(body), [
    'hookEvent',
    'sessionId',
    'eventId',
    'at',
  ]);
  assert.equal(body.hookEvent, 'SessionStart');
  assert.equal(body.sessionId, 'session-1');
  assert.match(body.eventId, UUID_V4);
  assert.ok(Number.isInteger(body.at));
  assert.ok(body.at >= before - 1000 && body.at <= after + 1000);
  assert.equal(record.raw.includes(TOKEN), false);
});

test('hook 仅在提供时转发 turn_id 与 notification_type', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: hookBody({
      hook_event_name: 'Notification',
      turn_id: 'turn-9',
      notification_type: 'permission_request',
    }),
  });

  assertHookNoop(result);
  assert.equal(srv.requests.length, 1);

  const body = parseBody(srv.requests[0]);
  assert.deepEqual(Object.keys(body), [
    'hookEvent',
    'sessionId',
    'turnId',
    'notificationType',
    'eventId',
    'at',
  ]);
  assert.equal(body.hookEvent, 'Notification');
  assert.equal(body.turnId, 'turn-9');
  assert.equal(body.notificationType, 'permission_request');
});

test('hook 保留工具调用身份而不转发工具参数', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: hookBody({ hook_event_name: 'PostToolUse', tool_use_id: 'call-parallel-1', tool_input: { command: 'private-command' } }),
  });
  assertHookNoop(result);
  assert.equal(parseBody(srv.requests[0]).callId, 'call-parallel-1');
  assert.equal(srv.requests[0].raw.includes('private-command'), false);
});

test('hook 丢弃 prompt、message、工具参数、transcript 等非身份内容', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: hookBody({
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-1',
      notification_type: 'permission_request',
      prompt: 'PROMPT_SECRET',
      message: 'MESSAGE_SECRET',
      transcript_path: '/secret/TRANSCRIPT_SECRET.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'TOOL_INPUT_SECRET' },
      tool_response: { output: 'TOOL_RESPONSE_SECRET' },
      permission_suggestions: [{ type: 'addRules', rules: ['SUGGESTION_SECRET'] }],
      cwd: '/secret/CWD_SECRET',
    }),
  });

  assertHookNoop(result);
  assert.equal(srv.requests.length, 1);

  const raw = srv.requests[0].raw;
  const body = parseBody(srv.requests[0]);
  assert.deepEqual(Object.keys(body), [
    'hookEvent',
    'sessionId',
    'turnId',
    'notificationType',
    'eventId',
    'at',
  ]);
  for (const secret of [
    'PROMPT_SECRET',
    'MESSAGE_SECRET',
    'TRANSCRIPT_SECRET',
    'TOOL_INPUT_SECRET',
    'TOOL_RESPONSE_SECRET',
    'SUGGESTION_SECRET',
    'CWD_SECRET',
  ]) {
    assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(raw.includes('tool_input'), false);
  assert.equal(raw.includes('transcript_path'), false);
});

test('notify 将 agent-turn-complete 规范化为 TurnComplete', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const payload = {
    type: 'agent-turn-complete',
    'thread-id': 'thread-42',
    'turn-id': 'turn-42',
    'input-messages': ['NOTIFY_INPUT_SECRET'],
    'last-assistant-message': 'NOTIFY_OUTPUT_SECRET',
  };

  const result = await runNode(['notify', JSON.stringify(payload)], {
    endpoint: srv.endpoint,
    token: TOKEN,
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(srv.requests.length, 1);

  const raw = srv.requests[0].raw;
  const body = parseBody(srv.requests[0]);
  assert.deepEqual(Object.keys(body), [
    'hookEvent',
    'sessionId',
    'turnId',
    'eventId',
    'at',
  ]);
  assert.equal(body.hookEvent, 'TurnComplete');
  assert.equal(body.sessionId, 'thread-42');
  assert.equal(body.turnId, 'turn-42');
  assert.match(body.eventId, UUID_V4);
  assert.equal(raw.includes('NOTIFY_INPUT_SECRET'), false);
  assert.equal(raw.includes('NOTIFY_OUTPUT_SECRET'), false);
});

test('notify 对不支持的类型、缺失身份和畸形 JSON 完全静默', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const cases = [
    ['notify'],
    ['notify', ''],
    ['notify', '{'],
    ['notify', '[]'],
    ['notify', 'null'],
    ['notify', JSON.stringify({ type: 'agent-turn-start', 'thread-id': 't' })],
    ['notify', JSON.stringify({ type: 'agent-turn-complete' })],
    ['notify', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': '' })],
    [
      'notify',
      JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'x'.repeat(257) }),
    ],
    [
      'notify',
      JSON.stringify({
        type: 'agent-turn-complete',
        'thread-id': 't',
        'turn-id': 'x'.repeat(257),
      }),
    ],
    [
      'notify',
      JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't\n' }),
    ],
    [
      'notify',
      JSON.stringify({
        type: 'agent-turn-complete',
        'thread-id': 't',
        'turn-id': 'u\x00',
      }),
    ],
  ];

  for (const args of cases) {
    const result = await runNode(args, {
      endpoint: srv.endpoint,
      token: TOKEN,
    });
    assert.equal(result.code, 0, `args=${JSON.stringify(args).slice(0, 80)}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }

  await delay(150);
  assert.equal(srv.requests.length, 0);
});

test('hook 对未知、大小写错误或缺失的事件名不转发', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const cases = [
    { hook_event_name: 'SubagentStop', session_id: 's' },
    { hook_event_name: 'stop', session_id: 's' },
    { hook_event_name: 'SessionStart ', session_id: 's' },
    { hook_event_name: ' SessionStart', session_id: 's' },
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 42, session_id: 's' },
    { session_id: 's' },
    {},
  ];

  for (const input of cases) {
    const result = await runNode(['hook'], {
      endpoint: srv.endpoint,
      token: TOKEN,
      input: JSON.stringify(input),
    });
    assertHookNoop(result);
  }

  await delay(150);
  assert.equal(srv.requests.length, 0);
});

test('非法 endpoint 一律拒绝连接（localhost、IPv6、用户名、查询、路径等）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const port = srv.port;

  const endpoints = [
    `http://localhost:${port}/events`,
    `http://127.0.0.1:${port}/events?x=1`,
    `http://127.0.0.1:${port}/events#frag`,
    `http://user:pass@127.0.0.1:${port}/events`,
    `http://user@127.0.0.1:${port}/events`,
    `http://[::1]:${port}/events`,
    `https://127.0.0.1:${port}/events`,
    `http://127.0.0.1:${port}/events/`,
    `http://127.0.0.1:${port}/event`,
    `http://127.0.0.1:${port}/events/extra`,
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1/events`,
    `http://127.0.0.1:0/events`,
    `http://127.0.0.1:65536/events`,
    `http://127.0.0.1:99999/events`,
    `ftp://127.0.0.1:${port}/events`,
    `127.0.0.1:${port}/events`,
    `http://127.0.0.1:${port}/events `,
    '',
  ];

  for (const endpoint of endpoints) {
    const result = await runNode(['hook'], {
      endpoint,
      token: TOKEN,
      input: hookBody(),
    });
    assertHookNoop(result);
    assert.equal(result.stdout.trim(), '{}');
  }

  await delay(150);
  assert.equal(srv.requests.length, 0);
});

test('缺少 endpoint、缺少 token 或带换行的 token 都不连接', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const cases = [
    { token: TOKEN },
    { endpoint: srv.endpoint },
    { endpoint: srv.endpoint, token: '' },
    { endpoint: srv.endpoint, token: 'bad\ntoken' },
    { endpoint: srv.endpoint, token: 'bad\rtoken' },
  ];

  for (const options of cases) {
    const result = await runNode(['hook'], {
      ...options,
      input: hookBody(),
    });
    assertHookNoop(result);
  }

  await delay(150);
  assert.equal(srv.requests.length, 0);
});

test('hook 对空输入、畸形 JSON、标量和非法 UTF-8 输出空对象', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const inputs = [
    '',
    '{',
    'not json',
    'null',
    '[]',
    '"SessionStart"',
    '42',
    Buffer.from([0xff, 0xfe, 0x7b, 0x22]),
  ];

  for (const input of inputs) {
    const result = await runNode(['hook'], {
      endpoint: srv.endpoint,
      token: TOKEN,
      input,
    });
    assertHookNoop(result);
  }

  await delay(150);
  assert.equal(srv.requests.length, 0);
});

function paddedHookPayload(targetBytes) {
  const base = {
    hook_event_name: 'SessionStart',
    session_id: 'session-size',
    pad: '',
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const payload = { ...base, pad: 'x'.repeat(targetBytes - baseBytes) };
  const text = JSON.stringify(payload);
  assert.equal(Buffer.byteLength(text, 'utf8'), targetBytes);
  return text;
}

test('hook 接受 256 KiB 上限输入，拒绝多 1 字节的输入', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const atLimit = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: paddedHookPayload(256 * 1024),
  });
  assertHookNoop(atLimit);
  assert.equal(srv.requests.length, 1);
  assert.deepEqual(Object.keys(parseBody(srv.requests[0])), [
    'hookEvent',
    'sessionId',
    'eventId',
    'at',
  ]);

  const overLimit = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: paddedHookPayload(256 * 1024 + 1),
  });
  assertHookNoop(overLimit);

  await delay(150);
  assert.equal(srv.requests.length, 1);
});

test('hook 身份字段限制为 1..256 字符、notification_type 限制为 1..128', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const accepted = [
    hookBody({ session_id: 's'.repeat(256) }),
    hookBody({ turn_id: 't'.repeat(256) }),
    hookBody({
      hook_event_name: 'Notification',
      notification_type: 'n'.repeat(128),
    }),
  ];
  for (const input of accepted) {
    const result = await runNode(['hook'], {
      endpoint: srv.endpoint,
      token: TOKEN,
      input,
    });
    assertHookNoop(result);
  }
  assert.equal(srv.requests.length, 3);

  const rejected = [
    hookBody({ session_id: '' }),
    hookBody({ session_id: 's'.repeat(257) }),
    hookBody({ turn_id: '' }),
    hookBody({ turn_id: 't'.repeat(257) }),
    hookBody({ turn_id: 7 }),
    hookBody({ hook_event_name: 'Notification', notification_type: '' }),
    hookBody({
      hook_event_name: 'Notification',
      notification_type: 'n'.repeat(129),
    }),
    hookBody({
      hook_event_name: 'Notification',
      notification_type: { type: 'secret' },
    }),
    // 与主进程 identifier 对齐：身份/类型里的控制字符不得转发。
    hookBody({ session_id: 's\n' }),
    hookBody({ session_id: 's\x00' }),
    hookBody({ turn_id: 't\r' }),
    hookBody({
      hook_event_name: 'Notification',
      notification_type: 'n\t',
    }),
  ];
  for (const input of rejected) {
    const result = await runNode(['hook'], {
      endpoint: srv.endpoint,
      token: TOKEN,
      input,
    });
    assertHookNoop(result);
  }

  await delay(150);
  assert.equal(srv.requests.length, 3);
});

test('服务器不响应时 hook 约 800ms 超时并以空对象退出', async (t) => {
  const srv = await startServer({ onRequest: () => {} });
  t.after(() => srv.close());

  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    input: hookBody(),
  });

  assertHookNoop(result);
  assert.equal(srv.requests.length, 1);
  assert.ok(result.elapsed >= 700, `elapsed=${result.elapsed}ms`);
  assert.ok(result.elapsed < 4000, `elapsed=${result.elapsed}ms`);
});

test('服务器断开或端口拒绝连接时 hook 静默退出 0', async (t) => {
  const disconnecting = await startServer({
    onRequest: (req) => req.socket.destroy(),
  });
  t.after(() => disconnecting.close());

  const disconnected = await runNode(['hook'], {
    endpoint: disconnecting.endpoint,
    token: TOKEN,
    input: hookBody(),
  });
  assertHookNoop(disconnected);
  assert.equal(disconnecting.requests.length, 1);

  const closed = await startServer();
  const closedPort = closed.port;
  await closed.close();

  const refused = await runNode(['hook'], {
    endpoint: `http://127.0.0.1:${closedPort}/events`,
    token: TOKEN,
    input: hookBody(),
  });
  assertHookNoop(refused);
});

test('stdin 不关闭时 hook 约 1 秒放弃读取并输出空对象', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const result = await runNode(['hook'], {
    endpoint: srv.endpoint,
    token: TOKEN,
    holdStdin: true,
  });

  assertHookNoop(result);
  assert.ok(result.elapsed >= 800, `elapsed=${result.elapsed}ms`);
  assert.ok(result.elapsed < 4000, `elapsed=${result.elapsed}ms`);
  await delay(100);
  assert.equal(srv.requests.length, 0);
});

test('notify 成功与失败路径都不产生 stdout/stderr', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const ok = await runNode(
    [
      'notify',
      JSON.stringify({
        type: 'agent-turn-complete',
        'thread-id': 'thread-silent',
      }),
    ],
    { endpoint: srv.endpoint, token: TOKEN }
  );
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  assert.equal(srv.requests.length, 1);
  assert.equal(parseBody(srv.requests[0]).turnId, undefined);

  const closed = await startServer();
  const closedPort = closed.port;
  await closed.close();

  const failed = await runNode(
    [
      'notify',
      JSON.stringify({
        type: 'agent-turn-complete',
        'thread-id': 'thread-failed',
      }),
    ],
    {
      endpoint: `http://127.0.0.1:${closedPort}/events`,
      token: TOKEN,
    }
  );
  assert.equal(failed.code, 0);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, '');
});
