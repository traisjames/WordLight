# WordLight Load Test

A standalone stress-test tool for the WordLight caption server. Opens many
concurrent reader/backstage socket.io connections and reports live stats,
so you can watch the server's CPU and memory usage under realistic load —
useful for catching memory leaks or performance issues before a real show.

This tool is **completely separate** from the WordLight server itself. It
lives in its own folder with its own `package.json` so `socket.io-client`
never becomes a dependency of your production server.

---

## Setup

Run this on your **Mac** (or any machine other than the Pi — see
"Where to run this" below):

```bash
cd load-test
npm install
```

---

## Basic usage (safe — read-only)

This mode only opens connections and listens. It never sends anything to
the server, so it's safe to run against a live server at any time.

```bash
node load_test.js --host 192.168.1.42 --port 3000 --count 100
```

Replace `192.168.1.42` with your Pi's actual IP address, and `3000` with
whatever port your server is running on (see `.env`).

Press `Ctrl+C` at any time to stop and see a summary.

---

## Full stress test (with simulated navigation)

⚠️ **This mode overwrites the currently loaded script on the server.**
Only use this against a dedicated test/staging Pi, or when you're certain
nothing important is loaded.

This additionally connects as a fake controller, loads a small demo
script, and advances the current line every couple of seconds — which
triggers the server to broadcast a `state-update` to every connected
reader. This is the scenario most likely to reveal real performance
issues, since it's what actually happens during a live show.

```bash
node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
  --simulate-nav --confirm-overwrite-script
```

Both flags are required together — this is intentional, so the script
can never overwrite a live show's script by accident.

---

## Connection churn (simulates flaky real-world connections)

Every mode above holds connections perfectly steady for the whole test.
Real audience members don't — phones lock, apps get backgrounded, WiFi
drops briefly, and the device reconnects a moment later. Churn simulates
exactly that:

```bash
node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
  --simulate-nav --confirm-overwrite-script \
  --churn-percent 5 --churn-interval-ms 5000
```

This disconnects 5% of currently-connected clients every 5 seconds, then
reconnects each one after a short randomised delay. Each client keeps its
**original reader ID** across the cycle — just like a real phone, whose ID
is stored in localStorage and survives a reconnect — so this specifically
tests the "known reader reconnecting" path on the server, not just
first-time connections. It's a good complement to a high connection-count
test: churn is more about realistic *behavior* over time than raw scale,
and can reveal issues (like listener or resource cleanup problems) that a
test with only steady, never-disconnecting connections wouldn't surface.

---

## Ungraceful disconnects (simulates dropped connections, not clean closes)

Every disconnect above — churn included — is clean: the client sends an
explicit close signal the server processes immediately. Real disruption
often isn't clean: a phone losing signal, a cable pulling, or a resource-
exhaustion attempt that opens connections and never properly closes them
all just look like the connection went silent. The server can only detect
that via its own connection error handling or (worst case) its heartbeat
timeout — not instantly.

```bash
node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
  --simulate-nav --confirm-overwrite-script \
  --churn-percent 5 --churn-interval-ms 5000 --ungraceful-percent 30
```

This makes 30% of each churn cycle's disconnects **ungraceful** — the
underlying connection is forcibly severed rather than closed cleanly.
Requires `--churn-percent` to be set, since ungraceful kills only happen
as part of a churn cycle.

The CSV output tracks graceful and ungraceful reconnects in **separate
columns** (`reconnect_*` vs `ungraceful_reconnect_*`), so you can compare
how much slower — if at all — recovery is from an unclean disconnect, and
whether the server's connection counts (check the `Connected Readers`
pm2.io metric, or `/logging`) correctly settle back down once it notices,
with nothing left dangling.

> **Worth knowing:** on a healthy local network, an ungraceful kill is
> often still detected by the server within a few seconds, since the OS
> typically delivers a TCP reset even for an abrupt local close. The full
> worst-case ~45-second detection window (socket.io's heartbeat timeout)
> really only applies to genuine packet loss — a device that vanishes
> with literally no signal reaching the server — which isn't practical to
> simulate reliably from application-level JS. What this mode reliably
> tests either way: whether the server handles an unclean, non-standard
> disconnect correctly, with the same cleanup as a normal one.

---

## Where to run this

**Run it from your Mac, not the Pi.** The load generator itself uses CPU
and memory to maintain 100 socket connections — if you run it on the same
Pi as the server, you're measuring the combined load of the server *and*
the test tool competing for the same cores, which makes the numbers
harder to interpret. Running from a separate machine cleanly isolates
what you're trying to measure: the server's own resource usage.

**If running from a VM on a MacBook, prevent the Mac from sleeping for the
duration of the test.** Display sleep can suspend a background VM
entirely, instantly dropping every connection it's holding open — this
has happened during testing and looked identical to a server-side crash
until cross-referenced with server logs. Wrap the command in `caffeinate`
to prevent this automatically for exactly as long as the test runs:

```bash
caffeinate -d node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
  --simulate-nav --confirm-overwrite-script \
  --churn-percent 5 --churn-interval-ms 5000 \
  --duration 1800 --status-interval 30
```

`-d` prevents display sleep only while that command is running, and stops
automatically the moment `load_test.js` exits — no need to remember to
revert a system setting afterward. If this does happen despite the
precaution, it'll now show up clearly as a spike in "unexpected
disconnects" in the CSV output (see below) rather than needing to be
diagnosed after the fact.

---

## Monitoring the Pi while the test runs

Open a separate terminal connected to the Pi and run one of:

```bash
# Live CPU/memory graph, pm2-aware
pm2 monit

# Precise per-second CPU/memory for just the server process
pidstat -p $(pm2 pid caption-server) 1

# Precise per-second memory (RSS) — the more direct signal for a leak
pidstat -p $(pm2 pid caption-server) -r -u 1

# General system view
htop
```

Let the test run for at least a few minutes — memory leaks often don't
show up in the first 30 seconds, but reveal themselves as slow, steady
growth in RSS memory over several minutes of sustained connections.

---

## All options

| Flag | Default | Description |
|------|---------|-------------|
| `--host <ip>` | `127.0.0.1` | Server IP address |
| `--port <n>` | `3000` | Server port |
| `--count <n>` | `100` | Number of fake reader/backstage clients |
| `--ramp-ms <n>` | `50` | Delay between opening each connection |
| `--backstage-ratio <0-1>` | `0.2` | Fraction of clients identifying as backstage |
| `--duration <seconds>` | `0` (run until Ctrl+C) | Auto-stop after this many seconds |
| `--status-interval <seconds>` | `5` | How often to print stats |
| `--simulate-nav` | off | Also simulate a controller advancing lines |
| `--confirm-overwrite-script` | off | Required alongside `--simulate-nav` |
| `--nav-interval-ms <n>` | `2000` | Time between simulated line advances |
| `--demo-lines <n>` | `50` | Number of fake script lines to load |
| `--churn-percent <0-100>` | `0` (off) | % of clients to disconnect+reconnect per cycle |
| `--churn-interval-ms <n>` | `5000` | Time between churn cycles |
| `--churn-reconnect-ms <n>` | `500` | Base delay before a churned client reconnects |
| `--churn-reconnect-jitter-ms <n>` | `2500` | Random extra delay added to the above |
| `--ungraceful-percent <0-100>` | `0` (off) | % of each churn cycle killed abruptly, no clean close |
| `--csv-file <path>` | `load_test_stats.csv` | Path for the CSV stats log |
| `--verbose` | off | Log every individual connect/disconnect/event |

---

## CSV output and detecting unexpected disconnects

Every run writes a CSV file (`load_test_stats.csv` by default, one row per
`--status-interval`) with columns for connection counts, churn events,
reconnect latency, and this script's own memory usage — each row stamped
with a wall-clock timestamp. This is the most reliable way to analyze a
run afterward: load it into a spreadsheet, or plot RSS/churn/reconnect
trends over time, without parsing free-text console output.

The console output and CSV both also track **unexpected disconnects** —
disconnects this script did *not* itself trigger (not a deliberate churn
cycle, not the final shutdown). A network drop, a server-side issue, or
even the host machine's display going to sleep and suspending a VM will
show up here as a spike, with an exact wall-clock timestamp in the CSV —
so if something goes wrong mid-test, it's visible directly in this
script's own log rather than needing to be reconstructed afterward by
cross-referencing separate server-side captures.

```bash
tail -f load_test_stats.csv   # watch it update live during a run
```

---

## Example: 30-minute soak test

A longer run is generally more useful for catching memory leaks than a
quick burst. This combines navigation broadcasts with realistic churn:

```bash
node load_test.js --host 192.168.1.42 --port 3000 --count 100 \
  --simulate-nav --confirm-overwrite-script \
  --churn-percent 5 --churn-interval-ms 5000 \
  --duration 1800 --status-interval 30
```

Watch the `pidstat -r` RSS/memory column on the Pi throughout. A healthy
server should plateau after the initial connections settle in — memory
that keeps climbing steadily for the full 30 minutes without leveling
off is worth investigating further.
