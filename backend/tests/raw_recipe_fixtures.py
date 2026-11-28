from raw_recipe_store import (normalize_identity, _connection, _read_row, _write_recipe,
                              _settings_json, _request_hash, _uuid, _import_defaults_fingerprint)


def read_saved_recipe(identity):
    with _connection() as connection:
        return _read_row(connection, normalize_identity(identity)) or {"recipe": None}


def seed_recipe_row(identity, revision, save_id, settings, *, import_defaults_fingerprint=None):
    """Set up a saved Recipe row without History for restoration and storage tests."""
    identity = normalize_identity(identity)
    encoded = _settings_json(settings, identity["settingsSchemaVersion"])
    digest = _request_hash(identity, encoded, revision)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _write_recipe(connection, identity, _read_row(connection, identity), revision, _uuid(save_id),
                      encoded, digest, _import_defaults_fingerprint(import_defaults_fingerprint))
        result = _read_row(connection, identity)
        connection.commit()
        return result
