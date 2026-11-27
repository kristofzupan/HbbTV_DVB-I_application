#!/usr/bin/env python3
import struct
import sys
import os


def boxes(data, start=0, end=None):
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
    end = len(data) if end is None else end
    for btype, off, size in boxes(data, start, end):
        if btype == path[0]:
            if len(path) == 1:
                return off, size
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
    hit = find(data, [b"moof", b"traf", b"tfdt"])
    if hit is None:
        return data
    tfdt_off, tfdt_size = hit
    if data[tfdt_off + 8] == 1:
        return data

    value = struct.unpack(">I", data[tfdt_off + 12:tfdt_off + 16])[0]
    new_tfdt = (struct.pack(">I", tfdt_size + 4) + b"tfdt" +
                b"\x01" + data[tfdt_off + 9:tfdt_off + 12] +
                struct.pack(">Q", value))

    out = bytearray(data[:tfdt_off] + new_tfdt + data[tfdt_off + tfdt_size:])

    for path in ([b"moof"], [b"moof", b"traf"]):
        hit = find(bytes(out), path)
        if hit:
            off, size = hit
            out[off:off + 4] = struct.pack(">I", size + 4)

    moof = find(bytes(out), [b"moof"])
    trun = find(bytes(out), [b"moof", b"traf", b"trun"])
    if moof and trun:
        off, _ = trun
        flags = struct.unpack(">I", out[off + 8:off + 12])[0] & 0xFFFFFF
        if flags & 0x000001:
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
