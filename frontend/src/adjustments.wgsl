struct Parameters {
  pixel_count: u32,
  row_workgroups: u32,
  padding: vec2<u32>,
  tones: vec4<f32>,
  vibrance: f32,
  saturation_factor: f32,
  grading_flags: u32,
  padding2: u32,
  grading: array<vec4<f32>, 3>,
}
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<uniform> p: Parameters;
@group(0) @binding(3) var<storage, read> luts: array<u32>;

fn bytes(rgb: vec3<f32>) -> vec3<f32> {
  // Math.round for nonnegative values, not WGSL's ties-to-even round.
  return floor(clamp(rgb, vec3(0.0), vec3(1.0)) * 255.0 + vec3(0.5));
}
fn luminance(rgb: vec3<f32>) -> f32 {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}
fn smooth(position: f32) -> f32 {
  let x = clamp(position, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}
fn gain_byte(channel: f32, gain: f32) -> f32 {
  let srgb = channel / 255.0;
  var linear: f32;
  if (srgb <= 0.04045) { linear = srgb / 12.92; }
  else { linear = pow((srgb + 0.055) / 1.055, 2.4); }
  let shifted = clamp(linear * gain, 0.0, 1.0);
  var encoded: f32;
  if (shifted <= 0.0031308) { encoded = 12.92 * shifted; }
  else { encoded = 1.055 * pow(shifted, 1.0 / 2.4) - 0.055; }
  return floor(255.0 * clamp(encoded, 0.0, 1.0) + 0.5);
}
fn grade(input: vec3<f32>, range: u32) -> vec3<f32> {
  let flags = (p.grading_flags >> (range * 2u)) & 3u;
  if (flags == 0u) { return input; }
  let y = luminance(input / 255.0);
  var weight: f32;
  if (range == 0u) { weight = 1.0 - smooth((y - 0.15) / (0.35 - 0.15)); }
  else if (range == 1u) {
    weight = smooth((y - 0.15) / (0.35 - 0.15)) * (1.0 - smooth((y - 0.60) / (0.78 - 0.60)));
  } else { weight = smooth((y - 0.55) / (0.75 - 0.55)); }
  if (weight <= 0.0) { return input; }
  let gains = p.grading[range];
  var result = input;
  // Both stages use pre-Temperature weight, but Tint decodes the rounded Temperature bytes.
  if ((flags & 1u) != 0u) {
    result.r = gain_byte(result.r, pow(gains.x, weight));
    result.b = gain_byte(result.b, pow(gains.y, weight));
  }
  if ((flags & 2u) != 0u) {
    let rb = pow(gains.z, weight);
    result = vec3(gain_byte(result.r, rb), gain_byte(result.g, pow(gains.w, weight)), gain_byte(result.b, rb));
  }
  return result;
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) local_index: u32) {
  let index = (group.y * p.row_workgroups + group.x) * 64u + local_index;
  if (index >= p.pixel_count) { return; }
  let rgba = source[index];
  var rgb = vec3<f32>(f32(rgba & 255u), f32((rgba >> 8u) & 255u), f32((rgba >> 16u) & 255u));
  // Separate lookup applications retain each CPU stage's 8-bit clip/round boundary.
  for (var stage = 0u; stage < 3u; stage++) {
    let base = stage * 256u;
    rgb = vec3(f32(luts[base + u32(rgb.r)] & 255u),
      f32((luts[base + u32(rgb.g)] >> 8u) & 255u), f32((luts[base + u32(rgb.b)] >> 16u) & 255u));
  }
  if (p.tones.x != 0.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    if (y > 0.5) {
      let weight = smooth((y - 0.5) * 2.0);
      var curved = y * y;
      if (p.tones.x > 0.0) { curved = 1.0 - (1.0 - y) * (1.0 - y); }
      let target = clamp(y + abs(p.tones.x) * weight * (curved - y), 0.0, 1.0);
      rgb = bytes(color * (target / y));
    }
  }
  if (p.tones.y != 0.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    if (y > 0.75) {
      let weight = smooth((y - 0.75) / (1.0 - 0.75));
      var target = 0.75;
      if (p.tones.y > 0.0) { target = 1.0; }
      let adjusted = clamp(y + abs(p.tones.y) * weight * (target - y), 0.0, 1.0);
      rgb = bytes(color * (adjusted / max(y, 1e-6)));
    }
  }
  if (p.tones.z != 0.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    if (y < 0.15) {
      let weight = smooth((0.15 - y) / 0.15);
      var target = y * y;
      if (p.tones.z > 0.0) { target = sqrt(y); }
      let amount = abs(p.tones.z) * weight;
      let adjusted = clamp(y + amount * (target - y), 0.0, 1.0);
      rgb = bytes(color * (adjusted / max(y, 1e-6)));
    }
  }
  if (p.tones.w != 0.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    if (y < 0.35) {
      let weight = 1.0 - smooth(y / 0.35);
      let adjusted = clamp(y + p.tones.w * 0.1 * weight, 0.0, 1.0);
      if (y <= 1e-6) { rgb = vec3(floor(255.0 * adjusted + 0.5)); }
      else { rgb = bytes(color * (adjusted / y)); }
    }
  }
  rgb = grade(rgb, 0u);
  rgb = grade(rgb, 1u);
  rgb = grade(rgb, 2u);
  if (p.vibrance != 0.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    let distances = abs(color - vec3(y));
    let chroma = max(max(distances.r, distances.g), distances.b);
    let weight = 1.0 - clamp(chroma / 0.5, 0.0, 1.0);
    var strength = 0.6 * (0.25 + (1.0 - 0.25) * weight);
    if (p.vibrance > 0.0) { strength = 0.75 * weight; }
    let factor = 1.0 + p.vibrance * strength;
    rgb = bytes(vec3(y) + (color - vec3(y)) * factor);
  }
  if (p.saturation_factor != 1.0) {
    let color = rgb / 255.0;
    let y = luminance(color);
    rgb = bytes(vec3(y) + (color - vec3(y)) * p.saturation_factor);
  }
  output[index] = u32(rgb.r) | (u32(rgb.g) << 8u) | (u32(rgb.b) << 16u) | (rgba & 0xff000000u);
}
