export function getBloomVertShader() {
    return /* wgsl */ `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f
      }

      @vertex
      fn main(@builtin(vertex_index) vi: u32) -> VertexOutput {
        var pos = array<vec2f, 3>(
          vec2f(-1.0, -1.0),
          vec2f( 3.0, -1.0),
          vec2f(-1.0,  3.0)
        );
        var o: VertexOutput;
        o.position = vec4f(pos[vi], 0.0, 1.0);
        o.uv = pos[vi] * 0.5 + 0.5;
        return o;
      }
    `;
  }

export function getBloomExtractShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var sceneTex    : texture_2d<f32>;
      @group(0) @binding(1) var bloomSampler: sampler;
      @group(0) @binding(2) var<uniform> params: BloomParams;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      fn luminance(c: vec3f) -> f32 {
        return dot(c, vec3f(0.2126, 0.7152, 0.0722));
      }

      fn extractBright(c: vec3f, threshold: f32, knee: f32) -> vec3f {
        let lum  = luminance(c);
        let w    = clamp((lum - threshold + knee) / max(knee, 0.001), 0.0, 1.0);
        return c * w;
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let scene = textureSample(sceneTex, bloomSampler, input.uv).rgb;
        return vec4f(extractBright(scene, params.threshold, params.knee), 1.0);
      }
    `;
  }

export function getBloomBlurShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var bloomInput : texture_2d<f32>;
      @group(0) @binding(1) var bloomSampler: sampler;
      @group(0) @binding(2) var<uniform> params: BloomParams;
      @group(0) @binding(3) var<uniform> direction: vec2f;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let radius = max(params.radius, 0.25);
        let axis = direction * vec2f(params.texelSizeX, params.texelSizeY) * radius;

        let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
        var blur = textureSample(bloomInput, bloomSampler, input.uv).rgb * weights[0];
        for (var i = 1; i < 5; i++) {
          let o = axis * f32(i);
          blur += textureSample(bloomInput, bloomSampler, input.uv + o).rgb * weights[i];
          blur += textureSample(bloomInput, bloomSampler, input.uv - o).rgb * weights[i];
        }
        return vec4f(blur, 1.0);
      }
    `;
  }

export function getBloomCompositeShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var sceneTexC  : texture_2d<f32>;
      @group(0) @binding(1) var bloomTexC  : texture_2d<f32>;
      @group(0) @binding(2) var compSampler: sampler;
      @group(0) @binding(3) var<uniform> params: BloomParams;
      @group(0) @binding(4) var depthTexC: texture_depth_2d;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      fn acesTonemap(x: vec3f) -> vec3f {
        let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
      }

      fn hash21(p: vec2f) -> f32 {
        let h = dot(p, vec2f(127.1, 311.7));
        return fract(sin(h) * 43758.5453123);
      }

      fn contactShadow(uv: vec2f) -> f32 {
        let texDim = textureDimensions(depthTexC, 0);
        let coord = vec2i(clamp(uv * vec2f(texDim), vec2f(0.0), vec2f(texDim) - vec2f(1.0)));
        let tx = vec2i(max(i32(params.radius * 1.2), 1), 0);
        let ty = vec2i(0, max(i32(params.radius * 1.2), 1));
        let d0 = textureLoad(depthTexC, coord, 0);
        let dx1 = textureLoad(depthTexC, clamp(coord + tx, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dx2 = textureLoad(depthTexC, clamp(coord - tx, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dy1 = textureLoad(depthTexC, clamp(coord + ty, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dy2 = textureLoad(depthTexC, clamp(coord - ty, vec2i(0), vec2i(texDim) - vec2i(1)), 0);

        let grad = abs(d0 - dx1) + abs(d0 - dx2) + abs(d0 - dy1) + abs(d0 - dy2);
        let contact = smoothstep(0.008, 0.06, grad) * (1.0 - smoothstep(0.94, 0.999, d0));
        return clamp(contact, 0.0, 1.0);
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let center = input.uv - vec2f(0.5);
        let radial = length(center);
        let aberr = params.aberration * (0.4 + params.power * 0.6);
        let aberrOffset = center * aberr * params.texelSizeX * 45.0;
        let sceneR = textureSample(sceneTexC, compSampler, input.uv + aberrOffset).r;
        let sceneG = textureSample(sceneTexC, compSampler, input.uv).g;
        let sceneB = textureSample(sceneTexC, compSampler, input.uv - aberrOffset).b;
        let scene = vec3f(sceneR, sceneG, sceneB);
        let bloom = textureSample(bloomTexC, compSampler, input.uv).rgb;

        var combined = scene + bloom * params.strength;
        let shadow = contactShadow(input.uv);
        combined *= (1.0 - shadow * (0.20 + params.power * 0.18));
        let tm = acesTonemap(combined);

        let grain = (hash21(input.uv * vec2f(1920.0, 1080.0) + vec2f(params.power * 13.7, params.power * 29.3)) - 0.5) * params.grain;
        let vCoord = input.uv * 2.0 - 1.0;
        let vigDist = dot(vCoord * vec2f(0.48, 0.58), vCoord * vec2f(0.48, 0.58));
        let vignette = 1.0 - smoothstep(0.52, 1.05, vigDist);
        let pulse = 1.0 + params.vignette * params.power * 0.4 * (1.0 - radial);
        let graded = (tm + vec3f(grain)) * mix(0.24, 1.0, vignette * pulse);
        return vec4f(clamp(graded, vec3f(0.0), vec3f(1.0)), 1.0);
      }
    `;
  }

