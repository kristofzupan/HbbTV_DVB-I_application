#!/usr/bin/env python3
"""Put every packaged segment into the one shape the publisher can serve.

The segments carry timestamps from inside the 248 s loop — segment 11 says it
begins at 40 s — but a live stream needs them to increase forever. The publisher
therefore adds an offset to each segment's baseMediaDecodeTime as it serves it,
and this makes that a single fixed-width write rather than a special case per
representation:

  - `sidx` is removed. It carries its own copy of the earliest presentation
    time, so leaving it would mean patching two places and keeping them
    agreeing. A segment of styp/moof/mdat is what DASH live profile expects and
    what ffmpeg's own live output contained.

  - `tfdt` is forced to version 1, the 64-bit form. MP4Box writes version 0 for
    the subtitles because the values inside one loop are small, but a live
    timeline at timescale 1000 passes 2^32 after 49 days, and the failure would
    be a stream that works for a month and a half and then silently stops.
    Growing the box by four bytes moves everything after it, so the enclosing
    traf and moof sizes and the trun data offset all move with it.

Run by ffmpeg_stream_commands/package-loop. Idempotent.
"""
import struct
import sys
import os


def boxes(data, start=0, end=None):
    """Yield (type, offset, size) of the boxes directly inside [start, end)."""
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size = struct.unpack(">I", data[i:i + 4])[0]
        btype = data[i + 4:i + 8]
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
        elif size == 0:
            size = end - i
        if size < 8:
            break
        yield btype, i, size
        i += size


def find(data, path, start=0, end=None):
    """Walk a path of box types, e.g. [b'moof', b'traf', b'tfdt']."""
    end = len(data) if end is None else end
    for btype, off, size in boxes(data, start, end):
        if btype == path[0]:
            if len(path) == 1:
                return off, size
            # Container payloads begin straight after the 8 byte header.
            return find(data, path[1:], off + 8, off + size)
    return None


def strip_sidx(data):
    out = bytearray()
    for btype, off, size in boxes(data):
        if btype == b"sidx":
            continue
        out += data[off:off + size]
    return bytes(out)


def upgrade_tfdt(data):
    """Rewrite a version 0 tfdt as version 1, fixing every size it sits inside."""
    hit = find(data, [b"moof", b"traf", b"tfdt"])
    if hit is None:
        return data
    tfdt_off, tfdt_size = hit
    if data[tfdt_off + 8] == 1:
        return data                      # already 64 bit

    value = struct.unpack(">I", data[tfdt_off + 12:tfdt_off + 16])[0]
    new_tfdt = (struct.pack(">I", tfdt_size + 4) + b"tfdt" +
                b"\x01" + data[tfdt_off + 9:tfdt_off + 12] +
                struct.pack(">Q", value))

    out = bytearray(data[:tfdt_off] + new_tfdt + data[tfdt_off + tfdt_size:])

    # The boxes that now contain four more bytes.
    for path in ([b"moof"], [b"moof", b"traf"]):
        hit = find(bytes(out), path)
        if hit:
            off, size = hit
            out[off:off + 4] = struct.pack(">I", size + 4)

    # trun's data offset is measured from the start of the moof, and the data it
    # points at has just moved four bytes further away.
    moof = find(bytes(out), [b"moof"])
    trun = find(bytes(out), [b"moof", b"traf", b"trun"])
    if moof and trun:
        off, _ = trun
        flags = struct.unpack(">I", out[off + 8:off + 12])[0] & 0xFFFFFF
        if flags & 0x000001:             # data-offset-present
            cur = struct.unpack(">i", out[off + 16:off + 20])[0]
            out[off + 16:off + 20] = struct.pack(">i", cur + 4)
    return bytes(out)


def normalise(path):
    data = open(path, "rb").read()
    fixed = upgrade_tfdt(strip_sidx(data))
    if fixed != data:
        open(path, "wb").write(fixed)
        return True
    return False


if __name__ == "__main__":
    changed = 0
    total = 0
    for d in sys.argv[1:]:
        for name in sorted(os.listdir(d)):
            if not name.endswith(".m4s") or name.startswith("init-"):
                continue
            total += 1
            if normalise(os.path.join(d, name)):
                changed += 1
    print(f"  normalised {changed} of {total} segments")
