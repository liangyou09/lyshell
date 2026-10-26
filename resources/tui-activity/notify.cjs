#!/usr/bin/env node
'use strict';

/**
 * LyShell TUI 状态活动通知转发器。
 *
 * 独立运行，不依赖 LyShell 主进程或项目依赖：
 *   node notify.cjs hook            从 stdin 读取 Claude hook JSON
 *   node notify.cjs notify <json>   读取 Codex notify 的末尾 JSON 参数
 *
 * 只把白名单内的身份/类型字段转发到本机回环事件端点；prompt、message、
 * 工具参数、transcript 等内容一律丢弃。所有失败路径静默退出 0，避免阻塞 CLI。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MODE_HOOK = 'hook';
const MODE_NOTIFY = 'notify';

const ENDPOINT_PATH = '/events';
const TOKEN_HEADER = 'x-lyshell-tui-token';
const ENDPOINT_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/events$/;

const MAX_INPUT_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 1000;
const HTTP_TIMEOUT_MS = 800;
const MAX_IDENTITY_CHARS = 256;
const MAX_NOTIFICATION_TYPE_CHARS = 128;

const HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionEnd',
  'TurnComplete',
]);

let hookStdoutWritten = false;

/**
 * 校验连接配置。端点必须严格是 http://127.0.0.1:<1-65535>/events，
 * 不接受用户名/密码、查询串、hash、其他 host（含 localhost/IPv6）或路径。
 */
function readConfig() {
  const endpoint = process.env.LYSHELL_TUI_ACTIVITY_ENDPOINT;
  const token = process.env.LYSHELL_TUI_ACTIVITY_TOKEN;
  if (typeof endpoint !== 'string' || typeof token !== 'string') return null;

  const match = ENDPOINT_PATTERN.exec(endpoint);
  if (!match) return null;

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (token.length === 0 || token.includes('\r') || token.includes('\n')) return null;

  return { hostname: '127.0.0.1', port, path: ENDPOINT_PATH, token };
}

/** 解析为普通对象；数组、null 和标量都视为非法。 */
function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 读取可选/必填字符串字段。
 * 返回 undefined 表示字段缺失或为 null；返回 null 表示类型或长度非法。
 */
function readStringField(source, key, maxChars) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  if (value.length < 1 || value.length > maxChars) return null;
  // 与主进程 parseTuiEvent 的 identifier 保持一致：身份/类型不允许控制字符。
  if (/[\x00-\x1f]/.test(value)) return null;
  return value;
}

function createPayload(hookEvent, sessionId, turnId, notificationType, callId) {
  const payload = { hookEvent, sessionId };
  if (typeof turnId === 'string') payload.turnId = turnId;
  if (typeof notificationType === 'string') payload.notificationType = notificationType;
  if (typeof callId === 'string') payload.callId = callId;
  payload.eventId = crypto.randomUUID();
  payload.at = Date.now();
  return payload;
}

/** Claude hook：只提取 hook_event_name / session_id / turn_id / notification_type。 */
function buildHookPayload(value) {
  const hookEvent = value.hook_event_name;
  if (typeof hookEvent !== 'string' || !HOOK_EVENTS.has(hookEvent)) return null;

  const sessionId = readStringField(value, 'session_id', MAX_IDENTITY_CHARS);
  if (typeof sessionId !== 'string') return null;

  const turnId = readStringField(value, 'turn_id', MAX_IDENTITY_CHARS);
  if (turnId === null) return null;
  const callId = readStringField(value, 'tool_use_id', MAX_IDENTITY_CHARS);
  if (callId === null) return null;

  const notificationType = readStringField(
    value,
    'notification_type',
    MAX_NOTIFICATION_TYPE_CHARS
  );
  if (notificationType === null) return null;

  return createPayload(hookEvent, sessionId, turnId, notificationType, callId);
}

/** Codex notify：仅接受 agent-turn-complete，thread-id/turn-id 映射到会话/回合。 */
function buildNotifyPayload(value) {
  if (value.type !== 'agent-turn-complete') return null;

  const sessionId = readStringField(value, 'thread-id', MAX_IDENTITY_CHARS);
  if (typeof sessionId !== 'string') return null;

  const turnId = readStringField(value, 'turn-id', MAX_IDENTITY_CHARS);
  if (turnId === null) return null;

  return createPayload('TurnComplete', sessionId, turnId, undefined);
}

/**
 * 读取 stdin，带 256 KiB 字节上限和 1 秒硬超时。
 * 超限/超时/读取错误返回 null；正常结束返回 UTF-8 文本（可能为空串）。
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;

    const onData = (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = () => {
      finish(null);
    };

    function finish(value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      try {
        process.stdin.pause();
      } catch {
        // 忽略：读取已结束，pause 失败不影响退出。
      }
      resolve(value);
    }

    timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

/** POST 单次事件；800 ms 硬超时，不跟随重定向，任何异常都转成静默完成。 */
function postPayload(config, payload) {
  return new Promise((resolve) => {
    let body;
    try {
      body = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch {
      resolve();
      return;
    }

    let settled = false;
    let timer = null;
    let request = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    try {
      request = http.request(
        {
          hostname: config.hostname,
          port: config.port,
          path: config.path,
          method: 'POST',
          agent: false,
          timeout: HTTP_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            [TOKEN_HEADER]: config.token,
            connection: 'close',
          },
        },
        (response) => {
          response.on('error', finish);
          response.on('end', finish);
          response.on('close', finish);
          response.resume();
        }
      );
    } catch {
      finish();
      return;
    }

    request.on('error', finish);
    request.on('timeout', () => {
      finish();
      try {
        request.destroy();
      } catch {
        // 忽略：请求已失效。
      }
    });

    timer = setTimeout(() => {
      finish();
      try {
        request.destroy();
      } catch {
        // 忽略：请求已失效。
      }
    }, HTTP_TIMEOUT_MS);

    try {
      request.end(body);
    } catch {
      finish();
      try {
        request.destroy();
      } catch {
        // 忽略：请求已失效。
      }
    }
  });
}

/** hook 模式必须输出一行空对象，且不包含任何控制/审批字段。 */
function writeHookNoop() {
  if (hookStdoutWritten) return Promise.resolve();
  hookStdoutWritten = true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      process.stdout.write('{}\n', finish);
    } catch {
      finish();
    }
    // stdout 管道异常时也不要卡住 CLI。
    setTimeout(finish, 250).unref();
  });
}

async function runHook() {
  const text = await readStdin();
  if (text !== null) {
    const value = parseJsonObject(text);
    if (value !== null) {
      const payload = buildHookPayload(value);
      if (payload !== null) {
        const config = readConfig();
        if (config !== null) await postPayload(config, payload);
      }
    }
  }
  await writeHookNoop();
}

async function runNotify() {
  const args = process.argv;
  if (args.length < 4) return;

  const raw = args[args.length - 1];
  if (typeof raw !== 'string') return;
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) return;

  const value = parseJsonObject(raw);
  if (value === null) return;

  const payload = buildNotifyPayload(value);
  if (payload === null) return;

  const config = readConfig();
  if (config === null) return;

  await postPayload(config, payload);
}

async function main() {
  const mode = process.argv[2];
  if (mode === MODE_HOOK) {
    await runHook();
    return;
  }
  if (mode === MODE_NOTIFY) {
    await runNotify();
  }
}

// 兜底：任何未捕获错误都静默退出 0；hook 模式仍保证输出空对象。
function failClosed() {
  if (process.argv[2] === MODE_HOOK && !hookStdoutWritten) {
    hookStdoutWritten = true;
    try {
      process.stdout.write('{}\n', () => process.exit(0));
    } catch {
      // 忽略：直接退出。
    }
    setTimeout(() => process.exit(0), 250).unref();
    return;
  }
  process.exit(0);
}

process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);

main()
  .catch(() => {})
  .then(() => {
    process.exit(0);
  });
