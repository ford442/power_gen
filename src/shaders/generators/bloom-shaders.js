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
        motionBlur: f32,
        exposure:   f32,
        coronaBoost: f32,
        ssaoStrength: f32,
        contactShadow: f32,
        skyMode:    f32,
      }

      @group(0) @binding(0) var sceneTex    : texture_2d<f32>;
      @group(0) @binding(1) var bloomSampler: sampler;
      @group(0) @binding(2) var<uniform> params: BloomParams;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      fn luminance(c: vec3f) -> vec3f {
        return vec3f(dot(c, vec3f(0.2126, 0.7152, 0.0722)));
      }

      /** Weight green/cyan plasma higher so corona blooms before metal specular blows out. */
      fn coronaLuminance(c: vec3f) -> f32 {
        let base = dot(c, vec3f(0.2126, 0.7152, 0.0722));
        let plasma = max(c.g, c.b) * 0.72 + c.g * 0.28;
        return max(base, plasma * 0.88) * params.coronaBoost;
      }

      fn extractBright(c: vec3f, threshold: f32, knee: f32) -> vec3f {
        let lum  = coronaLuminance(c);
        let w    = clamp((lum - threshold + knee) / max(knee, 0.001), 0.0, 1.0);
        let w2   = w * w * (3.0 - 2.0 * w);
        return c * w2;
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let ts = vec2f(params.texelSizeX, params.texelSizeY);
        var bloom = vec3f(0.0);
        var weights: array<f32, 5> = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
        for (var i = 0; i < 5; i++) {
          let o = ts * f32(i);
          bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv + vec2f(o.x, 0.0)).rgb, params.threshold, params.knee) * weights[i];
          bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv - vec2f(o.x, 0.0)).rgb, params.threshold, params.knee) * weights[i];
          bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv + vec2f(0.0, o.y)).rgb, params.threshold, params.knee) * weights[i];
          bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv - vec2f(0.0, o.y)).rgb, params.threshold, params.knee) * weights[i];
        }
        bloom *= 0.25;
        bloom += extractBright(textureSample(sceneTex, bloomSampler, input.uv).rgb, params.threshold, params.knee) * 0.35;
        return vec4f(bloom, 1.0);
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
        motionBlur: f32,
        exposure:   f32,
        coronaBoost: f32,
        ssaoStrength: f32,
        contactShadow: f32,
        skyMode:    f32,
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

        var weights: array<f32, 5> = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
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
        motionBlur: f32,
        exposure:   f32,
        coronaBoost: f32,
        ssaoStrength: f32,
        contactShadow: f32,
        skyMode:    f32,
      }

      @group(0) @binding(0) var sceneTexC  : texture_2d<f32>;
      @group(0) @binding(1) var bloomTexC  : texture_2d<f32>;
      @group(0) @binding(2) var compSampler: sampler;
      @group(0) @binding(3) var<uniform> params: BloomParams;
      @group(0) @binding(4) var depthTexC: texture_depth_2d;
      @group(0) @binding(5) var prevSceneTexC: texture_2d<f32>;

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

      fn sampleDepth(uv: vec2f) -> f32 {
        let texDim = textureDimensions(depthTexC, 0);
        let coord = vec2i(clamp(uv * vec2f(texDim), vec2f(0.0), vec2f(texDim) - vec2f(1.0)));
        return textureLoad(depthTexC, coord, 0);
      }

      fn contactShadow(uv: vec2f, depth: f32) -> f32 {
        let texDim = textureDimensions(depthTexC, 0);
        let ts = vec2f(1.0 / f32(texDim.x), 1.0 / f32(texDim.y));
        let r = max(params.radius * 1.4, 1.5);
        let dx1 = sampleDepth(uv + vec2f(ts.x * r, 0.0));
        let dx2 = sampleDepth(uv - vec2f(ts.x * r, 0.0));
        let dy1 = sampleDepth(uv + vec2f(0.0, ts.y * r));
        let dy2 = sampleDepth(uv - vec2f(0.0, ts.y * r));
        let grad = abs(depth - dx1) + abs(depth - dx2) + abs(depth - dy1) + abs(depth - dy2);
        let crease = smoothstep(0.006, 0.055, grad) * (1.0 - smoothstep(0.92, 0.999, depth));
        let ground = smoothstep(0.55, 0.92, depth) * 0.35;
        return clamp(crease + ground, 0.0, 1.0) * params.contactShadow;
      }

      fn ssao(uv: vec2f, depth: f32) -> f32 {
        if (params.ssaoStrength < 0.01) { return 1.0; }
        let texDim = textureDimensions(depthTexC, 0);
        let ts = vec2f(1.0 / f32(texDim.x), 1.0 / f32(texDim.y));
        let r = max(params.radius * 2.2, 2.0);
        var occ = 0.0;
        let seed = hash21(uv * vec2f(1920.0, 1080.0));
        for (var i = 0; i < 6; i++) {
          let angle = seed * 6.28318 + f32(i) * 1.047197;
          let offset = vec2f(cos(angle), sin(angle)) * ts * r;
          let dSample = sampleDepth(uv + offset);
          if (dSample > depth + 0.0015) { occ += 1.0; }
        }
        let ao = 1.0 - (occ / 6.0) * params.ssaoStrength * 0.55;
        return clamp(ao, 0.45, 1.0);
      }

      fn wideBloom(uv: vec2f) -> vec3f {
        let o = vec2f(params.texelSizeX, params.texelSizeY) * params.radius * 2.5;
        var s = textureSample(bloomTexC, compSampler, uv).rgb * 0.40;
        s += textureSample(bloomTexC, compSampler, uv + vec2f(o.x, 0.0)).rgb * 0.15;
        s += textureSample(bloomTexC, compSampler, uv - vec2f(o.x, 0.0)).rgb * 0.15;
        s += textureSample(bloomTexC, compSampler, uv + vec2f(0.0, o.y)).rgb * 0.15;
        s += textureSample(bloomTexC, compSampler, uv - vec2f(0.0, o.y)).rgb * 0.15;
        return s;
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
        var scene = vec3f(sceneR, sceneG, sceneB);

        if (params.motionBlur > 0.001) {
          let prev = textureSample(prevSceneTexC, compSampler, input.uv).rgb;
          scene = mix(scene, prev, params.motionBlur);
        }

        let depth = sampleDepth(input.uv);
        let shadow = contactShadow(input.uv, depth);
        let ao = ssao(input.uv, depth);
        scene *= ao * (1.0 - shadow);

        let bloom = wideBloom(input.uv);
        var combined = scene + bloom * params.strength * (0.85 + params.power * 0.35);
        combined *= params.exposure;

        let tm = acesTonemap(combined);

        let grain = (hash21(input.uv * vec2f(1920.0, 1080.0) + vec2f(params.power * 13.7, params.power * 29.3)) - 0.5) * params.grain;
        let vCoord = input.uv * 2.0 - 1.0;
        let vigDist = dot(vCoord * vec2f(0.48, 0.58), vCoord * vec2f(0.48, 0.58));
        let vignette = 1.0 - smoothstep(0.52, 1.05, vigDist);
        let pulse = 1.0 + params.vignette * params.power * 0.35 * (1.0 - radial);
        let graded = (tm + vec3f(grain)) * mix(0.28, 1.0, vignette * pulse);
        return vec4f(clamp(graded, vec3f(0.0), vec3f(1.0)), 1.0);
      }
    `;
  }
