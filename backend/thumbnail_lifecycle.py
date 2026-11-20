"""Post-commit RAW notifications using the existing thumbnail publication fence."""

from uuid import UUID

from starlette.concurrency import run_in_threadpool


async def mutate_raw_edits(scheduler, asset_id, operation, *args, **kwargs):
    # Windows chooses its storage profile after importing the RAW API module.
    from raw_recipe_store import delete_raw_edits, get_raw_saved_state, put_raw_recipe
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
        tracks_recipe_commit = operation is put_raw_recipe
        operation_kwargs = {**kwargs, "_return_state_changed": True} if tracks_recipe_commit else kwargs
        operation_result = await run_in_threadpool(operation, *args, **operation_kwargs)
        if tracks_recipe_commit:
            result, state_changed = operation_result
        else:
            result = operation_result
            if isinstance(result, dict) and type(result.get("replayed")) is bool:
                state_changed = not result["replayed"]
            elif operation is delete_raw_edits and isinstance(result, dict):
                state_changed = any(type(result.get(key)) is int and result[key] > 0
                                    for key in ("recipes", "histories", "steps", "historyReceipts"))
            else:
                state_changed = None
        mutation_recorded = False
        if state_changed is True and scheduler.publication_hub is not None:
            # Record the committed DB change before optional reads or cache maintenance can fail.
            scheduler.publication_hub.record_mutation()
            mutation_recorded = True
        try:
            after = await run_in_threadpool(get_raw_saved_state, asset_id)
            after_revision = after.get("revision") if isinstance(after, dict) else None
            if state_changed is None:
                state_changed = not known_before or before_revision != after_revision
            if state_changed and not mutation_recorded and scheduler.publication_hub is not None:
                scheduler.publication_hub.record_mutation()
                mutation_recorded = True
            if after is None:
                if state_changed or not known_before:
                    await scheduler.reset(asset_id)
            elif after["exportEligible"] is True:
                if not known_before or before is None or before["currentRecipe"] != after["currentRecipe"] or \
                        before["exportEligible"] is not True:
                    # Ignore receipt-only saves and History changes that keep current settings.
                    scheduler.schedule(asset_id)
            elif state_changed and (not known_before or before is None or
                                    before["exportEligible"] is not False or
                                    before["currentRecipe"] != after["currentRecipe"] or
                                    after["exportEligible"] is None):
                # Keep reset fencing for Recipe/eligibility changes and uncertain eligibility,
                # but History-only writes in a known default state must not publish a reset.
                await scheduler.reset(asset_id)
        except Exception:
            if state_changed is not False and not mutation_recorded and scheduler.publication_hub is not None:
                scheduler.publication_hub.record_mutation()
            # A committed save stays successful even if derived-cache maintenance fails.
            thumbnail_log("saveNotification.failed", level="warn", component="thumbnail_scheduler",
                          assetId=str(asset_id), errorCode="thumbnail_maintenance_failed")
        return result
