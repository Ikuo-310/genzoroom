"""User-bound, temporary desktop bootstrap handoff; never contains Immich credentials."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile


def protect_for_current_user(content: bytes, *, decrypt=False) -> bytes:
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    operation = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    source_buffer = (ctypes.c_ubyte * len(content)).from_buffer_copy(content)
    source = Blob(len(content), source_buffer)
    output = Blob()
    # No LOCAL_MACHINE flag: another Windows user cannot decrypt or forge this handoff.
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError("desktop_handoff_crypto_failed")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel32.LocalFree(output.data)


class DesktopHandoff:
    def __init__(self, root: Path):
        self.path = root / "desktop-session.dpapi"
        self._encrypted = None

    def publish(self, *, port, bootstrap_token, probe_key):
        payload = json.dumps({"version": 1, "port": port, "bootstrapToken": bootstrap_token,
                              "probeKey": probe_key}, separators=(",", ":")).encode()
        encrypted = protect_for_current_user(payload)
        temporary = None
        try:
            # Only ciphertext reaches disk, including the atomic-publication temporary file.
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix="desktop-session-", suffix=".tmp",
                                             delete=False) as output:
                temporary = Path(output.name)
                output.write(encrypted)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            self._encrypted = encrypted
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def close(self):
        if self._encrypted is not None:
            try:
                # Do not remove a handoff published by a newer host using the same user root.
                if self.path.read_bytes() == self._encrypted:
                    self.path.unlink()
            except FileNotFoundError:
                pass
            self._encrypted = None
