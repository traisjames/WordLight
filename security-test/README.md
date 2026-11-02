# WordLight — caption script security tests

Test material for checking that a malicious or malformed caption script
can't break the server, the controller, or an audience member's browser.

The threat model is simple and realistic: **someone hands the operator a
script file.** Nobody inspects a few hundred lines of dialogue before a
show. If a caption file can run code in every audience phone, that matters.

A second test, `test-readers.js`, covers the other public door: **someone on
the venue network pretends to be an audience phone.** It checks that such a
device can't read the script, fill the server's memory, or forge rows in the
session log. See "Running the reader test" below.

## Where this folder goes

`security-test/` sits at the **project root, beside `public/`** — not inside
it. The harness reads `../public/global.js` to get the real parser, so the
relative position matters:

```
wordlight/
├── public/
│   └── global.js          ← harness reads the real parser from here
├── server.js              ← test-readers.js runs the real one
└── security-test/
    ├── test-parser.js
    ├── test-readers.js
    ├── server-probe.js    ← a small preload that test-readers.js needs
    ├── README.md
    └── scripts/           ← test files live here, not beside test-parser.js
        ├── 01-xss-injection.txt
        ├── 02-unicode-stress.txt
        ├── 03-malformed-tags.txt
        └── 04-control-and-injection.txt
```

The `scripts/` subfolder is the part that's easy to get wrong. If the `.txt`
files end up loose in `security-test/` they're ignored. You don't have to
fix that by hand though — see below.

## Running the automated test

```bash
cd security-test
node test-parser.js
```

Exit code 0 = clean, 1 = findings. It loads the real `parseColorTags()` out
of `public/global.js` at runtime rather than keeping a copy, so it always
tests the code you're actually shipping.

**The test files generate themselves.** If `scripts/` is missing or empty,
the harness writes the corpus before running — so a fresh clone, or a copy
that lost the subfolder in transit, just works. To rebuild the files at any
time without running the tests:

```bash
node test-parser.js --init
```

If you have stray `.txt` files sitting loose in `security-test/`, delete
them and let it regenerate:

```bash
rm -f *.txt && node test-parser.js
```

## Results as of the last run

```
01-xss-injection.txt          clean
02-unicode-stress.txt         clean
03-malformed-tags.txt         clean
04-control-and-injection.txt  clean

1 MB single line                1ms
100k colour tags               19ms
100k close tags                25ms
all angle brackets 500k        27ms

PASS — nothing dangerous survived the parser.
```

**The parser holds up well.** `parseColorTags()` escapes `&`, `<`, `>` and
`"` *before* it substitutes any of its own tags, which is the correct order
and the reason the injection attempts all fail. Every `<script>`,
`onerror=`, `javascript:` and attribute-break attempt comes out as inert
escaped text.

Performance is also fine — a 1 MB single line parses in about 1 ms on a
development machine. Slower on a Pi, but nowhere near a denial of service.

### One cosmetic note

Eight lines produce stray `</span>` tags — from input like `[/][/][/]` with
no colour tag opened. HTML parsers discard a close tag for an element that
isn't open, so these render as nothing. Harmless, not worth fixing.

The reverse case (more opens than closes) *would* matter, because styling
would bleed past the end of the line. The parser's auto-close loop already
prevents it, and the harness checks for it specifically.

## Running the reader test

```bash
cd security-test
node test-readers.js
```

A reader (an audience phone or tablet) needs no login and chooses its own ID in
the address it connects with, so anyone on the venue network can write a
program that pretends to be one. This test starts the real `server.js` on a
throwaway port and checks what such a device can do. It takes about five
seconds. Exit code 0 = all clear, 1 = a check failed, 2 = it couldn't run.

| What | What is checked |
|---|---|
| `GET /api/state` | Refused without a login, and for the editor login; the admin login still gets the full state. A reader is sent the few lines it shows, never the script. (A marker hidden in a line far from the one on show tells whether any of the script came back; nothing of the script is printed) |
| Ordinary IDs | All six kinds of ID, and one with no known prefix, are counted under their own kind; the backstage kinds join the backstage room; renamed devices (spaces, `&`, accents, an emoji, Japanese) are counted and come through the CSV log intact |
| Odd and hostile IDs | No ID, an empty ID and an ID sent twice still get their captions and crash nothing. A line break or other control characters in an ID can't start a row of their own in the CSV log. An ID of 10,000 characters is kept to `MAX_READER_ID_LENGTH` |
| Memory | 1,000 readers with 12,000-character IDs, then 1,000 with normal IDs in very long addresses. Afterwards the server's live memory (measured after a garbage collection, not the size the operating system shows) must have grown by under 4 MB. This is what catches an ID that was cut short but still keeps its long original alive |
| The limit | With `MAX_UNIQUE_READER_IDS` lowered to 5 for this one run: 9 readers connect, 5 are counted, all 9 get their captions, one warning is logged, and Reset starts the count again |

`node test-readers.js --quick` skips the memory test.
`node test-readers.js path/to/server.js` tests another copy, for example an
older version (the rest of the project has to be around it).

**Nothing real is touched.** The server runs in an empty folder (so it finds no
`.env`), with its own ports, a throwaway admin password, no certificates and an
empty Scripts folder, and it listens on the loopback address only. The script
it is given is made up. `server-probe.js` is what makes that possible without
changing `server.js`: a small preload that keeps the server on the loopback
address, lowers the limit for the limit check, and reports the server's memory.

It needs `npm install` to have been run in the project folder (it uses the `ws`
package that comes with socket.io) and Node 22 or newer. It reads the limits and
the kinds of reader out of `server.js`, so it follows them when they change.

### Results as of the last run

```
WordLight 0.9.6   PASS — all 36 checks passed
                  (live memory grew 1.3 MB and 0.3 MB; the limit is 4 MB)

WordLight 0.9.5   FAIL — 9 of 31 checks failed
                  GET /api/state answered anyone with the whole script
                  a line break in an ID added a row to the CSV log
                  a 10,000-character ID was kept whole
                  live memory grew 12.8 MB and 11.9 MB
                  no limit on remembered IDs
```

To make sure the checks can fail, each fix was taken out of a copy of 0.9.6 in
turn, and the test failed on exactly that fix. Without the copy of the ID
string (the cut-down ID still keeps the long original in memory) both memory
checks fail. Without removing control characters the CSV checks fail. With
`/api/state` public again its three checks fail. Without the limit the limit
checks fail.

## What these tests do NOT cover

`test-parser.js` tests the parser in isolation. Two areas need separate
attention:

### 1. Server-side input validation

`server.js`'s `load-script` handler checks only that `lines` is an array:

```js
if (!Array.isArray(data.lines)) return;
```

There's no limit on how many lines, how long each one is, or whether the
elements are even strings. A script file can't exploit this directly —
the controller builds the array with `.split('\n')`, so every element is
always a string — but it's an unvalidated boundary. A caption script of a
million lines would be accepted and held in memory, and broadcast to every
connected controller.

Worth considering: a line-count cap, a per-line length cap, and a
`typeof line === 'string'` filter.

### 2. Socket payload size

`socketIo(server)` runs with default options, which means
`maxHttpBufferSize` is 1 MB. A script larger than that is rejected at the
transport layer and the connection closes — so a big script fails, but it
fails as a mysterious disconnect rather than a clear "that file is too
large" message. Worth setting explicitly and handling.

## Manual browser checks

Some failures only show up visually. Load each file through the Controller
and look at a reader page:

| Check | What you're looking for |
|---|---|
| No alert boxes, ever | Any popup means injection succeeded |
| Browser console clean | `F12` → Console. Errors here mean a crash path |
| Zalgo / combining chars | Text overflowing its line, overlapping other lines |
| RTL override lines | Text that reverses direction and scrambles the layout |
| 5000-character word | Should wrap or clip, never force horizontal scrolling |
| Fit-to-screen | Current line must stay visible and never be cut off |
| Controller stays responsive | Navigation still works after loading a stress file |
| Reader recovers | Load a stress file, then a normal one — display returns to normal |

Also worth watching `pm2 logs wordlight` while loading these — an
unhandled exception server-side would show there.

## Generating the very large files

Not shipped, since they'd be megabytes in git:

```bash
# 50,000-line script
python3 -c "print('\n'.join(f'LINE {i}: caption text here' for i in range(50000)))" > scripts/90-many-lines.txt

# Single 5 MB line
python3 -c "print('MARLIN: ' + 'x' * 5_000_000)" > scripts/91-huge-line.txt
```

Delete them afterwards — leaving them in `scripts/` makes every subsequent
run slow.

## Files

| File | Covers |
|---|---|
| `test-readers.js` | What an audience device can do to the server: read the script, fill its memory, forge log rows (see "Running the reader test") |
| `server-probe.js` | Preload for the throwaway server `test-readers.js` starts: loopback only, a lower limit for one check, a memory report |
| `01-xss-injection.txt` | Script tags, event handlers, attribute breaks, entity encoding, filter-bypass shapes |
| `02-unicode-stress.txt` | RTL override, zero-width chars, Zalgo, emoji/ZWJ, surrogate pairs, homoglyphs, mixed scripts |
| `03-malformed-tags.txt` | Unclosed/excess/nested colour tags, unknown tag names, tag-like dialogue text |
| `04-control-and-injection.txt` | Null bytes, ANSI escapes, BOM, line separators, pipe-separator abuse, path traversal and template-injection shapes |
