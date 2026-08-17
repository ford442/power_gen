// gpu-chores reduce_f32 — 1D workgroup 64.
// Input: tightly packed f32. Each workgroup writes one vec4 (sum, min, max, sumSq)
// plus a count in a parallel u32 buffer. Host merges the few workgroup results.
// Does not own domain field / particle layouts.

struct ChoresReduceUniforms {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

struct ChoresPartial {
  sum: f32,
  minV: f32,
  maxV: f32,
  sumSq: f32,
}

@group(0) @binding(0) var<storage, read> inputData: array<f32>;
@group(0) @binding(1) var<storage, read_write> partials: array<ChoresPartial>;
@group(0) @binding(2) var<uniform> uniforms: ChoresReduceUniforms;

var<workgroup> wgSum: array<f32, 64>;
var<workgroup> wgMin: array<f32, 64>;
var<workgroup> wgMax: array<f32, 64>;
var<workgroup> wgSq: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let i = gid.x;
  let li = lid.x;
  var s = 0.0;
  var mn = 1e30;
  var mx = -1e30;
  var sq = 0.0;
  if (i < uniforms.count) {
    let x = inputData[i];
    s = x;
    mn = x;
    mx = x;
    sq = x * x;
  }
  wgSum[li] = s;
  wgMin[li] = mn;
  wgMax[li] = mx;
  wgSq[li] = sq;
  workgroupBarrier();

  if (li < 32u) {
    wgSum[li] = wgSum[li] + wgSum[li + 32u];
    wgMin[li] = min(wgMin[li], wgMin[li + 32u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 32u]);
    wgSq[li] = wgSq[li] + wgSq[li + 32u];
  }
  workgroupBarrier();
  if (li < 16u) {
    wgSum[li] = wgSum[li] + wgSum[li + 16u];
    wgMin[li] = min(wgMin[li], wgMin[li + 16u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 16u]);
    wgSq[li] = wgSq[li] + wgSq[li + 16u];
  }
  workgroupBarrier();
  if (li < 8u) {
    wgSum[li] = wgSum[li] + wgSum[li + 8u];
    wgMin[li] = min(wgMin[li], wgMin[li + 8u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 8u]);
    wgSq[li] = wgSq[li] + wgSq[li + 8u];
  }
  workgroupBarrier();
  if (li < 4u) {
    wgSum[li] = wgSum[li] + wgSum[li + 4u];
    wgMin[li] = min(wgMin[li], wgMin[li + 4u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 4u]);
    wgSq[li] = wgSq[li] + wgSq[li + 4u];
  }
  workgroupBarrier();
  if (li < 2u) {
    wgSum[li] = wgSum[li] + wgSum[li + 2u];
    wgMin[li] = min(wgMin[li], wgMin[li + 2u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 2u]);
    wgSq[li] = wgSq[li] + wgSq[li + 2u];
  }
  workgroupBarrier();
  if (li < 1u) {
    wgSum[li] = wgSum[li] + wgSum[li + 1u];
    wgMin[li] = min(wgMin[li], wgMin[li + 1u]);
    wgMax[li] = max(wgMax[li], wgMax[li + 1u]);
    wgSq[li] = wgSq[li] + wgSq[li + 1u];
  }

  if (li == 0u) {
    var p: ChoresPartial;
    p.sum = wgSum[0];
    p.minV = wgMin[0];
    p.maxV = wgMax[0];
    p.sumSq = wgSq[0];
    partials[wid.x] = p;
  }
}
