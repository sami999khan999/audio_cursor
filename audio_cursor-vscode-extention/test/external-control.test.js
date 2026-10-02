const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const Module = require('module');

// Redirect `require('vscode')` to the stub before loading anything.
const stubPath = require.resolve('./vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return originalResolve.call(this, request, ...rest);
};

// Sockets and window descriptions go to a scratch folder, never the real runtime dir.
process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-cursor-test-'));

const { ExternalControl, controlDir } = require(path.join(__dirname, '..', 'src', 'externalControl.js'));

function infoPath() {
  return path.join(controlDir(), `${process.pid}.json`);
}

async function listening() {
  for (let i = 0; i < 100 && !fs.existsSync(infoPath()); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  return JSON.parse(fs.readFileSync(infoPath(), 'utf8'));
}

function send(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(payload));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', d => { data += d; });
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('error', reject);
  });
}

test('a window describes itself and takes requests over its socket', { skip: process.platform === 'win32' }, async () => {
  const control = new ExternalControl();
  const requests = [];
  control.onRequest(r => { requests.push(r); });
  try {
    const info = await listening();
    assert.strictEqual(info.pid, process.pid);
    assert.ok(fs.existsSync(info.socket));

    assert.deepStrictEqual(await send(info.socket, '{"action":"read","text":"hello there"}\n'), { ok: true });
    assert.deepStrictEqual(await send(info.socket, '{"action":"toggle"}\n'), { ok: true });
    assert.deepStrictEqual(requests.map(r => r.action), ['read', 'toggle']);
    assert.strictEqual(requests[0].text, 'hello there');

    // Malformed or empty requests are refused and never reach the player.
    assert.strictEqual((await send(info.socket, 'not json\n')).ok, false);
    assert.strictEqual((await send(info.socket, '{"action":"read","text":"  "}\n')).ok, false);
    assert.strictEqual((await send(info.socket, '{"action":"format-disk"}\n')).ok, false);
    assert.strictEqual(requests.length, 2);
  } finally {
    control.dispose();
  }
  assert.ok(!fs.existsSync(infoPath()), 'dispose removes the description');
});
