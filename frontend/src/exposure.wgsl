struct Parameters {
  gain: f32,
  pixel_count: u32,
  row_workgroups: u32,
  padding: u32,
}

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

fn expose(channel: u32) -> u32 {
  let srgb = f32(channel) / 255.0;
  var linear: f32;
  if (srgb <= 0.04045) {
    linear = srgb / 12.92;
  } else {
    linear = pow((srgb + 0.055) / 1.055, 2.4);
  }
  let exposed = min(1.0, linear * parameters.gain);
  var encoded: f32;
  if (exposed <= 0.0031308) {
    encoded = 12.92 * exposed;
  } else {
    encoded = 1.055 * pow(exposed, 1.0 / 2.4) - 0.055;
  }
  // CPU Math.round rounds nonnegative half values up; WGSL round uses ties-to-even.
  return u32(floor(255.0 * clamp(encoded, 0.0, 1.0) + 0.5));
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>,
        @builtin(local_invocation_index) local_index: u32) {
  let index = (group.y * parameters.row_workgroups + group.x) * 64u + local_index;
  if (index >= parameters.pixel_count) { return; }
  let rgba = source[index];
  // Identity must retain bytes without a floating-point decode/encode round trip.
  if (parameters.gain == 1.0) {
    output[index] = rgba;
    return;
  }
  output[index] = expose(rgba & 255u)
    | (expose((rgba >> 8u) & 255u) << 8u)
    | (expose((rgba >> 16u) & 255u) << 16u)
    | (rgba & 0xff000000u);
}
