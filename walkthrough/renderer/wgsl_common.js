// Shared WGSL snippets composed into the project's shaders.
//
// Each export is a string of WGSL function/struct/const declarations.
// Renderer modules import the snippets they need and template them
// into their full shader source. No imports, no preprocessor — just
// concatenation, which is what WGSL allows.
//
// Convention: snippets are SELF-CONTAINED (don't depend on bindings
// or struct fields from the host shader). When something *does* need
// host context — e.g. `surface_normal` depends on a `world_pos(uv)`
// function existing — say so in the snippet's leading comment.
//
// A future build-time pass (using wgsl_reflect) can validate that
// every renderer's assembled WGSL parses cleanly and avoids reserved
// keywords; for now, see RESERVED_WORDS below for a manual sweep.

// ---------- color ----------

// Magma-style 5-stop perceptual ramp: indigo → magenta → orange →
// peach → cream. Argument t is normalized to [0, 1].
export const COLORMAP_MAGMA = `
fn colormap(t: f32) -> vec3<f32> {
  let c = clamp(t, 0.0, 1.0);
  let s0 = vec3<f32>(0.020, 0.015, 0.118);
  let s1 = vec3<f32>(0.392, 0.090, 0.412);
  let s2 = vec3<f32>(0.851, 0.345, 0.337);
  let s3 = vec3<f32>(0.988, 0.760, 0.541);
  let s4 = vec3<f32>(0.988, 0.992, 0.749);
  let t4 = c * 4.0;
  let i = floor(t4);
  let f = fract(t4);
  if (i < 1.0) { return mix(s0, s1, f); }
  if (i < 2.0) { return mix(s1, s2, f); }
  if (i < 3.0) { return mix(s2, s3, f); }
  return mix(s3, s4, f);
}
`;

// HSV → RGB, hue in [0, 1] (will be fract-ed), saturation/value in [0, 1].
export const HSV_TO_RGB = `
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let h6 = fract(h) * 6.0;
  let c = v * s;
  let x = c * (1.0 - abs(h6 - 2.0 * floor(h6 * 0.5) - 1.0));
  var rgb: vec3<f32>;
  if (h6 < 1.0) { rgb = vec3<f32>(c, x, 0.0); }
  else if (h6 < 2.0) { rgb = vec3<f32>(x, c, 0.0); }
  else if (h6 < 3.0) { rgb = vec3<f32>(0.0, c, x); }
  else if (h6 < 4.0) { rgb = vec3<f32>(0.0, x, c); }
  else if (h6 < 5.0) { rgb = vec3<f32>(x, 0.0, c); }
  else { rgb = vec3<f32>(c, 0.0, x); }
  let m = v - c;
  return rgb + vec3<f32>(m, m, m);
}
`;

// ---------- zeta ----------

// Complex-valued ζ(σ + i·t) via Dirichlet-eta truncated at 200 terms,
// then divided by (1 − 2^(1−s)). Valid on Re(s) > 0. Returns the
// complex value as a vec2<f32> (real, imag).
//
// 200 terms gives ~3 decimal digits of accuracy for |t| ≲ 50 on
// the critical line; bump the loop bound for higher precision at
// the cost of vertex/fragment throughput.
export const ZETA_COMPLEX_DIRICHLET_ETA = `
fn zeta_complex(sigma: f32, t: f32) -> vec2<f32> {
  var re: f32 = 0.0;
  var im: f32 = 0.0;
  let log2 = 0.6931472;
  for (var n: u32 = 1u; n <= 200u; n = n + 1u) {
    let nf = f32(n);
    let log_n = log(nf);
    let mag = exp(-sigma * log_n);
    let phase = -t * log_n;
    let s = select(-1.0, 1.0, (n & 1u) == 1u);
    re = re + s * mag * cos(phase);
    im = im + s * mag * sin(phase);
  }
  let pow_factor = exp((1.0 - sigma) * log2);
  let two_phase = -t * log2;
  let d_re = 1.0 - pow_factor * cos(two_phase);
  let d_im = -pow_factor * sin(two_phase);
  let d_norm = d_re * d_re + d_im * d_im;
  return vec2<f32>(
    (re * d_re + im * d_im) / d_norm,
    (im * d_re - re * d_im) / d_norm,
  );
}
`;

// Requires ZETA_COMPLEX_DIRICHLET_ETA to be in scope.
export const ZETA_MODULUS = `
fn zeta_modulus(sigma: f32, t: f32) -> f32 {
  let z = zeta_complex(sigma, t);
  return sqrt(z.x * z.x + z.y * z.y);
}
`;

// Partial Euler product ζ_K(s) = ∏_{n=1..K} (1 − p_n^-s)^-1.
//
// REQUIRES: a `primes: array<f32>` storage binding at @group(0)
// @binding(1) — see EULER_PRIMES_BINDING. Clamp K to 100 (the
// vendored prime table length).
export const EULER_PRIMES_BINDING = `
@group(0) @binding(1) var<storage, read> primes: array<f32>;
`;

export const ZETA_EULER_PRODUCT = `
fn partial_euler(K: u32, sigma: f32, t: f32) -> vec2<f32> {
  var re: f32 = 1.0;
  var im: f32 = 0.0;
  let kclamp = min(K, 100u);
  for (var k: u32 = 0u; k < kclamp; k = k + 1u) {
    let p = primes[k];
    let lp = log(p);
    let pms = exp(-sigma * lp);
    let ct = cos(t * lp);
    let st = sin(t * lp);
    let a = 1.0 - pms * ct;
    let b = pms * st;
    let n2 = a * a + b * b;
    let inv_re =  a / n2;
    let inv_im = -b / n2;
    let new_re = re * inv_re - im * inv_im;
    let new_im = re * inv_im + im * inv_re;
    re = new_re;
    im = new_im;
  }
  return vec2<f32>(re, im);
}

fn euler_error_log(K: u32, sigma: f32, t: f32) -> f32 {
  let zeta_p = partial_euler(K, sigma, t);
  let zeta_t = zeta_complex(sigma, t);
  let err = zeta_p - zeta_t;
  let mag = sqrt(err.x * err.x + err.y * err.y);
  return -log(mag + 1e-9) / log(10.0);
}
`;

// ---------- 3D rendering helpers ----------

// Central-difference surface normal in world space.
// REQUIRES a host-defined `world_pos(uv: vec2<f32>) -> vec3<f32>`.
export const SURFACE_NORMAL_CENTRAL_DIFF = `
fn surface_normal(uv: vec2<f32>) -> vec3<f32> {
  let eps = 0.008;
  let p_px = world_pos(uv + vec2<f32>(eps, 0.0));
  let p_mx = world_pos(uv - vec2<f32>(eps, 0.0));
  let p_py = world_pos(uv + vec2<f32>(0.0, eps));
  let p_my = world_pos(uv - vec2<f32>(0.0, eps));
  return normalize(cross(p_px - p_mx, p_py - p_my));
}
`;

// Two-key Phong: warm primary, cool fill, ambient floor + specular.
// `base` is the unlit color, `N` is the normal (assumed normalized),
// `V` is the view direction toward the eye.
export const PHONG_TWO_KEY = `
fn phong_two_key(base: vec3<f32>, N: vec3<f32>, V: vec3<f32>) -> vec3<f32> {
  let L1 = normalize(vec3<f32>( 0.6,  0.4, 1.0));
  let L2 = normalize(vec3<f32>(-0.7, -0.3, 0.6));
  let diff = max(dot(N, L1), 0.0) * 0.7
           + max(dot(N, L2), 0.0) * 0.3;
  let H1 = normalize(L1 + V);
  let spec = pow(max(dot(N, H1), 0.0), 24.0) * 0.35;
  let ambient = 0.30;
  return base * (ambient + 0.8 * diff) + vec3<f32>(spec);
}
`;

// ---------- texture / contour helpers ----------

// fwidth-based antialiased contour line at fract(coord) === 0.5.
// Returns 1.0 in cell interior, → 0.0 at the line. Use to multiply
// `base * mix(0.55, 1.0, contour_at(...))`.
export const CONTOUR_FWIDTH = `
fn contour_at(coord: f32, line_width_pixels: f32) -> f32 {
  let f = abs(fract(coord) - 0.5);
  let w = fwidth(coord) * line_width_pixels;
  return smoothstep(0.0, max(w, 1e-6), f);
}
`;

// 2D grid factor for domain ticks: 1 in cells, 0 on lines.
// `p` in data units, `step` per-axis line spacing.
export const GRID_FACTOR_2D = `
fn grid_factor(p: vec2<f32>, step: vec2<f32>) -> f32 {
  let q = p / step;
  let f = abs(fract(q) - 0.5);
  let w = fwidth(q) * 1.2;
  let m = min(f.x / max(w.x, 0.0001), f.y / max(w.y, 0.0001));
  return smoothstep(0.0, 1.0, m);
}
`;

// Background-fade for the lowest fraction of normalized height.
// `t` is normalized height in [0, 1].
export const FLOOR_FADE = `
fn floor_fade(t: f32, bg: vec3<f32>, lit: vec3<f32>, frac: f32) -> vec3<f32> {
  let mask = smoothstep(0.0, frac, t);
  return mix(bg, lit, mask);
}
`;

// ---------- WGSL reserved words (manual lint) ----------
//
// Run validateNoReservedIdentifiers(wgsl) before shipping to catch
// the same class of bug as the `final` and `meta` regressions.
// This list is conservative; check the WGSL spec
// (https://www.w3.org/TR/WGSL/#reserved-words) for the canonical
// listing. It does not catch all problems (e.g. type confusion) but
// catches the ones we've actually hit.

const RESERVED_WORDS = new Set([
  // Per WGSL §6.4 reserved words (selected — the ones likely to
  // collide with variable/struct field naming).
  "abstract", "alignas", "asm", "atomic_compare_exchange_strong",
  "atomic_compare_exchange_weak", "auto", "await", "become",
  "binding_array", "cast", "catch", "class", "co_await", "co_return",
  "co_yield", "coherent", "column_major", "common", "compile",
  "compile_fragment", "concept", "const_cast", "consteval", "constexpr",
  "constinit", "crate", "debugger", "decltype", "delete", "demote",
  "demote_to_helper", "do", "dynamic_cast", "enum", "explicit",
  "export", "extends", "extern", "external", "fallthrough", "filter",
  "final", "finally", "friend", "from", "fxgroup", "get", "goto",
  "groupshared", "highp", "impl", "implements", "import", "inline",
  "instanceof", "interface", "layout", "lowp", "macro", "macro_rules",
  "match", "mediump", "meta", "mod", "module", "move", "mut", "mutable",
  "namespace", "new", "nil", "noexcept", "noinline", "nointerpolation",
  "non_coherent", "noncoherent", "noperspective", "null", "nullptr",
  "of", "operator", "package", "packoffset", "partition", "pass",
  "patch", "pixelfragment", "precise", "precision", "premerge",
  "priv", "protected", "pub", "public", "readonly", "ref", "regardless",
  "register", "reinterpret_cast", "require", "resource", "restrict",
  "self", "set", "shared", "sizeof", "smooth", "snorm", "static",
  "static_assert", "static_cast", "std", "subroutine", "super",
  "target", "template", "this", "thread_local", "throw", "trait",
  "try", "type", "typedef", "typeid", "typename", "typeof", "union",
  "unless", "unorm", "unsafe", "unsized", "use", "using", "varying",
  "virtual", "volatile", "wgsl", "where", "with", "writeonly", "yield",
]);

// Quick check: scan WGSL source for identifiers that match a reserved
// word. Returns array of {word, line} for any hits. Identifiers
// inside string literals and comments would be ignored if we did a
// real parse; for the lint level here, we strip line-comments and
// block-comments and scan the rest. Tolerable false-positive rate
// for our use case.
export function validateNoReservedIdentifiers(wgsl) {
  const stripped = wgsl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const hits = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
    for (const word of matches) {
      if (RESERVED_WORDS.has(word)) {
        hits.push({ word, line: i + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

// Convenience: throw if any reserved identifiers found.
export function assertNoReservedIdentifiers(wgsl, label) {
  const hits = validateNoReservedIdentifiers(wgsl);
  if (hits.length === 0) return;
  const summary = hits.slice(0, 5).map(
    (h) => `  line ${h.line}: '${h.word}' — ${h.text}`).join("\n");
  throw new Error(
    `WGSL '${label || "shader"}' uses ${hits.length} reserved identifier(s):\n${summary}`,
  );
}
