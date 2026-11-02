/**
 * server-probe.js — preload for the throwaway server that test-readers.js starts
 * ================================================================================
 *
 * test-readers.js runs the real server.js as
 *
 *   node --expose-gc --require ./server-probe.js ../server.js
 *
 * Nothing in server.js is changed or copied. This file does three things from
 * outside it:
 *
 *   1. Makes the server listen on the loopback address only. server.js binds
 *      0.0.0.0, which would put a test server on the venue network for as long
 *      as the test runs.
 *
 *   2. When WL_TEST_READER_CAP is set, lowers MAX_UNIQUE_READER_IDS in the
 *      source as it is loaded, so the "no more IDs are remembered" limit can be
 *      reached with a few readers instead of 500,000. If the constant can't be
 *      found the server stops with exit code 3, so renaming it can't quietly
 *      turn that test into a pass.
 *
 *   3. Answers { wlProbe: 'heap' } from the test with the size of the live heap
 *      after a full garbage collection: what the server is really holding on
 *      to, not what the operating system has handed it (that figure also counts
 *      open sockets, and memory V8 keeps for later).
 *
 * It exits when the test does, so a crashed test can't leave a server behind.
 */

const fs     = require('fs');
const net    = require('net');
const dgram  = require('dgram');
const Module = require('module');

// ── 1. Loopback only ──────────────────────────────────────────────────────
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
const bind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return bind.apply(this, args);
};

// ── 2. A lower limit on remembered reader IDs ─────────────────────────────
const cap = parseInt(process.env.WL_TEST_READER_CAP, 10);
if (cap > 0) {
  const SERVER  = fs.realpathSync(process.argv[1]);
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename, ...rest) {
    if (filename === SERVER) {
      const declaration = /(const\s+MAX_UNIQUE_READER_IDS\s*=\s*)[\d_]+/;
      if (!declaration.test(content)) {
        console.error('server-probe: MAX_UNIQUE_READER_IDS is not declared in ' + filename);
        process.exit(3);
      }
      content = content.replace(declaration, (all, head) => head + cap);
    }
    return compile.call(this, content, filename, ...rest);
  };
}

// ── 3. The live heap, on request ──────────────────────────────────────────
if (process.send) {
  process.on('message', (message) => {
    if (message && message.wlProbe === 'heap') {
      global.gc();
      process.send({ wlProbe: 'heap', heapUsed: process.memoryUsage().heapUsed });
    }
  });
  process.on('disconnect', () => process.exit(0));
}
