#!/bin/bash
#
# monitor.sh — WordLight server-side load test monitor
# ========================================================
# Runs ON the Raspberry Pi (or wherever the WordLight server itself runs),
# alongside a load_test.js run happening on a separate machine. Captures
# both CPU/memory (pidstat) and open file descriptor count (lsof) into a
# matched pair of timestamped log files, started and stopped together with
# a single command instead of two separate manually-managed terminals.
#
# ── Usage ─────────────────────────────────────────────────────────────────
#   chmod +x monitor.sh      (once, after copying this file to the Pi)
#   ./monitor.sh [label] [pm2-app-name]
#
#   label          Optional tag included in the output filenames, e.g.
#                  "testB". Defaults to the current date/time if omitted,
#                  so you never accidentally overwrite a previous run.
#   pm2-app-name   Name of the pm2 process to monitor. Defaults to
#                  "caption-server" — pass your actual pm2 app name if
#                  it's different (e.g. "wordlight").
#
# ── Examples ─────────────────────────────────────────────────────────────
#   ./monitor.sh                        # auto-named, watches "caption-server"
#   ./monitor.sh testB                  # files named monitor_testB_*
#   ./monitor.sh testB wordlight        # watches the "wordlight" pm2 app
#
# ── Output ───────────────────────────────────────────────────────────────
#   monitor_<label>_pidstat.txt   CPU (%usr/%system/%CPU) and memory
#                                 (RSS/VSZ), one combined sample per second
#   monitor_<label>_lsof.txt      Open file descriptor count, one sample
#                                 every 5 seconds, each line timestamped
#
# Both files use the Pi's own clock for every timestamp, so lines from one
# file can be matched directly against the other by their HH:MM:SS prefix
# without any conversion.
#
# Press Ctrl+C to stop both captures cleanly — whatever was captured up to
# that point is preserved in both files; nothing is lost or corrupted by
# stopping early.

set -u

PM2_APP="${2:-caption-server}"
LABEL="${1:-$(date +%Y%m%d_%H%M%S)}"

PIDSTAT_FILE="monitor_${LABEL}_pidstat.txt"
LSOF_FILE="monitor_${LABEL}_lsof.txt"

# ── Resolve the target PID once, up front ──────────────────────────────────
# Both pidstat and the lsof loop below reuse this SAME pid for the whole
# capture, rather than re-querying pm2 on every lsof iteration. This means
# if pm2 restarts the app mid-capture, monitoring correctly continues
# against the (now-dead) old process rather than silently switching targets
# — a pm2 restart mid-test is itself something you'd want visible in the
# log (fd count would legitimately crash to near-zero), not hidden.
PID=$(pm2 pid "$PM2_APP" 2>/dev/null)
if [ -z "$PID" ] || [ "$PID" = "0" ]; then
  echo "❌ Could not find a running pm2 process named '$PM2_APP'."
  echo "   Check the exact name with: pm2 list"
  exit 1
fi

# Confirm both required tools are actually installed before starting either
# capture — better to fail immediately and clearly than to produce one
# empty/broken output file partway through a long test.
if ! command -v pidstat >/dev/null 2>&1; then
  echo "❌ pidstat not found. Install with: sudo apt-get install -y sysstat"
  exit 1
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "❌ lsof not found. Install with: sudo apt-get install -y lsof"
  exit 1
fi

echo "🔦 WordLight server monitor"
echo "   Watching:   $PM2_APP (PID $PID)"
echo "   pidstat →   $PIDSTAT_FILE"
echo "   lsof    →   $LSOF_FILE"
echo "   Press Ctrl+C to stop both captures."
echo ""

# ── Start pidstat ────────────────────────────────────────────────────────
# -r (memory: minflt/majflt/VSZ/RSS/%MEM) and -u (CPU: %usr/%system/%CPU)
# together, one combined sample per second — same flags used in every
# capture so far, just started here instead of typed by hand each time.
pidstat -p "$PID" -r -u 1 > "$PIDSTAT_FILE" &
PIDSTAT_PID=$!

# ── Start the lsof polling loop ──────────────────────────────────────────
# A plain while-loop appending to a file, NOT `watch` — `watch` redraws a
# live terminal screen using cursor-positioning escape codes, which come
# out as unreadable garbage when redirected straight to a file instead of
# an interactive terminal. This loop writes one clean, parseable line
# every 5 seconds instead.
( while true; do
    echo "$(date +%H:%M:%S) $(lsof -p "$PID" 2>/dev/null | wc -l)"
    sleep 5
  done > "$LSOF_FILE" ) &
LSOF_LOOP_PID=$!

# ── Clean shutdown on Ctrl+C ──────────────────────────────────────────────
# Without this, Ctrl+C would only kill whichever process bash treats as the
# "foreground" job, leaving the other one running invisibly in the
# background — exactly the kind of orphaned process that's easy to forget
# about and only notice much later.
cleanup() {
  echo ""
  echo "🛑 Stopping capture..."
  kill "$PIDSTAT_PID"   2>/dev/null
  kill "$LSOF_LOOP_PID" 2>/dev/null
  # The lsof loop runs inside a subshell; explicitly clean up its children
  # too (the sleep/lsof/date commands) as a backup in case signal
  # forwarding to the subshell alone doesn't fully propagate.
  pkill -P "$LSOF_LOOP_PID" 2>/dev/null
  echo "   Saved: $PIDSTAT_FILE"
  echo "   Saved: $LSOF_FILE"
  exit 0
}
trap cleanup INT TERM

# Block here until Ctrl+C triggers the cleanup trap above. Both background
# captures run indefinitely on their own, so this script's only remaining
# job is to stay alive to catch that signal and shut them down together.
wait
