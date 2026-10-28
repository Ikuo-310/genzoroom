"""Install explicit diagnostics in an isolated clone, never in a managed checkout or artifact."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

DIAGNOSTIC = r'''
//! Temporary Phase 6A-R instrumentation; absent from every managed artifact.
use std::io::Write;

fn control() -> Option<String> {
    std::env::var("GENZOROOM_REGION_CAUSE_CONTROL").ok().and_then(|p| std::fs::read_to_string(p).ok())
}
pub fn exact_guided() -> bool {
    control().is_some_and(|v| v.lines().any(|s| s == "guided=exact"))
}
pub fn air(plane: f32, proxy: Option<f32>, w: usize, h: usize, backend: &str) -> f32 {
    let current = proxy.unwrap_or(plane);
    let forced = control().and_then(|v| v.lines().find_map(|s| s.strip_prefix("air=").and_then(|s| s.parse::<f32>().ok()))).filter(|v| v.is_finite() && *v > 0.0);
    let used = forced.unwrap_or(current);
    // Record only bounded numerical diagnostics, never settings, source pixels or file identities.
    if let Ok(path) = std::env::var("GENZOROOM_REGION_CAUSE_TRACE") {
        if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(out, "{backend},{w},{h},{},{},{},{}", plane.to_bits(), proxy.map_or(0, f32::to_bits), current.to_bits(), used.to_bits());
        }
    }
    used
}
'''


def replace_once(path, old, new):
    source = path.read_text(encoding='utf-8')
    if source.count(old) != 1:
        raise ValueError(f'Expected exactly one diagnostic boundary: {path.name}')
    path.write_text(source.replace(old, new), encoding='utf-8')


def prepare(source, target):
    source, target = source.resolve(), target.resolve()
    if source == ROOT / '.tmp/lightcraft-0.14' or not source.is_relative_to(ROOT / '.tmp'):
        raise ValueError('Only a separate clone under .tmp is allowed')
    if not target.is_relative_to(ROOT / '.tmp') or target.is_relative_to(source):
        raise ValueError('Use a separate diagnostic target under .tmp')
    spec = importlib.util.spec_from_file_location('managed_build', ROOT / 'native/lightcraft/build.py')
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    manifest = build.manifest()
    if (source / 'crates/pipeline/src/region_cause.rs').exists():
        raise ValueError('Diagnostic already installed; do not duplicate it')
    build.prepare(source, manifest, apply=True)
    (target / 'release/lightcraft-cli.genzoroom.json').unlink(missing_ok=True)
    pipeline = source / 'crates/pipeline/src'
    replace_once(pipeline / 'lib.rs', 'pub mod local;', 'pub mod local;\npub mod region_cause;')
    block = 'if let Some(a) = plan.fixed_air {\n        prep.air = a;\n    }'
    replace_once(pipeline / 'lib.rs', block,
                 'prep.air = crate::region_cause::air(prep.air, plan.fixed_air, w, h, "cpu");')
    replace_once(source / 'crates/gpu/src/render.rs', block,
                 'prep.air = lightcraft_pipeline::region_cause::air(prep.air, plan.fixed_air, w, h, "dx12");')
    replace_once(pipeline / 'local.rs', 'pub fn guided_fast_step(sigma: f32) -> usize {',
                 'pub fn guided_fast_step(sigma: f32) -> usize {\n    if crate::region_cause::exact_guided() { return 1; }')
    (pipeline / 'region_cause.rs').write_text(DIAGNOSTIC, encoding='utf-8')
    # These diagnostics are not attested as a production artifact and get no managed receipt.
    provenance = {'version': manifest['version'], 'upstreamCommit': manifest['commit'],
        'managedPatches': manifest['patches'], 'diagnosticModuleSha256': hashlib.sha256(DIAGNOSTIC.encode()).hexdigest(),
        'diagnosticDiff': subprocess.check_output(['git', 'diff', '--', 'crates/pipeline/src/lib.rs',
            'crates/pipeline/src/local.rs', 'crates/gpu/src/render.rs'], cwd=source, text=True)}
    (source / 'region-cause-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.target)
    subprocess.run(['cargo', 'build', '--offline', '--locked', '--release', '--no-default-features',
        '-p', 'lightcraft-cli', '--target-dir', str(args.target.resolve())], cwd=args.source, check=True)


if __name__ == '__main__':
    main()
