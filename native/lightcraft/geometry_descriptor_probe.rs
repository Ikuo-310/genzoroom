// Test-only investigation: reconstruct the existing descriptor and prove its bytes hash to frame_metadata's ID.
use super::*;
use lightcraft_engine::pipeline::geometry::Frame;
use sha2::{Digest, Sha256};

struct Sample {
    descriptor: Value,
    summary: Value,
}

fn capture(
    frame: &Frame,
    original: (usize, usize),
    source: &str,
    level: &str,
    width: usize,
    height: usize,
) -> Sample {
    let warp = frame.warp.as_ref().filter(|w| w.moves_pixels()).map(|w| {
        let mut lens = w.lens;
        if let Some(l) = &mut lens {
            l.vignette = None;
        }
        json!({"perspective":w.persp,"k1":w.k1,"ca":w.ca,
            "lens":if w.lens_dist == 0.0 {None} else {lens},"lensDist":w.lens_dist})
    });
    let native = frame.native_size_at(original.0, original.1).unwrap();
    let descriptor = json!({"contract":2,"source":source,"original":[original.0,original.1],
        "nativeAspect":native.0/native.1,
        "orientation":frame.orient,"crop":frame.crop,"flip":[frame.flip_h,frame.flip_v],"warp":warp});
    let metadata = crate::preview::frame_metadata(frame, original, source, width, height)
        .unwrap_or_else(|_| panic!("diagnostic frame metadata rejected"));
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&descriptor).unwrap())
    );
    assert!(
        metadata["geometryId"].as_str() == Some(digest.as_str()),
        "descriptor reconstruction must match production hash bytes"
    );
    let mut safe = descriptor.clone();
    safe.as_object_mut().unwrap().remove("source");
    Sample {
        descriptor,
        summary: json!({"sourceLevel":level,"sourceKind":"Hash128(content_key(photo))",
        "sourceBitmap":[frame.src_w,frame.src_h],"nativeWidth":metadata["nativeWidth"],"nativeHeight":metadata["nativeHeight"],
        "fullWidth":width,"fullHeight":height,"nativeAspect":safe["nativeAspect"],
        "samplingAspect":frame.src_w as f64/frame.src_h as f64,"frameAspect":frame.aspect(),
        "quality":"Full","descriptor":safe}),
    }
}

fn source_kind(source: &SourceRef) -> &'static str {
    match source {
        SourceRef::Loaded(_) => "Loaded",
        SourceRef::Fit { .. } => "Fit",
        SourceRef::File { .. } => "File",
        SourceRef::Demo { .. } => "Demo",
        SourceRef::Smart { .. } => "Smart",
    }
}

fn same_hash_input(a: &Value, b: &Value) -> bool {
    // Numeric equality would hide signed-zero differences in the serialized hash input.
    serde_json::to_vec(a).unwrap() == serde_json::to_vec(b).unwrap()
}

fn differences(a: &Value, b: &Value, prefix: &str, out: &mut Vec<String>) {
    if same_hash_input(a, b) {
        return;
    }
    if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
        let mut keys: Vec<_> = a.keys().chain(b.keys()).collect();
        keys.sort();
        keys.dedup();
        for key in keys {
            let field = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            differences(
                a.get(key).unwrap_or(&Value::Null),
                b.get(key).unwrap_or(&Value::Null),
                &field,
                out,
            );
        }
    } else if let (Some(a), Some(b)) = (a.as_array(), b.as_array()) {
        if a.len() != b.len() {
            out.push(prefix.to_string());
            return;
        }
        for (index, (a, b)) in a.iter().zip(b).enumerate() {
            differences(a, b, &format!("{prefix}[{index}]"), out);
        }
    } else {
        out.push(prefix.to_string());
    }
}

fn comparison(a: &Sample, b: &Sample) -> Value {
    let mut fields = Vec::new();
    differences(&a.descriptor, &b.descriptor, "", &mut fields);
    let status: serde_json::Map<String, Value> = [
        "source",
        "original",
        "nativeAspect",
        "orientation",
        "crop",
        "flip",
        "warp",
    ]
    .into_iter()
    .map(|key| {
        (
            key.to_string(),
            json!(if same_hash_input(&a.descriptor[key], &b.descriptor[key]) {
                "identical"
            } else {
                "different"
            }),
        )
    })
    .collect();
    json!({"differenceFields":fields,"fieldStatus":status,"sourceMatches":a.descriptor["source"] == b.descriptor["source"],
        "nativeDimensionsMatch":a.summary["nativeWidth"] == b.summary["nativeWidth"] && a.summary["nativeHeight"] == b.summary["nativeHeight"]})
}

fn plan_sample(h: &mut Headless, id: PhotoId, edge: usize) -> Sample {
    let p = h.session.catalog.photo(id).unwrap();
    let original = (p.width as usize, p.height as usize);
    let mut job = h.session.render_job(id, edge, edge, false, true).unwrap();
    let source_key = format!("{:?}", job.source_key.unwrap());
    let level = format!("{:?}", job.level);
    let reference = source_kind(&job.source);
    let decoded = job
        .source
        .load_source()
        .unwrap_or_else(|_| panic!("diagnostic source decode failed"));
    let source = decoded.image_for(job.settings.denoise_amount());
    let info = decoded.info_or(job.info.clone());
    let mut plan = pipeline::plan(&source, &info, &job.settings, &job.request);
    let native = plan.frame.native_size_at(original.0, original.1).unwrap();
    let (nw, nh) = (
        native.0.round().max(1.0) as usize,
        native.1.round().max(1.0) as usize,
    );
    if plan.w > nw || plan.h > nh {
        drop(plan);
        job.request.max_w = job.request.max_w.min(nw);
        job.request.max_h = job.request.max_h.min(nh);
        plan = pipeline::plan(&source, &info, &job.settings, &job.request);
    }
    let mut sample = capture(&plan.frame, original, &source_key, &level, plan.w, plan.h);
    sample.summary["sourceInfoRaw"] = json!(info.raw);
    sample.summary["decodedLensPresent"] = json!(info.lens.is_some());
    sample.summary["sourceRefKind"] = json!(reference);
    sample
}

fn whole_sample(h: &mut Headless, id: PhotoId, edge: usize) -> Sample {
    let p = h.session.catalog.photo(id).unwrap();
    let original = (p.width as usize, p.height as usize);
    let job = h.session.render_job(id, edge, edge, false, true).unwrap();
    let source_key = format!("{:?}", job.source_key.unwrap());
    let level = format!("{:?}", job.level);
    let reference = source_kind(&job.source);
    let source_ref = job.source.clone();
    let header_info = job.info.clone();
    let result = job.run();
    h.session.accept(&result);
    let rendered = result
        .rendered
        .as_ref()
        .unwrap_or_else(|_| panic!("diagnostic Whole render failed"));
    let loaded = result.loaded.clone().unwrap_or_else(|| {
        source_ref
            .load_source()
            .unwrap_or_else(|_| panic!("diagnostic cached source inspection failed"))
    });
    let info = loaded.info_or(header_info);
    let mut sample = capture(
        rendered.frame.as_ref().unwrap(),
        original,
        &source_key,
        &level,
        rendered.image.width,
        rendered.image.height,
    );
    sample.summary["execution"] = serde_json::to_value(&rendered.execution).unwrap();
    sample.summary["sourceInfoRaw"] = json!(info.raw);
    sample.summary["decodedLensPresent"] = json!(info.lens.is_some());
    sample.summary["sourceRefKind"] = json!(reference);
    sample
}

fn command(h: &mut Headless, command: &str, params: Value) -> Value {
    h.call("engine.execute", json!({"command":command,"params":params}))
        .unwrap_or_else(|_| panic!("diagnostic command failed (private details suppressed)"))
}

fn fixture(preview: (usize, usize)) -> Value {
    let mut h = host_size(DevelopSettings::default(), 4064, 3056);
    for (level, width, height) in [
        (SourceLevel::Thumb, 508, 382),
        (SourceLevel::Preview, preview.0, preview.1),
        (SourceLevel::Full, 4064, 3056),
    ] {
        h.session.media.insert(
            PhotoId(1),
            level,
            Arc::new(Rgb32f::from_fn(width, height, |_, _| [0.1; 3])),
        );
    }
    let thumb = plan_sample(&mut h, PhotoId(1), 256);
    let whole = whole_sample(&mut h, PhotoId(1), 2048);
    let region = plan_sample(&mut h, PhotoId(1), 4064);
    json!({"thumb":thumb.summary,"whole2048":whole.summary,"region4064":region.summary,
        "thumbToFull":comparison(&thumb,&region),"wholeToRegion":comparison(&whole,&region)})
}

#[test]
fn descriptor_comparison_detects_fields_deterministically_and_redacts_private_source() {
    let input =
        json!({"source":"private-source-token","sourceAspect":1.25,"crop":{"rect":{"x1":1.0}}});
    let changed =
        json!({"source":"other-private-token","sourceAspect":1.3,"crop":{"rect":{"x1":0.9}}});
    let mut first = Vec::new();
    differences(&input, &changed, "", &mut first);
    let mut second = Vec::new();
    differences(&input, &changed, "", &mut second);
    assert_eq!(first, second);
    assert_eq!(first, vec!["crop.rect.x1", "source", "sourceAspect"]);
    let mut signed_zero = Vec::new();
    differences(
        &json!({"warp":{"k1":-0.0}}),
        &json!({"warp":{"k1":0.0}}),
        "",
        &mut signed_zero,
    );
    assert_eq!(signed_zero, vec!["warp.k1"]);
    let mut safe = input;
    safe.as_object_mut().unwrap().remove("source");
    assert!(!safe.to_string().contains("private-source-token"));
}

#[test]
fn investigate_geometry_descriptors() {
    let Some(input_path) = std::env::var_os("GENZOROOM_GEOMETRY_PROBE_INPUT") else {
        return;
    };
    let input: Value = serde_json::from_slice(&std::fs::read(input_path).unwrap()).unwrap();
    let backend = std::env::var("LIGHTCRAFT_GPU_BACKEND").unwrap_or_else(|_| "off".into());
    lightcraft_engine::gpu::set_enabled(backend == "dx12");
    if backend == "dx12" {
        assert!(
            lightcraft_engine::gpu::available(),
            "DX12 descriptor cross-check requires an adapter"
        );
    }
    let mut h = Headless::default();
    command(&mut h, "app.memoryBudget", json!({"mb":1024}));
    let mut selected = None;
    for source in input["sourcePaths"].as_array().unwrap() {
        let imported = command(
            &mut h,
            "library.import",
            json!({"paths":[source],"mode":"add"}),
        );
        for candidate in imported["imported"].as_array().unwrap() {
            let id = PhotoId(candidate.as_u64().unwrap());
            let p = h.session.catalog.photo(id).unwrap();
            if p.content_hash.as_deref() == input["expectedContentHash"].as_str() {
                selected = Some(id);
            }
        }
    }
    let id = selected.expect("exact cached RAW content did not match persisted recipe");
    command(
        &mut h,
        "library.select",
        json!({"ids":[id.0],"active":id.0,"mode":"replace"}),
    );
    command(&mut h, "beforeAfter.setBefore", json!({"source":"import"}));
    command(&mut h, "develop.reset", json!({"ids":[id.0]}));
    command(
        &mut h,
        "develop.merge",
        json!({"settings":input["settings"]}),
    );
    let initial = h.session.develop_of(id).unwrap().hash64();
    let restored = serde_json::to_value(h.session.develop_of(id).unwrap()).unwrap();
    assert!(
        restored == input["settings"],
        "restored settings must exactly match persisted Recipe"
    );
    let thumb = plan_sample(&mut h, id, 256);
    let first = whole_sample(&mut h, id, 1024);
    let second = whole_sample(&mut h, id, 1472);
    let whole = whole_sample(&mut h, id, 2048);
    let region = plan_sample(&mut h, id, 4064);
    assert_eq!(whole.summary["sourceLevel"], json!("Preview"));
    assert_eq!(region.summary["sourceLevel"], json!("Full"));
    assert_eq!(
        whole.summary["nativeAspect"],
        region.summary["nativeAspect"]
    );
    assert_ne!(
        whole.summary["samplingAspect"],
        region.summary["samplingAspect"]
    );
    assert_eq!(whole.summary["sourceInfoRaw"], json!(true));
    assert_eq!(region.summary["sourceInfoRaw"], json!(true));
    if backend == "dx12" {
        assert_eq!(whole.summary["execution"]["outcome"], json!("gpu_success"));
    }
    let mut query = target(&mut h, false);
    query["geometryId"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&whole.descriptor).unwrap())
    ));
    query["desiredLongEdge"] = json!(4064);
    // The shared synthetic helper defaults to photo 1; the matched private RAW may have another ID.
    let mut plan_args = tool_args("plan", query.clone());
    plan_args["id"] = json!(id.0.to_string());
    let planned = crate::region::execute(&mut h, &plan_args)
        .unwrap_or_else(|_| panic!("canonical preflight failed"));
    assert_eq!(planned["response"]["geometryId"], query["geometryId"]);
    assert_eq!(
        (
            planned["response"]["fullWidth"].as_u64(),
            planned["response"]["fullHeight"].as_u64()
        ),
        (Some(4064), Some(3056))
    );
    query["geometryId"] = json!("0".repeat(64));
    plan_args["target"] = query;
    let rejection = crate::region::execute(&mut h, &plan_args);
    assert!(
        matches!(rejection, Err("region_geometry_id_mismatch")),
        "existing Native mismatch rejection must remain active"
    );
    let mut optics = serde_json::Map::new();
    for key in [
        "lens_profile",
        "remove_ca",
        "profile_distortion",
        "distortion",
        "ca_red",
        "ca_blue",
    ] {
        optics.insert(key.to_string(), restored["optics"][key].clone());
    }
    let proportional = fixture((2032, 1528));
    let rounded = fixture((2560, 1925));
    assert_eq!(proportional["wholeToRegion"]["differenceFields"], json!([]));
    assert_eq!(rounded["wholeToRegion"]["differenceFields"], json!([]));
    assert_ne!(
        rounded["whole2048"]["samplingAspect"],
        rounded["region4064"]["samplingAspect"]
    );
    let report = json!({"schemaVersion":2,"geometryDescriptorContract":2,"backend":backend,"realRawReproduced":true,"recipeRevision":input["recipeRevision"],
        "settingsExactlyRestored":true,"settingsUnchanged":initial == h.session.develop_of(id).unwrap().hash64(),
        "geometrySettings":{"crop":restored["crop"],"orientation":restored["orientation"],"geometry":restored["geometry"],"optics":optics},
        "realRaw":{"thumb":thumb.summary,"whole1024":first.summary,"whole1472":second.summary,"whole2048":whole.summary,"region4064":region.summary,
            "wholeToRegion":comparison(&whole,&region),"thumbToFull":comparison(&thumb,&region),"nativePlanSucceeded":true,
            "actualF":[4064,3056],"nativeMismatchGuardRetained":true},
        "fixtures":{"proportional":proportional,"roundedPreview":rounded}});
    let serialized = serde_json::to_string_pretty(&report).unwrap();
    for source in input["sourcePaths"].as_array().unwrap() {
        assert!(!serialized.contains(source.as_str().unwrap()));
    }
    assert!(!serialized.contains(input["expectedContentHash"].as_str().unwrap()));
    std::fs::write(
        std::env::var_os("GENZOROOM_GEOMETRY_PROBE_OUTPUT").unwrap(),
        serialized,
    )
    .unwrap();
}
