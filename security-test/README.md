# WordLight — caption script security tests

Test material for checking that a malicious or malformed caption script
can't break the server, the controller, or an audience member's browser.

The threat model is simple and realistic: **someone hands the operator a
script file.** Nobody inspects a few hundred lines of dialogue before a
show. If a caption file can run code in every audience phone, that matters.

## Where this folder goes

`security-test/` sits at the **project root, beside `public/`** — not inside
it. The harness reads `../public/global.js` to get the real parser, so the
relative position matters:

```
wordlight/
├── public/
│   └── global.js          ← harness reads the real parser from here
├── server.js
└── security-test/
    ├── test-parser.js
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

## What these tests do NOT cover

The harness tests the parser in isolation. Two areas need separate
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
| `01-xss-injection.txt` | Script tags, event handlers, attribute breaks, entity encoding, filter-bypass shapes |
| `02-unicode-stress.txt` | RTL override, zero-width chars, Zalgo, emoji/ZWJ, surrogate pairs, homoglyphs, mixed scripts |
| `03-malformed-tags.txt` | Unclosed/excess/nested colour tags, unknown tag names, tag-like dialogue text |
| `04-control-and-injection.txt` | Null bytes, ANSI escapes, BOM, line separators, pipe-separator abuse, path traversal and template-injection shapes |
