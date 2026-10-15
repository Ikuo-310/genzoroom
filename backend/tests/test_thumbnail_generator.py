import asyncio
from copy import deepcopy
from io import BytesIO
from uuid import UUID, uuid4

import httpx
import pytest
from PIL import Image, JpegImagePlugin

import edit_store
import thumbnail_generator as generator
from edit_state import BOUNDS, FLAGS
from jpeg_codec import decode_jpeg

ASSET = UUID(int=1)


def snapshot(exposure=1, version=18):
    recipe = {"version": version, "adjustments": dict.fromkeys(BOUNDS, 0),
              **dict.fromkeys(FLAGS, True)}
    recipe["adjustments"]["exposure"] = exposure
    if version == 18:
        recipe["adjustmentEnabled"] = dict.fromkeys(BOUNDS, True)
    return {"stateFormatVersion": 2, "recipeVersion": version,
            "processingVersion": "jpeg-preview-srgb8-v1", "currentRecipe": recipe,
            "history": [], "historyCursor": 0,
            "sourceIdentity": {"provider": "immich", "assetId": str(ASSET),
                               "inputKind": "immich-preview"}}


def jpeg(size=(32, 16), format="JPEG"):
    with Image.new("RGB", size, (80, 80, 80)) as image:
        output = BytesIO()
        image.save(output, format=format)
        return output.getvalue()


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "edits.db")
    edit_store.initialize_database()


def save(state, revision=0):
    return edit_store.put_edit_state(ASSET, revision, uuid4(), state)


def generate(content=None, media_type="image/jpeg", status=200):
    def handler(request):
        assert request.url.path == f"/api/assets/{ASSET}/thumbnail"
        assert request.url.params["size"] == "preview"
        return httpx.Response(status, content=content if content is not None else jpeg(),
                              headers={"content-type": media_type})
    return asyncio.run(generator.generate_thumbnail(
        ASSET, immich_url="http://immich.test", api_key="test-key",
        transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("size,expected", [((2048, 1024), (1024, 512)),
                                         ((800, 1600), (512, 1024)),
                                         ((32, 16), (32, 16))])
def test_output_and_preservation(db, size, expected):
    state = snapshot()
    before = deepcopy(state)
    saved = save(state)
    source = jpeg(size)
    original = bytes(source)
    result = generate(source, " Image/JPEG; charset=binary")
    with Image.open(BytesIO(result)) as image:
        assert image.format == "JPEG" and image.size == expected
        assert image.mode == "RGB" and image.info["icc_profile"]
        assert JpegImagePlugin.get_sampling(image) == 0
    assert decode_jpeg(result).pixels[0] > decode_jpeg(source).pixels[0]
    assert source == original and state == before
    assert edit_store.get_edit_state(ASSET) == saved


@pytest.mark.parametrize("kind,code", [("missing", "recipe_missing"),
                                      ("default", "recipe_default"),
                                      ("history", "recipe_default")])
def test_ineligible_never_fetches(db, monkeypatch, kind, code):
    if kind != "missing":
        state = snapshot(0)
        if kind == "history":
            state["history"] = [{"kind": "exposure", "before": deepcopy(state["currentRecipe"]),
                                 "after": snapshot()["currentRecipe"]}]
        save(state)
    monkeypatch.setattr(generator, "get_asset_preview", lambda *a, **k: pytest.fail("unexpected fetch"))
    with pytest.raises(generator.ThumbnailGenerationError) as failure:
        generate()
    assert failure.value.code == code


@pytest.mark.parametrize("content,media,status,code", [
    (b"invalid", "image/jpeg", 200, "jpeg_decode_failed"),
    (jpeg(format="PNG"), "image/jpeg", 200, "jpeg_decode_failed"),
    (jpeg(format="PNG"), "image/png", 200, "unsupported_preview_format"),
    (jpeg(), "image/webp", 200, "unsupported_preview_format"),
    (jpeg(), "application/octet-stream", 200, "unsupported_preview_format"),
    (b"", "image/jpeg", 503, "preview_fetch_failed"),
])
def test_preview_failures(db, content, media, status, code):
    save(snapshot())
    with pytest.raises(generator.ThumbnailGenerationError) as failure:
        generate(content, media, status)
    assert failure.value.code == code


@pytest.mark.parametrize("target,code", [("JpegRenderer.render", "recipe_processing_failed"),
                                        ("encode_jpeg", "jpeg_encode_failed"),
                                        ("get_edit_state", "recipe_load_failed")])
def test_stage_failure_preserves_cause_and_database(db, monkeypatch, target, code):
    save(snapshot())
    before = edit_store.get_edit_state(ASSET)
    error = RuntimeError("private failure text")
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(f"thumbnail_generator.{target}", fail)
    with pytest.raises(generator.ThumbnailGenerationError) as failure:
        generate()
    assert failure.value.code == code and failure.value.__cause__ is error
    assert edit_store.get_edit_state(ASSET) == before


def test_reads_latest_recipe_and_supports_v17(db):
    save(snapshot(exposure=1, version=17))
    first = decode_jpeg(generate())
    saved = save(snapshot(exposure=2), revision=1)
    second = decode_jpeg(generate())
    assert second.pixels[0] > first.pixels[0]
    assert edit_store.get_edit_state(ASSET) == saved


def test_thumbnail_preview_renderer_uses_warm_positive_white_balance():
    recipe = snapshot(exposure=0)["currentRecipe"]
    recipe["adjustments"]["temperature"] = 100
    rendered = decode_jpeg(generator._render_preview(jpeg(), recipe))
    assert rendered.pixels[0] > rendered.pixels[2]


def test_resize_precedes_renderer(db, monkeypatch):
    save(snapshot())
    original = generator.JpegRenderer.render
    def render(self, source, recipe):
        assert (source.width, source.height) == (1024, 512)
        return original(self, source, recipe)
    monkeypatch.setattr(generator.JpegRenderer, "render", render)
    generate(jpeg((2048, 1024)))


def test_invalid_recipe_is_validated_before_fetch(db, monkeypatch):
    state = snapshot()
    state["currentRecipe"]["adjustments"]["exposure"] = 99
    monkeypatch.setattr(generator, "get_edit_state", lambda asset_id: {"state": state})
    monkeypatch.setattr(generator, "get_asset_preview", lambda *a, **k: pytest.fail("unexpected fetch"))
    with pytest.raises(generator.ThumbnailGenerationError) as failure:
        generate()
    assert failure.value.code == "recipe_load_failed"


def test_diagnostics_failure_does_not_change_generation(db, monkeypatch):
    save(snapshot())
    def fail(**kwargs):
        raise RuntimeError("logger unavailable")
    monkeypatch.setattr(generator.backend_logger, "add", fail)
    assert decode_jpeg(generate()).width == 32
