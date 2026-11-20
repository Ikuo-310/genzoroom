import pytest
from pathlib import Path

import edit_store
import storage


@pytest.fixture(autouse=True)
def isolated_unit_profile(monkeypatch):
    # Existing unit tests configure their own DB paths; the guard only models a selected Runtime.
    monkeypatch.setattr(storage, "DEPLOYMENT_ROOT", Path("/genzoroom"))
    monkeypatch.setattr(storage, "STORAGE_ROOT", Path("/genzoroom"))
    monkeypatch.setattr(storage, "DB_PATH", Path("/genzoroom/data/genzoroom.db"))
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", False)
    monkeypatch.setattr(storage, "PROFILE_ID", "test-profile")
    monkeypatch.setattr(edit_store, "DB_PATH", Path("/genzoroom/data/genzoroom.db"))
