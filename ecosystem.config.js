// ecosystem.config.js
// ====================
// Defines both WordLight processes (the server and the OLED display
// script) in one place, so a single command starts everything correctly
// and consistently:
//
//   pm2 start ecosystem.config.js
//   pm2 save
//
// Replaces starting each process individually with separate `pm2 start`
// commands — same end result, but the configuration lives in one file
// instead of being remembered as a sequence of CLI flags.
//
// ── Why logs point at /tmp ──────────────────────────────────────────────
//
// SD cards have a limited number of write cycles before they wear out —
// a real concern for a Pi that might run for many show nights in a row.
// Redirecting logs to /tmp avoids that wear IF /tmp is actually RAM-backed
// (a "tmpfs" filesystem) — which, on Raspberry Pi OS, is NOT the case by
// default. Unlike many other Linux distributions, Raspbian keeps /tmp on
// the SD card unless you explicitly configure otherwise.
//
// To make /tmp RAM-backed, add this line to /etc/fstab (then reboot, or
// run `sudo mount -a`):
//
//   tmpfs /tmp tmpfs defaults,noatime,size=100m 0 0
//
// The size=100m caps how much RAM this can ever use — tmpfs only actually
// uses RAM for the files currently in it, so this is just a safety
// ceiling, not something reserved up front.
//
// Trade-off worth knowing: once /tmp is tmpfs, logs are cleared on every
// reboot. Fine for this use case (logs are for live debugging, not
// long-term history) — but if something crashes right before a reboot,
// that crash's logs won't survive to be inspected afterward.
//
// If you'd rather NOT set up tmpfs, this file still works exactly the
// same — logs just live on the SD card at /tmp like any other file would,
// and you get log ROTATION (see README.md) without the RAM-backed part.

module.exports = {
  apps: [
    {
      name:        'wordlight',
      script:      'server.js',
      out_file:    '/tmp/wordlight-out.log',
      error_file:  '/tmp/wordlight-error.log',
      time:        true,   // prefix each log line with a timestamp
    },
    {
      name:        'oled-display',
      script:      'oled_display.py',
      interpreter: 'python3',
      out_file:    '/tmp/oled-display-out.log',
      error_file:  '/tmp/oled-display-error.log',
      time:        true,
    },
  ],
};
