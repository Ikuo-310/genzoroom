"""Container storage layout shared by persistence features."""

import os
import tempfile
from pathlib import Path

from backend_logging import backend_logger


# Host paths belong to Compose; application paths stay identical in both images.
STORAGE_ROOT = Path("/genzoroom")
DB_PATH = STORAGE_ROOT / "data" / "genzoroom.db"


class StorageInitializationError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"Storage initialization failed: {code}")


def storage_root_is_mounted() -> bool:
    # ismount() can miss same-filesystem bind mounts; Linux mountinfo lists them explicitly.
    try:
        return any(line.split()[4] == STORAGE_ROOT.as_posix()
                   for line in Path("/proc/self/mountinfo").read_text().splitlines())
    except (OSError, IndexError):
        return False


def initialize_storage() -> None:
    try:
        if not storage_root_is_mounted():
            raise StorageInitializationError("storage_root_not_mounted")
        try:
            data = STORAGE_ROOT / "data"
            data.mkdir(exist_ok=True)
            # A disposable file leaves the DB untouched; explicit unlink verifies deletion rights too.
            with tempfile.NamedTemporaryFile(dir=data, delete_on_close=False) as probe:
                probe.write(b"genzoroom")
                probe.flush()
                os.fsync(probe.fileno())
            if DB_PATH.exists() and not os.access(DB_PATH, os.R_OK | os.W_OK):
                raise StorageInitializationError("storage_database_not_writable")
        except OSError:
            raise StorageInitializationError("storage_data_not_writable") from None
    except StorageInitializationError as error:
        try:
            backend_logger.add(level="error", component="storage", event="initialization.failed",
                               context={"errorCode": error.code})
        except Exception:
            # Logging must not obscure the actionable startup failure.
            pass
        raise
