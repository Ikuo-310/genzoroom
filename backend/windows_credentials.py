"""Current-user Windows Credential Manager adapter; no fallback secret storage."""
import ctypes
from ctypes import wintypes
import re


class ConnectionSettingsError(RuntimeError):
    pass


class CredentialVault:
    def __init__(self, namespace=None):
        from windows_runtime import credential_namespace
        self.namespace = namespace if namespace is not None else credential_namespace()

    def _api(self):
        class Credential(ctypes.Structure):
            _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                        ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                        ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]
        try:
            api = ctypes.WinDLL("advapi32", use_last_error=True)
            api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                     ctypes.POINTER(ctypes.POINTER(Credential))]
            api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
            api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
            api.CredFree.argtypes = [ctypes.c_void_p]
            for name in ("CredReadW", "CredWriteW", "CredDeleteW"):
                getattr(api, name).restype = wintypes.BOOL
            return api, Credential
        except (AttributeError, OSError):
            raise ConnectionSettingsError("credential_unavailable") from None

    def _target(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier):
            raise ConnectionSettingsError("settings_invalid")
        return self.namespace + identifier

    def get(self, identifier):
        api, credential = self._api()
        output = ctypes.POINTER(credential)()
        if not api.CredReadW(self._target(identifier), 1, 0, ctypes.byref(output)):
            if ctypes.get_last_error() == 1168:
                return None
            raise ConnectionSettingsError("credential_read_failed")
        try:
            if output.contents.CredentialBlobSize > 2560:
                raise ConnectionSettingsError("credential_read_failed")
            return ctypes.string_at(output.contents.CredentialBlob, output.contents.CredentialBlobSize).decode("utf-8")
        except UnicodeError:
            raise ConnectionSettingsError("credential_read_failed") from None
        finally:
            api.CredFree(output)

    def put(self, identifier, secret):
        api, credential = self._api()
        raw = secret.encode("utf-8")
        if not raw or len(raw) > 2560:
            raise ConnectionSettingsError("key_invalid")
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        value = credential(Type=1, TargetName=self._target(identifier), CredentialBlobSize=len(raw),
                           CredentialBlob=buffer, Persist=2, UserName="GenzoRoom")
        # LOCAL_MACHINE persistence means this user's logon sessions on this PC, not all users.
        if not api.CredWriteW(ctypes.byref(value), 0):
            raise ConnectionSettingsError("credential_write_failed")

    def delete(self, identifier):
        api, _ = self._api()
        if not api.CredDeleteW(self._target(identifier), 1, 0) and ctypes.get_last_error() != 1168:
            raise ConnectionSettingsError("credential_delete_failed")
