"""Post-commit RAW notifications using the existing thumbnail publication fence."""

from uuid import UUID

from starlette.concurrency import run_in_threadpool


async def mutate_raw_edits(scheduler, asset_id, operation, *args, **kwargs):
    # Windows chooses its storage profile after importing the RAW API module.
    from raw_recipe_store import get_raw_saved_state
    from edit_store import StoreUnavailable
    from thumbnail_cache import thumbnail_log

    if scheduler is None:
        return await run_in_threadpool(operation, *args, **kwargs)
    asset_id = UUID(str(asset_id))
    async with scheduler.mutation_lock:
        try:
            before = await run_in_threadpool(get_raw_saved_state, asset_id)
            known_before = True
        except Exception:
            # Optional cache bookkeeping cannot prevent the authoritative store operation.
            before = None
            known_before = False
        before_revision = before.get("revision") if isinstance(before, dict) else None
        if known_before and (before is None or before["exportEligible"] is False):
            # A previous reset may have committed just before the process stopped.
            try:
                await run_in_threadpool(scheduler.cache.fence_reset, asset_id)
            except OSError as error:
                raise StoreUnavailable() from error
        result = await run_in_threadpool(operation, *args, **kwargs)
        mutation_recorded = False
        try:
            after = await run_in_threadpool(get_raw_saved_state, asset_id)
            after_revision = after.get("revision") if isinstance(after, dict) else None
            if (not known_before or before_revision != after_revision) and scheduler.publication_hub is not None:
                scheduler.publication_hub.record_mutation()
                mutation_recorded = True
            if after is None or after["exportEligible"] is not True:
                await scheduler.reset(asset_id)
            elif before is None or before["currentRecipe"] != after["currentRecipe"] or \
                    before["exportEligible"] is not True:
                # Ignore receipt-only saves and History changes that keep current settings.
                scheduler.schedule(asset_id)
        except Exception:
            if not known_before and not mutation_recorded and scheduler.publication_hub is not None:
                scheduler.publication_hub.record_mutation()
            # A committed save stays successful even if derived-cache maintenance fails.
            thumbnail_log("saveNotification.failed", level="warn", component="thumbnail_scheduler",
                          assetId=str(asset_id), errorCode="thumbnail_maintenance_failed")
        return result
