struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct DeviceUniforms {
        renderMode: f32,
        posX: f32,
        posY: f32,
        posZ: f32,
        rotation: vec4f,
        timeScale: f32,
        ringIndex: f32,
        batteryCharge: f32,
        isSolar: f32
      }

      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }

      struct SEGLayoutRing {
        count: f32,
        fullCount: f32,
        orbitRadius: f32,
        rollerRadius: f32,
        rollerHeight: f32,
        speed: f32,
        statorInner: f32,
        statorOuter: f32,
        rollerOffset: f32,
        _pad0: f32,
        _pad1: f32,
        _pad2: f32
      }

      struct SEGLayoutUniforms {
        worldScale: f32,
        ringCount: f32,
        totalRollers: f32,
        maxRollers: f32,
        refRollerRadius: f32,
        refRollerHeight: f32,
        statorHeight: f32,
        fluxLinesPerRing: f32,
        ring0: SEGLayoutRing,
        ring1: SEGLayoutRing,
        ring2: SEGLayoutRing
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;
      @binding(4) @group(0) var<uniform> segLayout: SEGLayoutUniforms;

      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f
      }

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f,
        @location(3) copperColor: vec3f,
        @location(4) greenEmissive: f32,
        @location(5) ringIndex: f32,
        @location(6) scaleXZ: f32,
        @location(7) scaleY: f32
      }

      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }

      fn ringForInstance(idx: u32) -> SEGLayoutRing {
        if (idx >= u32(segLayout.ring2.rollerOffset)) { return segLayout.ring2; }
        if (idx >= u32(segLayout.ring1.rollerOffset)) { return segLayout.ring1; }
        return segLayout.ring0;
      }

      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        let ring = ringForInstance(instanceIdx);

        let scaleXZ = ring.rollerRadius / max(segLayout.refRollerRadius, 1e-4);
        let scaleY = ring.rollerHeight / max(segLayout.refRollerHeight, 1e-4);
        let scaledPos = vec3f(input.position.x * scaleXZ, input.position.y * scaleY, input.position.z * scaleXZ);
        let scaledNormal = normalize(vec3f(input.normal.x / scaleXZ, input.normal.y / scaleY, input.normal.z / scaleXZ));

        let rotatedPos = quatMul(instance.rotation, scaledPos);
        let rotatedNormal = quatMul(instance.rotation, scaledNormal);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotatedPos + instance.position + devicePos;

        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.uv = input.uv;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        output.scaleXZ = scaleXZ;
        output.scaleY = scaleY;
        return output;
      }
