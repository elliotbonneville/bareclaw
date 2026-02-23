#!/usr/bin/env node
// BAREclaw stream-json latency test
// Spawns one persistent process, sends 3 messages, measures cold vs warm latency

const { spawn } = require('child_process');
const readline = require('readline');

const MESSAGES = [
  "respond with exactly: WARM_TEST_1",
  "respond with exactly: WARM_TEST_2",
  "what was the first thing I said to you?",
];

async function run() {
  console.log("=== BAREclaw Stream-JSON Latency Test ===\n");

  const env = { ...process.env, CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const spawnStart = Date.now();

  const proc = spawn('claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'
  ], {
    env,
    cwd: process.env.HOME + '/dev/tools/bareclaw',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  let resolveEvent = null;

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (resolveEvent) resolveEvent(event);
    } catch (e) { /* skip non-JSON */ }
  });

  function waitForEvent(predicate) {
    return new Promise((resolve) => {
      const origResolve = resolveEvent;
      resolveEvent = (event) => {
        if (predicate(event)) {
          resolve(event);
        }
        // keep listening -- restore for next event
        resolveEvent = (e) => {
          if (predicate(e)) resolve(e);
        };
      };
    });
  }

  function sendAndWaitForResult(text) {
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.type === 'result') {
          resolveEvent = null;
          resolve(event);
        } else {
          resolveEvent = handler;
        }
      };
      resolveEvent = handler;

      const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      proc.stdin.write(msg + '\n');
    });
  }

  // Send messages sequentially
  for (let i = 0; i < MESSAGES.length; i++) {
    const label = i === 0 ? '(cold)' : '(warm)';
    console.log(`--- Message ${i + 1} ${label}: "${MESSAGES[i]}" ---`);
    const start = Date.now();
    const result = await sendAndWaitForResult(MESSAGES[i]);
    const elapsed = Date.now() - start;
    const apiMs = result.duration_api_ms || '?';

    console.log(`  Total: ${elapsed}ms | API: ${apiMs}ms | Response: ${(result.result || '').substring(0, 120)}`);
    console.log('');
  }

  proc.stdin.end();
  proc.kill();

  console.log("=== Done ===");
  if (stderr.trim()) {
    const important = stderr.split('\n').filter(l => !l.includes('zoxide')).join('\n').trim();
    if (important) console.log("\nStderr:", important.substring(0, 300));
  }
}

run().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
