"""Verify a native frame against the actual stationary Windows cursor, without moving it."""
import ctypes as c
import json
import os
import struct
import subprocess
import sys
import time
import zlib
from ctypes import wintypes as w
from pathlib import Path

user, gdi = c.windll.user32, c.windll.gdi32
user.SetProcessDpiAwarenessContext(c.c_void_p(-4))


class CursorInfo(c.Structure):
    _fields_ = [("size", w.DWORD), ("flags", w.DWORD), ("icon", w.HANDLE), ("point", w.POINT)]


class IconInfo(c.Structure):
    _fields_ = [("is_icon", w.BOOL), ("x", w.DWORD), ("y", w.DWORD), ("mask", w.HBITMAP), ("color", w.HBITMAP)]


def cursor():
    value = CursorInfo(size=c.sizeof(CursorInfo))
    assert user.GetCursorInfo(c.byref(value))
    return value.flags, value.icon, value.point.x, value.point.y


def icon_on(icon, value, size):
    gdi.CreateCompatibleDC.restype = gdi.CreateDIBSection.restype = gdi.SelectObject.restype = w.HANDLE
    dc = w.HDC(gdi.CreateCompatibleDC(None))
    info = struct.pack("<IiiHHIIiiII", 40, size, -size, 1, 32, 0, 0, 0, 0, 0, 0)
    bits = c.c_void_p()
    bitmap = w.HBITMAP(gdi.CreateDIBSection(dc, info, 0, c.byref(bits), None, 0))
    assert bitmap.value and bits.value
    previous = w.HANDLE(gdi.SelectObject(dc, bitmap))
    try:
        c.memset(bits, value, size * size * 4)
        assert user.DrawIconEx(dc, 0, 0, w.HANDLE(icon), 0, 0, 0, None, 3)
        gdi.GdiFlush()
        return c.string_at(bits, size * size * 4)
    finally:
        gdi.SelectObject(dc, previous)
        gdi.DeleteObject(bitmap)
        gdi.DeleteDC(dc)


def check(executable):
    size = 128
    for _ in range(15):
        flags, icon, x, y = cursor()
        if not flags & 1 or not icon:
            time.sleep(.15)
            continue
        meta = IconInfo()
        assert user.GetIconInfo(w.HANDLE(icon), c.byref(meta))
        for bitmap in (meta.mask, meta.color):
            if bitmap:
                gdi.DeleteObject(w.HBITMAP(bitmap))
        black, white = icon_on(icon, 0, size), icon_on(icon, 255, size)
        request = [str(executable), str(x-meta.x), str(y-meta.y), str(size), str(size)]
        frame = zlib.decompress(subprocess.check_output(request, creationflags=subprocess.CREATE_NO_WINDOW), -15)
        if cursor() != (flags, icon, x, y):
            continue
        opaque = different = 0
        for i in range(0, len(frame), 4):
            if black[i:i+3] == white[i:i+3]:
                opaque += 1
                b, g, r = black[i:i+3]
                different += max(abs(a-z) for a, z in zip(frame[i:i+3], (r,g,b))) > 24
        if opaque >= 12 and different >= max(6, opaque*.12):
            return {"passed":True, "opaqueCursorPixels":opaque, "framePixelsDifferentFromCursor":different}
    raise AssertionError("Could not verify a visible, stationary system pointer on the native frame")


if __name__ == "__main__":
    result = check(Path(sys.argv[1]))
    if os.getenv("ANNOTATION_EVIDENCE"):
        destination = Path(os.environ["ANNOTATION_EVIDENCE"])
        destination.mkdir(parents=True, exist_ok=True)
        (destination/"report.json").write_text(json.dumps(result), encoding="utf-8")
    print(json.dumps(result))
