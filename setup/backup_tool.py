#!/usr/bin/env python3
"""
backup_tool.py — makes and checks WordLight backup files (used by setup.sh)
===========================================================================

  python3 backup_tool.py size --add NAME=PATH ...
      Prints how many bytes the files would take before compressing.

  python3 backup_tool.py create OUT.tar.gz [--env ENV_FILE] [--info KEY=VALUE ...]
                                --add NAME=PATH ...
      Makes a backup. Each --add stores a folder (or one file) under NAME
      inside the backup, e.g. --add scripts=/home/wordlight/Scripts.
      --env stores WordLight's .env with every password and secret taken
      out. The file is written as OUT.tar.gz.partial, read back and checked,
      and only then renamed to OUT.tar.gz.

  python3 backup_tool.py check FILE.tar.gz
      Reads a backup all the way through and checks every file in it
      against the list of checksums it carries.

  python3 backup_tool.py info FILE.tar.gz
      Prints what the backup says about itself, one KEY=VALUE per line
      (created, hostname, info.<name>, part.<name>=FILES BYTES). Quick: it
      only reads the start of the file. For setup.sh to read.

  python3 backup_tool.py extract FILE.tar.gz --part NAME --to DIR --mode MODE
                                 [--keep-old DIR] [--shared]
      Writes one part of the backup (e.g. scripts) into DIR. MODE:
        replace    move everything now in DIR to --keep-old, then write the part
        merge      add new files, skip identical ones, and write a different
                   file of the same name as "Name (2).txt" (never over a file)
        overwrite  add new files, skip identical ones, and replace a different
                   one, moving this computer's copy to --keep-old first
        add        only top-level entries DIR doesn't have yet (e.g. job folders)
      --shared makes files 0664 and folders 2775 (the Scripts folder's rule).
      Never writes through a symbolic link or outside DIR. Run check first.

A backup is an ordinary .tar.gz (a Mac opens it with a double-click):
  README.txt                       what the file is
  backup-info.json                 when and where it was made, versions, what's in it
  wordlight/env-without-passwords  WordLight's .env, passwords and secrets taken out
  <NAME>/...                       each --add
  manifest.json                    every file's size and SHA-256 (last, so it can list them all)

Left out on purpose: symbolic links (a link could point outside the folder),
__pycache__ and .git folders and .pyc files, the converter page's password
file, and files this login can't read (counted and reported).

Only counts and sizes are printed, never what's inside a file: the Scripts
folder holds show scripts and caption files.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tarfile
import time
import zlib

FORMAT = 1
SKIP_DIRS = {"__pycache__", ".git"}
SKIP_FILES = {"converter-password.txt"}      # the converter page's password
SKIP_SUFFIXES = (".pyc",)
SECRET_KEY = re.compile(r"PASSWORD|SECRET|TOKEN|(^|_)KEY$", re.I)
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

# What setup.sh's --add names are called when counts are printed
LABELS = {
    "scripts": "Scripts folder",
    "wordlight": "WordLight settings (theater name, logos)",
    "converter/code": "Script Converter program",
    "converter/settings": "Script Converter settings",
    "converter/jobs": "Script Converter jobs",
}

README = """WordLight backup
================
Made by WordLight's setup.sh on {created} on the computer "{hostname}".

What's in it:
  scripts/              the Scripts folder: the caption files
  wordlight/            WordLight's settings (.env without passwords,
                        theater name and support email, logos)
  converter/code/       the Script Converter program (if installed)
  converter/settings/   its settings and templates (if installed)
  converter/jobs/       every show sent to the converter (only if chosen)
  backup-info.json      when and where this was made, and the versions
  manifest.json         a checksum for every file, to check the backup

Passwords are NOT in this file: not the admin or editor password, not
WordLight's session secret, not the converter page's password, not the
network share (Samba) passwords. A restore asks for new ones.

To restore: on the WordLight computer, run setup/setup.sh and choose the
backup option in its menu.

This file holds show scripts and caption files: keep it private.
"""


def human(n):
    n = float(n)
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%d bytes" % n if unit == "bytes" else "%.1f %s" % (n, unit)
        n /= 1024


def group_of(name):
    return "wordlight" if name == "wordlight" or name.startswith("wordlight/") else name


def parse_adds(items):
    adds = []
    for item in items or []:
        name, sep, path = item.partition("=")
        name = name.strip("/")
        parts = name.split("/")
        if not sep or not name or not path or ".." in parts or any(p.startswith(".") or not p for p in parts):
            sys.exit("backup_tool: bad --add %r (want NAME=PATH)" % item)
        adds.append((name, os.path.abspath(os.path.expanduser(path))))
    return adds


def new_counts():
    return {"files": 0, "bytes": 0, "links": 0, "unreadable": 0}


def walk(name, path, counts):
    """Yields (name in the backup, real path, is_folder) for one --add."""
    c = counts.setdefault(group_of(name), new_counts())
    if os.path.islink(path):
        c["links"] += 1
        return
    if os.path.isfile(path):
        if os.access(path, os.R_OK):
            c["files"] += 1
            c["bytes"] += os.path.getsize(path)
            yield name, path, False
        else:
            c["unreadable"] += 1
        return
    if not os.path.isdir(path):
        return

    def cant_read(_err):
        c["unreadable"] += 1

    for root, dirs, files in os.walk(path, onerror=cant_read):
        rel = os.path.relpath(root, path)
        arcroot = name if rel == "." else name + "/" + rel.replace(os.sep, "/")
        keep = []
        for d in sorted(dirs):
            if d in SKIP_DIRS:
                continue
            if os.path.islink(os.path.join(root, d)):
                c["links"] += 1
                continue
            keep.append(d)
        dirs[:] = keep
        yield arcroot, root, True
        for f in sorted(files):
            full = os.path.join(root, f)
            if f in SKIP_FILES or f.endswith(SKIP_SUFFIXES):
                continue
            if os.path.islink(full):
                c["links"] += 1
                continue
            if not os.path.isfile(full):          # sockets, pipes
                continue
            if not os.access(full, os.R_OK):
                c["unreadable"] += 1
                continue
            c["files"] += 1
            c["bytes"] += os.path.getsize(full)
            yield arcroot + "/" + f, full, False


def env_without_passwords(path):
    out, removed = [], []
    with open(path, encoding="utf-8", errors="surrogateescape") as f:
        for line in f.read().splitlines():
            m = ENV_LINE.match(line)
            if m and SECRET_KEY.search(m.group(1)):
                removed.append(m.group(1))
                out.append("# %s was taken out by the backup: a restore asks for a new one" % m.group(1))
            else:
                out.append(line)
    return ("\n".join(out) + "\n").encode("utf-8", "surrogateescape"), removed


class HashReader:
    """Hands a file to tarfile and keeps its SHA-256 on the way through."""

    def __init__(self, f):
        self.f = f
        self.h = hashlib.sha256()

    def read(self, n=-1):
        b = self.f.read(n)
        self.h.update(b)
        return b


def add_bytes(tar, manifest, arcname, data):
    ti = tarfile.TarInfo(arcname)
    ti.size = len(data)
    ti.mtime = int(time.time())
    ti.mode = 0o600
    tar.addfile(ti, io.BytesIO(data))
    manifest[arcname] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def print_counts(counts):
    order = list(LABELS)
    for g in sorted(counts, key=lambda g: (order.index(g) if g in order else 99, g)):
        c = counts[g]
        print("  %s: %d file%s, %s" % (LABELS.get(g, g), c["files"], "" if c["files"] == 1 else "s", human(c["bytes"])))
    links = sum(c["links"] for c in counts.values())
    unreadable = sum(c["unreadable"] for c in counts.values())
    if links:
        print("  Left out: %d symbolic link%s (a link could point outside the folder)" % (links, "" if links == 1 else "s"))
    if unreadable:
        print("  LEFT OUT: %d file%s or folder%s this login can't read" % (unreadable, "" if unreadable == 1 else "s", "" if unreadable == 1 else "s"))


def verify(path):
    """Reads the whole backup. Returns (problems, backup-info or None)."""
    problems, seen, manifest, info = [], {}, None, None
    unsafe = odd = 0
    try:
        with tarfile.open(path, "r:gz") as tar:
            for m in tar:
                parts = m.name.split("/")
                if m.name.startswith("/") or ".." in parts:
                    unsafe += 1
                    continue
                if m.isfile():
                    f = tar.extractfile(m)
                    h = hashlib.sha256()
                    keep = m.name in ("manifest.json", "backup-info.json")
                    data = []
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        h.update(chunk)
                        if keep:
                            data.append(chunk)
                    seen[m.name] = (m.size, h.hexdigest())
                    if m.name == "manifest.json":
                        manifest = json.loads(b"".join(data).decode("utf-8"))
                    elif m.name == "backup-info.json":
                        info = json.loads(b"".join(data).decode("utf-8"))
                elif not m.isdir():
                    odd += 1
            # tarfile stops quietly at a damaged entry, so read on to the end of
            # the compressed data: that makes gzip check its own checksum
            while tar.fileobj.read(1 << 20):
                pass
    except (OSError, EOFError, tarfile.TarError, zlib.error, ValueError) as e:
        if "CRC check failed" in str(e) or "Error -3" in str(e):
            return ["it's damaged: its compressed data doesn't match its own checksum"], info
        return ["it couldn't be read all the way through (%s)" % (getattr(e, "strerror", None) or e)], info
    if unsafe:
        problems.append("%d entr%s with an unsafe name" % (unsafe, "y" if unsafe == 1 else "ies"))
    if odd:
        problems.append("%d entr%s that aren't files or folders" % (odd, "y" if odd == 1 else "ies"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
        if info is not None:
            problems.append("it's damaged: it stops partway through (the list of checksums at its end is missing)")
        else:
            problems.append("it has no list of checksums (manifest.json), so it isn't a WordLight backup")
        return problems, info
    missing = bad = 0
    for name, want in manifest["files"].items():
        got = seen.get(name)
        if got is None:
            missing += 1
        elif got != (want.get("size"), want.get("sha256")):
            bad += 1
    extra = len([n for n in seen if n != "manifest.json" and n not in manifest["files"]])
    if missing:
        problems.append("%d file%s missing" % (missing, "" if missing == 1 else "s"))
    if bad:
        problems.append("%d file%s that don't match their checksum" % (bad, "" if bad == 1 else "s"))
    if extra:
        problems.append("%d file%s not on its list" % (extra, "" if extra == 1 else "s"))
    return problems, info


def cmd_size(args):
    counts = {}
    for name, path in parse_adds(args.add):
        for _ in walk(name, path, counts):
            pass
    print(sum(c["bytes"] for c in counts.values()))
    return 0


def cmd_create(args):
    adds = parse_adds(args.add)
    out = os.path.abspath(args.out)
    tmp = out + ".partial"
    if os.path.exists(out):
        print("backup_tool: %s already exists" % out)
        return 1
    info = {}
    for item in args.info or []:
        k, _, v = item.partition("=")
        info[k] = v

    counts, entries = {}, []
    for name, path in adds:
        entries.extend(walk(name, path, counts))
    env_data, removed = (None, [])
    if args.env and os.path.isfile(args.env):
        env_data, removed = env_without_passwords(args.env)

    hostname = socket.gethostname()
    created = time.strftime("%Y-%m-%d %H:%M %Z")
    backup_info = {
        "format": FORMAT,
        "made_by": "WordLight setup.sh",
        "created": created,
        "created_unix": int(time.time()),
        "hostname": hostname,
        "info": info,
        "parts": {g: {"files": c["files"], "bytes": c["bytes"]} for g, c in counts.items()},
        "env": env_data is not None,
        "env_keys_taken_out": removed,
    }
    manifest = {}
    try:
        with open(tmp, "wb") as raw:
            gzname = os.path.basename(out)[:-3] if out.endswith(".gz") else os.path.basename(out)
            with gzip.GzipFile(filename=gzname, fileobj=raw, mode="wb", compresslevel=6) as gz:
                with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
                    add_bytes(tar, manifest, "README.txt",
                              README.format(created=created, hostname=hostname).encode("utf-8"))
                    add_bytes(tar, manifest, "backup-info.json",
                              (json.dumps(backup_info, indent=2) + "\n").encode("utf-8"))
                    if env_data is not None:
                        add_bytes(tar, manifest, "wordlight/env-without-passwords", env_data)
                    for arc, full, is_dir in entries:
                        ti = tar.gettarinfo(full, arc)
                        if is_dir:
                            tar.addfile(ti)
                            continue
                        with open(full, "rb") as f:
                            hr = HashReader(f)
                            tar.addfile(ti, hr)
                        manifest[arc] = {"size": ti.size, "sha256": hr.h.hexdigest()}
                    data = json.dumps({"format": FORMAT, "files": manifest}, indent=1) + "\n"
                    ti = tarfile.TarInfo("manifest.json")
                    ti.size = len(data.encode("utf-8"))
                    ti.mtime = int(time.time())
                    ti.mode = 0o600
                    tar.addfile(ti, io.BytesIO(data.encode("utf-8")))
            raw.flush()
            os.fsync(raw.fileno())
    except (OSError, tarfile.TarError) as e:
        why = getattr(e, "strerror", None) or str(e)
        if "unexpected end of data" in str(e):
            why = "a file got shorter while it was being copied (was the converter working?)"
        print("backup_tool: the backup couldn't be written: %s" % why)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 1

    print_counts(counts)
    if removed:
        print("  WordLight's .env, without: %s" % ", ".join(removed))
    problems, _ = verify(tmp)
    if problems:
        print("backup_tool: the backup didn't check out when read back: %s" % "; ".join(problems))
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 1
    os.replace(tmp, out)
    try:
        os.chmod(out, 0o600)
    except OSError:
        pass
    try:
        fd = os.open(os.path.dirname(out), os.O_RDONLY)
        os.fsync(fd)
        os.close(fd)
    except OSError:
        pass
    print("  Backup file: %s, read back and checked: every file matches." % human(os.path.getsize(out)))
    return 0


def cmd_check(args):
    problems, info = verify(args.file)
    if isinstance(info, dict):
        print("  Made %s on \"%s\"" % (info.get("created", "?"), info.get("hostname", "?")))
        for k, v in sorted((info.get("info") or {}).items()):
            print("  %s: %s" % (k.replace("_", " "), v))
        for g, c in sorted((info.get("parts") or {}).items()):
            print("  %s: %d files, %s" % (LABELS.get(g, g), c.get("files", 0), human(c.get("bytes", 0))))
    if problems:
        print("backup_tool: this backup has problems: %s" % "; ".join(problems))
        return 1
    print("  Checked: every file matches.")
    return 0


def cmd_info(args):
    try:
        with tarfile.open(args.file, "r:gz") as tar:
            for n, m in enumerate(tar):
                if m.name == "backup-info.json" and m.isfile():
                    info = json.loads(tar.extractfile(m).read().decode("utf-8"))
                    break
                if n > 5:
                    raise ValueError("no backup-info.json")
            else:
                raise ValueError("no backup-info.json")
    except (OSError, EOFError, tarfile.TarError, zlib.error, ValueError) as e:
        print("backup_tool: that isn't a WordLight backup it can read (%s)" % (getattr(e, "strerror", None) or e))
        return 1
    clean = lambda v: str(v).replace("\n", " ")
    print("format=%s" % clean(info.get("format", "")))
    print("created=%s" % clean(info.get("created", "")))
    print("hostname=%s" % clean(info.get("hostname", "")))
    for k, v in sorted((info.get("info") or {}).items()):
        print("info.%s=%s" % (clean(k), clean(v)))
    for g, c in sorted((info.get("parts") or {}).items()):
        print("part.%s=%d %d" % (clean(g), int(c.get("files", 0)), int(c.get("bytes", 0))))
    return 0


class Unsafe(Exception):
    pass


def safe_target(base, rel):
    """The real path for rel inside base, refusing any symbolic link on the way."""
    cur = base
    for piece in rel.split("/"):
        cur = os.path.join(cur, piece)
        if os.path.islink(cur):
            raise Unsafe(rel)
    return cur


NUMBERED = re.compile(r"^(.*) \((\d+)\)$")


def next_free(path):
    """Name (2).txt, Name (3).txt ... never "Name (2) (2).txt"."""
    folder, name = os.path.split(path)
    stem, ext = os.path.splitext(name)
    m = NUMBERED.match(stem)
    if m:
        stem = m.group(1)
    i = 2
    while True:
        cand = os.path.join(folder, "%s (%d)%s" % (stem, i, ext))
        if not os.path.lexists(cand):
            return cand
        i += 1


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def move_aside(path, keep, rel):
    dest = os.path.join(keep, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.lexists(dest):
        dest = next_free(dest)
    shutil.move(path, dest)


def cmd_extract(args):
    part = args.part.strip("/")
    prefix = part + "/"
    base = os.path.abspath(args.to)
    keep = os.path.abspath(args.keep_old) if args.keep_old else None
    if args.mode in ("replace", "overwrite") and not keep:
        print("backup_tool: --mode %s needs --keep-old" % args.mode)
        return 1
    if os.path.islink(base):
        print("backup_tool: %s is a symbolic link; nothing written" % base)
        return 1
    os.makedirs(base, exist_ok=True)
    fmode, dmode = (0o664, 0o2775) if args.shared else (None, None)
    c = dict(added=0, same=0, renamed=0, replaced=0, skipped=0, unsafe=0, aside=0)

    if args.mode == "replace":
        for e in sorted(os.listdir(base)):
            move_aside(os.path.join(base, e), keep, e)
            c["aside"] += 1
    have_top = set(os.listdir(base)) if args.mode == "add" else set()

    try:
        with tarfile.open(args.file, "r:gz") as tar:
            for m in tar:
                if not m.name.startswith(prefix):
                    continue
                rel = m.name[len(prefix):].rstrip("/")
                parts = rel.split("/")
                if not rel or ".." in parts or "" in parts or "." in parts or m.name.startswith("/"):
                    c["unsafe"] += 1
                    continue
                if args.mode == "add" and parts[0] in have_top:
                    if m.isfile():
                        c["skipped"] += 1
                    continue
                try:
                    full = safe_target(base, rel)
                except Unsafe:
                    c["unsafe"] += 1
                    continue
                if m.isdir():
                    if os.path.lexists(full) and not os.path.isdir(full):
                        c["skipped"] += 1
                        continue
                    os.makedirs(full, exist_ok=True)
                    os.chmod(full, dmode if dmode is not None else ((m.mode & 0o777) | 0o700))
                    continue
                if not m.isfile():
                    c["unsafe"] += 1
                    continue
                folder = os.path.dirname(full)
                os.makedirs(folder, exist_ok=True)
                if dmode is not None and os.path.dirname(rel):
                    os.chmod(folder, dmode)
                # Write to a temporary file next to it first, then put it in place
                fd = None
                tmp = os.path.join(folder, ".restore-%d-%d.tmp" % (os.getpid(), c["added"] + c["renamed"] + c["replaced"] + c["same"]))
                h = hashlib.sha256()
                src = tar.extractfile(m)
                with open(tmp, "xb") as out:
                    for chunk in iter(lambda: src.read(1 << 20), b""):
                        h.update(chunk)
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                os.chmod(tmp, fmode if fmode is not None else ((m.mode & 0o777) | 0o600))
                os.utime(tmp, (m.mtime, m.mtime))
                if os.path.lexists(full):
                    if not os.path.isfile(full) or os.path.islink(full):
                        os.remove(tmp)
                        c["skipped"] += 1
                        continue
                    if file_sha(full) == h.hexdigest():
                        os.remove(tmp)
                        c["same"] += 1
                        continue
                    if args.mode == "merge":
                        target = next_free(full)
                        os.link(tmp, target)       # fails rather than overwrite
                        os.remove(tmp)
                        c["renamed"] += 1
                        continue
                    move_aside(full, keep, rel)    # overwrite (or a repeat in replace)
                    os.replace(tmp, full)
                    c["replaced"] += 1
                    continue
                os.replace(tmp, full)
                c["added"] += 1
    except (OSError, EOFError, tarfile.TarError, zlib.error) as e:
        print("backup_tool: restoring stopped partway: %s" % (getattr(e, "strerror", None) or e))
        try:
            os.remove(tmp)
        except (OSError, NameError):
            pass
        return 1

    said = ["%d added" % c["added"]]
    if c["same"]:
        said.append("%d already the same" % c["same"])
    if c["renamed"]:
        said.append("%d different, kept both (the backup's copy has a (2) name)" % c["renamed"])
    if c["replaced"]:
        said.append("%d replaced" % c["replaced"])
    if c["skipped"]:
        said.append("%d skipped (already here)" % c["skipped"])
    if c["aside"]:
        said.append("%d item%s moved aside first" % (c["aside"], "" if c["aside"] == 1 else "s"))
    if c["unsafe"]:
        said.append("%d left out (a symbolic link in the way, or an unsafe name)" % c["unsafe"])
    print("  " + ", ".join(said))
    return 0


def main():
    p = argparse.ArgumentParser(description="Makes and checks WordLight backup files.")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("size")
    s.add_argument("--add", action="append")
    c = sub.add_parser("create")
    c.add_argument("out")
    c.add_argument("--add", action="append")
    c.add_argument("--env")
    c.add_argument("--info", action="append")
    k = sub.add_parser("check")
    k.add_argument("file")
    i = sub.add_parser("info")
    i.add_argument("file")
    x = sub.add_parser("extract")
    x.add_argument("file")
    x.add_argument("--part", required=True)
    x.add_argument("--to", required=True)
    x.add_argument("--mode", required=True, choices=["replace", "merge", "overwrite", "add"])
    x.add_argument("--keep-old")
    x.add_argument("--shared", action="store_true")
    args = p.parse_args()
    return {"size": cmd_size, "create": cmd_create, "check": cmd_check,
            "info": cmd_info, "extract": cmd_extract}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
