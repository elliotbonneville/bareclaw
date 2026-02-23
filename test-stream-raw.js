#!/usr/bin/env node
// Raw test: spawn stream-json process, log every line from stdout, send one message after 3s

const { spawn } = require('child_process');

const env = { ...process.env, CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

console.log("Spawning claude -p with stream-json...");
const start = Date.now();

const proc = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
  env,
  cwd: process.env.HOME + '/dev/tools/bareclaw',
  stdio: ['pipe', 'pipe', 'pipe'],
});

proc.stdout.on('data', (chunk) => {
  const elapsed = Date.now() - start;
  const lines = chunk.toString().split('\n').filter(l => l.trim());
  for (const line of lines) {
    console.log(`[stdout +${elapsed}ms] ${line.substring(0, 200)}`);
  }
});

proc.stderr.on('data', (chunk) => {
  const elapsed = Date.now() - start;
  console.log(`[stderr +${elapsed}ms] ${chunk.toString().substring(0, 200)}`);
});

proc.on('exit', (code) => {
  const elapsed = Date.now() - start;
  console.log(`[exit +${elapsed}ms] code=${code}`);
});

// Send a message after 3 seconds
setTimeout(() => {
  const msg = JSON.stringify({ type: "user", message: { role: "user", content: "respond with exactly: HELLO_STREAM" } });
  console.log(`\n[sending +${Date.now() - start}ms] ${msg}`);
  proc.stdin.write(msg + '\n');
}, 3000);

// Kill after 60s
setTimeout(() => {
  console.log("\n[timeout] Killing process after 60s");
  proc.kill();
  process.exit(0);
}, 60000);
