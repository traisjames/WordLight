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
// Logs in /tmp avoid that wear when /tmp is in memory (a "tmpfs"), which
// it is by default on Raspberry Pi OS Trixie (Debian 13), up to half the
// RAM. On Bookworm and older, and on Ubuntu, /tmp is on the SD card or
// disk unless set up otherwise: README.md ("Reducing SD Card Wear") has
// the /etc/fstab line, and `findmnt /tmp` shows which you have.
//
// Since a log in memory uses RAM until the next reboot, setup.sh also adds
// a log rotation rule (/etc/logrotate.d/wordlight) that keeps each of
// these logs under 10 MB. If you rename a log here, change it there too.
//
// Trade-off worth knowing: once /tmp is tmpfs, logs are cleared on every
// reboot. Fine for this use case (logs are for live debugging, not
// long-term history) — but if something crashes right before a reboot,
// that crash's logs won't survive to be inspected afterward.

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
