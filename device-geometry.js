export class DeviceGeometry {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount || 50000;
    this.fieldLineCount = 1200;
  }

  async initializeSEG() {
    await this.setupBase();
    await this.setupStatorRings();
    await this.setupRollers();
    await this.setupCore();
    await this.setupParticles();
    await this.setupFieldLines();
    await this.setupEnergyArcs();
    await this.setupWiring();
  }

  async setupBase() {
    // Black square industrial base like the physical prototype
    this.baseBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const baseData = new Float32Array([
      0, -0.35, 0,        // position
      8.2, 0.22, 8.2,     // size (square)
      0.08, 0.08, 0.12, 1.0,  // dark base color (dark metallic)
      0.6, 0.6, 0.6       // roughness / metallic
    ]);
    this.device.queue.writeBuffer(this.baseBuffer, 0, baseData);
  }

  async setupStatorRings() {
    // 3 flat concentric copper stator rings (layered plates)
    const ringCount = 3;
    this.statorRingBuffer = this.device.createBuffer({
      size: ringCount * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const ringData = new Float32Array(ringCount * 12);
    const radii = [2.4, 4.1, 5.8];
    for (let i = 0; i < ringCount; i++) {
      const idx = i * 12;
      ringData[idx]     = 0;
      ringData[idx + 1] = 0.12 * i;           // slight vertical stacking
      ringData[idx + 2] = 0;
      ringData[idx + 3] = radii[i];           // radius
      ringData[idx + 4] = 0.22;               // thickness (flat plate)
      ringData[idx + 5] = 0;                  // rotation
      // Copper color
      ringData[idx + 6] = 0.85; ringData[idx + 7] = 0.48; ringData[idx + 8] = 0.25;
      ringData[idx + 9] = 0.0;                // emissive (none on stator)
      ringData[idx + 10] = 0.9;               // specular
    }
    this.device.queue.writeBuffer(this.statorRingBuffer, 0, ringData);
  }

  async setupRollers() {
    // 36 dense cylindrical rollers (8+12+16) with green underglow data
    const totalRollers = 36;
    this.rollerInstances = this.device.createBuffer({
      size: totalRollers * 48,   // extra space for emissive green data
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-rollers`, totalRollers * 48, GPUBufferUsage.STORAGE);

    // Initialize roller data with copper material + green emissive flag
    // Format: position(3) + ringIndex(1) + rotation(4) + emissiveGreen(3) + pad(1)
    const rollerData = new Float32Array(totalRollers * 12);
    
    const rings = [
      { count: 8, radius: 2.5, scale: 0.6, index: 0 },
      { count: 12, radius: 4.0, scale: 0.8, index: 1 },
      { count: 16, radius: 5.5, scale: 1.0, index: 2 }
    ];

    let rollerOffset = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        const idx = rollerOffset * 12;
        const angle = (i / ring.count) * Math.PI * 2;

        // Position
        rollerData[idx] = Math.cos(angle) * ring.radius;
        rollerData[idx + 1] = 0;
        rollerData[idx + 2] = Math.sin(angle) * ring.radius;
        rollerData[idx + 3] = ring.index; // ringIndex

        // Rotation (quaternion)
        const tangentAngle = angle + Math.PI / 2;
        rollerData[idx + 4] = Math.cos(tangentAngle) * Math.sin(0);
        rollerData[idx + 5] = 0;
        rollerData[idx + 6] = Math.sin(tangentAngle) * Math.sin(0);
        rollerData[idx + 7] = Math.cos(0);

        // Copper color (stored for shader reference)
        rollerData[idx + 8] = 0.85;  // copper R
        rollerData[idx + 9] = 0.48;  // copper G
        rollerData[idx + 10] = 0.25; // copper B
        rollerData[idx + 11] = 1.0;  // green emissive flag (1.0 = enabled)

        rollerOffset++;
      }
    }
    this.device.queue.writeBuffer(this.rollerInstances, 0, rollerData);
  }

  async setupWiring() {
    // Visible wiring on the base - thin copper cables
    const wireCount = 8;
    this.wiringBuffer = this.device.createBuffer({
      size: wireCount * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const wireData = new Float32Array(wireCount * 12);
    for (let i = 0; i < wireCount; i++) {
      const idx = i * 12;
      const angle = (i / wireCount) * Math.PI * 2;
      const radius = 6.5;

      // Wire position on base
      wireData[idx] = Math.cos(angle) * radius;
      wireData[idx + 1] = -0.25;
      wireData[idx + 2] = Math.sin(angle) * radius;
      wireData[idx + 3] = 0.15; // wire thickness

      // Direction to center
      wireData[idx + 4] = -Math.cos(angle);
      wireData[idx + 5] = 0.1;
      wireData[idx + 6] = -Math.sin(angle);
      wireData[idx + 7] = 2.0; // wire length

      // Copper wire color
      wireData[idx + 8] = 0.75;
      wireData[idx + 9] = 0.45;
      wireData[idx + 10] = 0.25;
      wireData[idx + 11] = 0.0; // not emissive
    }
    this.device.queue.writeBuffer(this.wiringBuffer, 0, wireData);
  }

  async setupParticles() {
    const particleSize = 40;
    this.particles = this.device.createBuffer({
      size: this.particleCount * particleSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-particles`, this.particleCount * particleSize, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    const particleData = new Float32Array(this.particleCount * 10);
    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 10;
      if (this.id === 'seg') {
        const theta = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 4;
        particleData[idx] = r * Math.cos(theta);
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
        particleData[idx + 2] = r * Math.sin(theta);
        // Copper + green energy particles
        particleData[idx + 3] = 0.0; // velocity x
        particleData[idx + 4] = 0.0; // velocity y  
        particleData[idx + 5] = 0.0; // velocity z
        particleData[idx + 6] = 0.85; // copper R
        particleData[idx + 7] = 0.48; // copper G
        particleData[idx + 8] = 0.25; // copper B
        particleData[idx + 9] = Math.random(); // life/energy
      } else if (this.id === 'solar') {
        const ledCount = 6;
        const ledIdx = Math.floor(Math.random() * ledCount);
        const ledAngle = (ledIdx / ledCount) * Math.PI * 2;
        const ledRadius = 3.0;
        particleData[idx] = Math.cos(ledAngle) * ledRadius;
        particleData[idx + 1] = 3.0 + Math.random() * 0.5;
        particleData[idx + 2] = Math.sin(ledAngle) * ledRadius;
        particleData[idx + 9] = Math.random();
      } else {
        particleData[idx + 1] = (Math.random() - 0.5) * 6;
      }
    }
    this.device.queue.writeBuffer(this.particles, 0, particleData);
  }

  async setupFieldLines() {
    this.fieldLineParticles = this.device.createBuffer({
      size: this.fieldLineCount * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-fieldlines`, this.fieldLineCount * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    const fieldData = new Float32Array(this.fieldLineCount * 8);
    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;
      const ringIdx = Math.floor(Math.random() * 3);
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];

      const angle = Math.random() * Math.PI * 2;
      const height = (Math.random() - 0.5) * 2.0;

      fieldData[idx] = Math.cos(angle) * ringRadius;
      fieldData[idx + 1] = height;
      fieldData[idx + 2] = Math.sin(angle) * ringRadius;

      const speed = 0.5 + Math.random() * 1.0;
      fieldData[idx + 3] = -Math.sin(angle) * speed;
      fieldData[idx + 4] = (Math.random() - 0.5) * 0.2;
      fieldData[idx + 5] = Math.cos(angle) * speed;

      fieldData[idx + 6] = Math.random();
      fieldData[idx + 7] = 0.5 + Math.random() * 0.5;
    }
    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  }

  async setupEnergyArcs() {
    this.energyArcParticles = this.device.createBuffer({
      size: 200 * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-energyarcs`, 200 * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    const arcData = new Float32Array(200 * 8);
    for (let i = 0; i < 200; i++) {
      const idx = i * 8;
      const angle = Math.random() * Math.PI * 2;
      const radius = 3.0 + Math.random() * 2.0;
      arcData[idx] = Math.cos(angle) * radius;
      arcData[idx + 1] = (Math.random() - 0.5) * 4.0;
      arcData[idx + 2] = Math.sin(angle) * radius;
      arcData[idx + 3] = (Math.random() - 0.5) * 2.0;
      arcData[idx + 4] = Math.random() * 0.5;
      arcData[idx + 5] = (Math.random() - 0.5) * 2.0;
      arcData[idx + 6] = Math.random();
      arcData[idx + 7] = 0.3 + Math.random() * 0.7;
    }
    this.device.queue.writeBuffer(this.energyArcParticles, 0, arcData);
  }

  async setupCore() {
    this.coreInstances = this.device.createBuffer({
      size: 100 * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-core`, 100 * 32, GPUBufferUsage.STORAGE);
  }
}
