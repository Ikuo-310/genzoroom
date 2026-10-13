"""Development exclusion state; no ownership of Queue or Immich mutations."""
import json
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
import edit_store
from backend_logging import backend_logger
from immich import (_get_asset_stacks, _parse_stack_snapshot, _require_configuration,
                    get_asset_detail, ImmichRequestError)


class ExclusionTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["asset", "stack"]
    id: UUID


class ExclusionStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targets: list[ExclusionTarget] = Field(max_length=100)


def _log(event: str, *, level: str = "info", **context) -> None:
    try:
        backend_logger.add(level=level, component="developmentExclusions", event=event, context=context)
    except Exception:
        # Optional diagnostics cannot change persistence or Gallery behavior.
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def configuration(snapshot, kind, target_id):
    lookup = {UUID(s["id"]): s for s in snapshot.stacks}
    if kind == "stack":
        stack = lookup.get(target_id)
        if stack is not None:
            return "confirmed", str(UUID(stack["primaryAssetId"])), sorted(str(UUID(m["id"])) for m in stack["assets"])
        # An unidentified malformed entry can hide any missing Stack or membership.
        return ("absent" if snapshot.complete else "unknown"), None, None
    if target_id in snapshot.quarantined_member_ids:
        return "unknown", None, None
    if any(target_id == UUID(m["id"]) for s in snapshot.stacks for m in s["assets"]):
        return "stacked", None, None
    # Localized Stack uncertainty must not block unrelated Assets; incomplete identities still block them.
    return ("single" if snapshot.complete or snapshot.membership_identifiable else "unknown"), None, None


def reconcile(snapshot, observed_at):
    with edit_store._connection() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            rows = db.execute("SELECT * FROM development_exclusions WHERE registered_at<=?", (observed_at,)).fetchall()
            confirmed_members = {
                UUID(member["id"])
                for stack in snapshot.stacks
                for member in stack["assets"]
            }
            for row in rows:
                if row["kind"] == "asset":
                    asset_id = UUID(row["target_id"])
                    if asset_id in confirmed_members:
                        db.execute("DELETE FROM development_exclusions WHERE kind='asset' AND target_id=?", (row["target_id"],))
                        _log("exclusion.invalidated", assetId=row["target_id"])
                    continue
                try:
                    saved_members = json.loads(row["member_ids_json"])
                    if not isinstance(saved_members, list) or not saved_members:
                        raise ValueError
                    normalized = sorted(str(UUID(member)) for member in saved_members)
                    if normalized != saved_members or len(set(normalized)) != len(normalized):
                        raise ValueError
                    if str(UUID(row["primary_asset_id"])) not in normalized:
                        raise ValueError
                except (ValueError, TypeError, AttributeError) as error:
                    raise edit_store.StoreUnavailable() from error
                status, primary, members = configuration(snapshot, "stack", UUID(row["target_id"]))
                if status == "absent" or (status == "confirmed" and
                        (primary != row["primary_asset_id"] or members != saved_members)):
                    db.execute("DELETE FROM development_exclusions WHERE kind='stack' AND target_id=?", (row["target_id"],))
                    _log("exclusion.invalidated", stackId=row["target_id"])
            db.commit()
        except Exception:
            db.rollback()
            raise


def observe(body, observed_at):
    # Gallery reads must not create an alternate DB before startup has validated storage.
    if not edit_store.DB_PATH.exists():
        return
    try:
        reconcile(_parse_stack_snapshot(body, require_primary=True), observed_at)
    except edit_store.StoreUnavailable:
        _log("exclusion.reconcile.failed", level="warn", errorCode="persistence_unavailable")


async def snapshot_for(url, key):
    url, key = _require_configuration(url, key)
    return _parse_stack_snapshot(await _get_asset_stacks(url, key), require_primary=True)


async def statuses(targets, url, key):
    snapshot = None
    if targets:
        try:
            snapshot = await snapshot_for(url, key)
        except ImmichRequestError:
            _log("exclusion.configuration.unknown", level="warn", errorCode="configuration_unavailable")
    with edit_store._connection() as db:
        # One indexed query serves both singleton and batch reads.
        clauses = " OR ".join("(kind=? AND target_id=?)" for _ in targets)
        rows = db.execute("SELECT kind, target_id FROM development_exclusions WHERE " + clauses,
                          [v for t in targets for v in (t.kind, str(t.id))]).fetchall() if targets else []
    saved = {(r["kind"], r["target_id"]) for r in rows}
    return {"items": [{"kind": t.kind, "id": str(t.id), "excluded": (t.kind, str(t.id)) in saved,
                       "configuration": configuration(snapshot, t.kind, t.id)[0] if snapshot else "unknown"}
                      for t in targets]}


async def _register(kind, target_id, url, key):
    snapshot = await snapshot_for(url, key)
    status, primary, members = configuration(snapshot, kind, target_id)
    if status not in ("confirmed", "single"):
        return status
    if kind == "asset":
        await get_asset_detail(url, key, target_id)
    with edit_store._connection() as db:
        db.execute("INSERT INTO development_exclusions VALUES (?,?,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET primary_asset_id=excluded.primary_asset_id, member_ids_json=excluded.member_ids_json, registered_at=excluded.registered_at",
                   (kind, str(target_id), primary, json.dumps(members) if members is not None else None, _now()))
    _log("exclusion.registered", assetId=str(target_id) if kind == "asset" else None,
                        stackId=str(target_id) if kind == "stack" else None)
    return status


async def register(kind, target_id, url, key):
    try:
        status = await _register(kind, target_id, url, key)
        if status not in ("confirmed", "single"):
            _log("exclusion.registration.failed", level="error", errorCode="exclusion_target_" + status)
        return status
    except (ImmichRequestError, edit_store.StoreUnavailable) as error:
        _log("exclusion.registration.failed", level="error",
             errorCode=error.error_code if isinstance(error, ImmichRequestError) else error.code)
        raise


def remove(kind, target_id):
    with edit_store._connection() as db:
        db.execute("DELETE FROM development_exclusions WHERE kind=? AND target_id=?", (kind, str(target_id)))
    _log("exclusion.removed", assetId=str(target_id) if kind == "asset" else None,
                        stackId=str(target_id) if kind == "stack" else None)
