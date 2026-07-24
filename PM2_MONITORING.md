# 📊 Monitoring WordLight with PM2.io

WordLight can show you a live, web-based dashboard of how your server is
doing — no technical terminal skills required to *view* it, once it's set
up. This guide explains how to turn it on and what everything on the
screen actually means.

This is completely optional. WordLight works fine without it. But if
you've ever wondered "is the Pi okay right now?" during a show without
wanting to plug in a keyboard and SSH into it, this is for you.

---

## What is PM2.io?

WordLight's server runs under a program called **pm2**, which keeps it
running and restarts it automatically if something ever goes wrong.
**PM2.io** (also called **PM2 Plus**) is a free companion website made by
the same company. Once connected, it shows you a live dashboard — from
any phone, tablet, or computer with a web browser — of what your server
is doing right now.

Think of it like a car's dashboard: you don't need to understand how the
engine works to glance at the speedometer and fuel gauge. This is the
same idea, for your caption server.

**What it lets you do, in practice:**
- Check from the lobby (or from home) whether the server is running
- See how many audience members are currently connected
- See what line of the script is currently showing
- Get a rough sense of whether the Pi is working hard or coasting
- Notice early if something looks unusual, before it becomes a problem
  during a show

---

## Setting it up

This only needs to be done **once** per server (so once for your real Pi,
and separately if you also monitor a test server).

### 1. Create a free account

Open a terminal on the Pi (the same one you use to run `pm2` commands)
and type:

```bash
pm2 plus
```

This opens a short guided setup. It will ask you to create a free
account (or log in if you already have one) and will walk you through
connecting this server.

**If that command doesn't work** or you'd rather do it through a web
browser first: go to [https://app.pm2.io](https://app.pm2.io), create a
free account, and look for an option like **"Add a server"** or
**"Connect a server"**. It will show you a command that looks like this:

```bash
pm2 link <a long string of letters> <another long string of letters> WordLight-Server
```

Copy that **exact** command — the two long strings are unique to your
account — and paste it into the Pi's terminal.

### 2. Confirm it connected

Back in your web browser at [app.pm2.io](https://app.pm2.io), you should
see a new server appear (matching whatever name you gave it) within a
few seconds, with your WordLight processes listed underneath it.

That's it — no further setup needed. The dashboard updates live from
that point on, and will keep working every time the Pi reboots, as long
as pm2 itself is still set to start automatically (which was set up
earlier when WordLight was first installed).

### 3. Bookmark it

[app.pm2.io](https://app.pm2.io) works from any device — save it to your
phone's home screen for a quick way to check on the server during a
show without needing a laptop.

---

## Reading the dashboard

When you open a server on PM2.io, you'll see two kinds of information:
metrics that come **built in** automatically, and metrics **specific to
WordLight** that were added on purpose to show useful theater-related
information. Both are explained below.

### Built-in metrics (every pm2 app shows these)

| What you see | What it means in plain terms |
|---|---|
| **CPU** | How hard the Pi's processor is working right now, as a percentage. Occasional spikes are completely normal — worth a second look only if it stays high (over ~80%) for a long stretch with nothing happening. |
| **Memory** | How much of the Pi's RAM this program is currently using. A number that climbs steadily over hours *without ever leveling off* is worth mentioning to whoever maintains the code — a healthy pattern is climbing a bit, then holding roughly steady. |
| **Event Loop Latency** | A Node.js-specific health signal — roughly, "how quickly is the program getting around to new work?" Low numbers (a few milliseconds) are healthy. Rising numbers can mean the server is starting to get overloaded. |
| **Event Loop Latency p95** | Same idea as above, but showing the *worst* moments rather than the average — useful for catching occasional slow patches that a plain average might hide. |
| **HTTP Mean Latency** | On average, how many milliseconds it takes the server to respond to a web page request. Lower is better; a few milliseconds to a couple hundred is typical. |
| **HTTP P95 Latency** | Same as above, but the slowest 5% of requests — a better indicator of what an unlucky user might actually experience. |
| **Heap Size / Used Heap Size** | Technical details about how Node.js manages its own memory internally. Not something you need to act on day-to-day — mainly useful for diagnosing a suspected memory issue. |
| **Heap Usage** | What percentage of that internal memory space is currently full. This naturally rises and falls in a repeating sawtooth pattern as the program cleans up after itself — that's expected, not a problem. |
| **Active handles / Active requests** | Roughly, "how many things is the server currently juggling" — open connections, timers, and similar. Not usually something you need to watch directly. |
| **Restarts** | How many times pm2 has had to restart this program since it was last started fresh. Should normally read 0 — a climbing number means something is crashing and worth investigating. |

### WordLight's own metrics (added specifically for this project)

These were custom-built for WordLight and won't appear on other pm2
projects — they show up under **"Metrics"** alongside the built-in ones.

| What you see | What it means |
|---|---|
| **Connected Readers** | How many audience members have the caption reader page open on their phone **right now**, live. Backstage viewers are *not* included in this count. |
| **Connected Controllers** | How many browser tabs currently have the Controller page open — normally 1, sometimes 2 if a backup operator also has it open. |
| **Current Line** | Which line of the script is currently showing, as "line number / total lines" — e.g. `42 / 180`. |
| **Current Caption** | The actual caption text currently on screen, so you can glance and confirm the right thing is showing. |
| **Intermission** | Shows `ON` when the "Please Stand By" screen is active for the audience, `off` otherwise. |
| **OSC Armed** | Shows `ARMED` if a lighting/sound board has taken control of caption advancing via OSC, `off` otherwise. |
| **Unique Readers (Session)** | How many distinct devices have connected since the server was last started — resets only when the server restarts, not between shows. |
| **Total Sessions** | Total number of connect events since the server was last started, including people reconnecting (e.g. after locking their phone). Naturally higher than Unique Readers. |
| **CPU Temperature (°C)** | How hot the Raspberry Pi's processor is running. See the temperature guide below. |
| **WiFi IP / Ethernet IP** | The Pi's current network addresses — handy for troubleshooting connectivity without needing to plug a screen into the Pi directly. |
| **WiFi Signal (dBm)** | How strong the Pi's own WiFi connection is. See the signal strength guide below. |
| **WiFi Link Quality (%)** | The same information as WiFi Signal, expressed as a simple percentage instead — easier to eyeball at a glance. |

---

## Quick reference: is this number okay?

These are general rules of thumb, not hard limits — a single reading
outside these ranges for a moment isn't cause for alarm. What matters
more is whether a number is **stable** or **steadily getting worse**.

### CPU Temperature

| Reading | What it means |
|---|---|
| Under 60°C | Comfortable, plenty of headroom |
| 60–70°C | Normal for a Pi actively serving a show |
| 70–80°C | Working hard, but still within normal range |
| Above 80°C | The Pi may start slowing itself down to cool off — worth checking ventilation/airflow around it |

### WiFi Signal Strength

WiFi signal is measured in **dBm**, a negative number where **closer to
zero is better** (this trips a lot of people up at first — "-50" is a
*stronger* signal than "-80").

| Reading | Link Quality (%) | What it means |
|---|---|---|
| -30 to -50 dBm | ~85–100% | Excellent — right next to the router |
| -50 to -60 dBm | ~65–85% | Good — reliable for normal use |
| -60 to -70 dBm | ~45–65% | Fair — usually fine, but can be worth improving if there's a choice |
| Below -70 dBm | Under ~45% | Weak — consider moving the Pi closer to the router, or switching to a wired Ethernet connection if one's available |

---

## Frequently asked questions

**Does this cost anything?**
PM2.io has a free tier that's plenty for a single small theater's setup.
If you ever outgrow it, PM2 will make that clear in the dashboard itself
rather than silently charging you.

**Do I need to keep a terminal window open for this to work?**
No. Once linked, the connection runs in the background automatically
every time the server starts — you never need to run `pm2 plus` or
`pm2 link` again unless you're setting up an additional server.

**What if I reinstall the Pi's SD card, or set up a new Pi?**
You'll need to run through the setup steps once more on the new
installation — the linking is tied to that specific pm2 installation.

**Can more than one person view this?**
Yes — anyone with the account login (or added as a team member on the
account) can view the same live dashboard from their own device at the
same time.

**What if I want to stop monitoring a specific process?**
Run `pm2 unmonitor <name>` on the Pi (e.g. `pm2 unmonitor oled-display`)
if you ever want to hide one specific program from the dashboard while
keeping the rest connected.

**I'm not sure if something I'm seeing is a problem.**
That's completely fine — if a number looks unusual and you're not sure
what to make of it, a screenshot of the dashboard is genuinely the most
useful thing you can share when asking for help troubleshooting.
