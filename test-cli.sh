#!/bin/bash
# BAREclaw CLI validation tests
# Confirms claude -p works as expected for the daemon pattern

set -euo pipefail
export CLAUDECODE=

PASS=0
FAIL=0
RESULTS=""

report() {
  local test_name="$1" status="$2" detail="$3"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    RESULTS="$RESULTS\n  PASS  $test_name — $detail"
  else
    FAIL=$((FAIL + 1))
    RESULTS="$RESULTS\n  FAIL  $test_name — $detail"
  fi
  echo "[$status] $test_name — $detail"
}

echo "=== BAREclaw CLI Validation ==="
echo ""

# Test 1: Basic headless prompt
echo "--- Test 1: Basic headless prompt ---"
START=$(python3 -c 'import time; print(int(time.time()*1000))')
OUTPUT=$(claude -p "respond with exactly: BARECLAW_TEST_OK" --output-format json 2>/dev/null) || true
END=$(python3 -c 'import time; print(int(time.time()*1000))')
LATENCY=$((END - START))

if echo "$OUTPUT" | jq -e '.result' >/dev/null 2>&1; then
  RESPONSE=$(echo "$OUTPUT" | jq -r '.result')
  report "Basic prompt" "PASS" "JSON parsed. Latency: ${LATENCY}ms. Response: ${RESPONSE:0:80}"
else
  report "Basic prompt" "FAIL" "Could not parse JSON output"
  echo "$OUTPUT" | head -5
fi

echo ""

# Test 2: Session resume
echo "--- Test 2: Session resume ---"
OUTPUT1=$(claude -p "remember this secret code: UMBRELLA_FALCON_9" --output-format json 2>/dev/null) || true

if echo "$OUTPUT1" | jq -e '.session_id' >/dev/null 2>&1; then
  SESSION_ID=$(echo "$OUTPUT1" | jq -r '.session_id')
  echo "Session ID: $SESSION_ID"

  OUTPUT2=$(claude -p "what was the secret code I asked you to remember?" --resume "$SESSION_ID" --output-format json 2>/dev/null) || true

  if echo "$OUTPUT2" | jq -e '.result' >/dev/null 2>&1; then
    RESPONSE2=$(echo "$OUTPUT2" | jq -r '.result')
    if echo "$RESPONSE2" | grep -qi "UMBRELLA_FALCON_9"; then
      report "Session resume" "PASS" "Context preserved across calls"
    else
      report "Session resume" "FAIL" "Response didn't contain the secret code. Got: ${RESPONSE2:0:120}"
    fi
  else
    report "Session resume" "FAIL" "Second call didn't return valid JSON"
  fi
else
  report "Session resume" "FAIL" "First call didn't return session_id"
fi

echo ""

# Test 3: Allowed tools
echo "--- Test 3: Allowed tools ---"
cd ~/dev/tools/bareclaw
OUTPUT3=$(claude -p "use the Read tool to read README.md and tell me the first line" --allowedTools "Read" --output-format json 2>/dev/null) || true

if echo "$OUTPUT3" | jq -e '.result' >/dev/null 2>&1; then
  RESPONSE3=$(echo "$OUTPUT3" | jq -r '.result')
  if echo "$RESPONSE3" | grep -qi "BAREclaw"; then
    report "Allowed tools" "PASS" "Read tool executed, found BAREclaw in response"
  else
    report "Allowed tools" "FAIL" "Response didn't reference file contents. Got: ${RESPONSE3:0:120}"
  fi
else
  report "Allowed tools" "FAIL" "Could not parse JSON output"
fi

echo ""

# Test 4: Max turns
echo "--- Test 4: Max turns ---"
OUTPUT4=$(claude -p "use multiple tool calls to read every file in this directory one by one" --max-turns 2 --output-format json 2>/dev/null) || true

if echo "$OUTPUT4" | jq -e '.result' >/dev/null 2>&1; then
  report "Max turns" "PASS" "Completed within turn limit"
else
  report "Max turns" "FAIL" "Unexpected output"
fi

echo ""

# Test 5: Concurrent requests
echo "--- Test 5: Concurrent requests ---"
OUTA=$(mktemp)
OUTB=$(mktemp)

claude -p "respond with exactly: SESSION_A_OK" --output-format json >"$OUTA" 2>/dev/null &
PID_A=$!
claude -p "respond with exactly: SESSION_B_OK" --output-format json >"$OUTB" 2>/dev/null &
PID_B=$!

wait $PID_A || true
wait $PID_B || true

A_OK=false
B_OK=false
if jq -e '.result' "$OUTA" >/dev/null 2>&1; then A_OK=true; fi
if jq -e '.result' "$OUTB" >/dev/null 2>&1; then B_OK=true; fi

if $A_OK && $B_OK; then
  report "Concurrent requests" "PASS" "Both sessions returned valid JSON independently"
else
  report "Concurrent requests" "FAIL" "A=$A_OK B=$B_OK"
fi

rm -f "$OUTA" "$OUTB"

echo ""

# Test 6: Error handling (invalid session ID)
echo "--- Test 6: Error handling ---"
OUTPUT6=$(claude -p "hello" --resume "fake-session-id-00000" --output-format json 2>&1) || true

if [ -n "$OUTPUT6" ]; then
  report "Error handling" "PASS" "Got output on invalid session: ${OUTPUT6:0:120}"
else
  report "Error handling" "FAIL" "No output at all"
fi

echo ""

# Test 7: Node.js bridge script
echo "--- Test 7: Node.js bridge ---"
cat > /tmp/bareclaw-bridge-test.js << 'SCRIPT'
const { execSync } = require('child_process');
const prompt = "respond with exactly: NODE_BRIDGE_OK";
try {
  const result = execSync(
    `claude -p "${prompt}" --output-format json`,
    { encoding: 'utf-8', env: { ...process.env, CLAUDECODE: '' }, timeout: 60000 }
  );
  const parsed = JSON.parse(result);
  console.log(JSON.stringify({ success: true, result: parsed.result, session_id: parsed.session_id }));
} catch (e) {
  console.log(JSON.stringify({ success: false, error: e.message.substring(0, 200) }));
}
SCRIPT

NODE_OUT=$(node /tmp/bareclaw-bridge-test.js 2>/dev/null) || true

if echo "$NODE_OUT" | jq -e '.success == true' >/dev/null 2>&1; then
  NODE_RESULT=$(echo "$NODE_OUT" | jq -r '.result')
  report "Node.js bridge" "PASS" "execSync works. Response: ${NODE_RESULT:0:80}"
else
  report "Node.js bridge" "FAIL" "Node script failed. Output: ${NODE_OUT:0:120}"
fi

echo ""
echo "=== Results ==="
echo -e "$RESULTS"
echo ""
echo "  $PASS passed, $FAIL failed"
