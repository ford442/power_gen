export class DeviceGeometry {
  constructor(device, id, config, visualizer) {
    this.device = device;
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.particleCount = config.particleCount;
    this.fieldLineCount = 1000;
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
        particleData[idx + 9] = Math.random();
      } else if (this.id === 'solar') {
        // Emit photons from LEDs above solar panels
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

  async setupRollers() {
    // 3-ring SEG system: 8 inner + 12 middle + 16 outer = 36 rollers total
    const totalRollers = 36;
    this.rollerInstances = this.device.createBuffer({
      size: totalRollers * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-rollers`, totalRollers * 32, GPUBufferUsage.STORAGE);
  }

  async setupFieldLines() {
    // Field particles: position(3) + velocity(3) + life(1) + strength(1) = 8 floats = 32 bytes
    this.fieldLineParticles = this.device.createBuffer({
      size: this.fieldLineCount * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-fieldlines`, this.fieldLineCount * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    // Initialize field line particles flowing between rollers
    const fieldData = new Float32Array(this.fieldLineCount * 8);
    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;
      // Distribute particles in arcs between rollers
      const ringIdx = Math.floor(Math.random() * 3);
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];

      const angle = Math.random() * Math.PI * 2;
      const height = (Math.random() - 0.5) * 2.0;

      // Position along magnetic field line
      fieldData[idx] = Math.cos(angle) * ringRadius;
      fieldData[idx + 1] = height;
      fieldData[idx + 2] = Math.sin(angle) * ringRadius;

      // Velocity tangent to ring (magnetic field direction)
      const speed = 0.5 + Math.random() * 1.0;
      fieldData[idx + 3] = -Math.sin(angle) * speed;
      fieldData[idx + 4] = (Math.random() - 0.5) * 0.2;
      fieldData[idx + 5] = Math.cos(angle) * speed;

      // Life and strength
      fieldData[idx + 6] = Math.random(); // life 0-1
      fieldData[idx + 7] = 0.5 + Math.random() * 0.5; // strength
    }
    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  }

  async setupEnergyArcs() {
    // Energy arc particles for SEG device
    this.energyArcParticles = this.device.createBuffer({
      size: 200 * 32, // 200 particles
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-energyarcs`, 200 * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);

    const arcData = new Float32Array(200 * 8);
    for (let i = 0; i < 200; i++) {
      const idx = i * 8;
      // Arcs between rollers
      const angle = Math.random() * Math.PI * 2;
      const radius = 3.0 + Math.random() * 2.0;
      arcData[idx] = Math.cos(angle) * radius;
      arcData[idx + 1] = (Math.random() - 0.5) * 4.0;
      arcData[idx + 2] = Math.sin(angle) * radius;
      arcData[idx + 3] = (Math.random() - 0.5) * 2.0; // velocity x
      arcData[idx + 4] = Math.random() * 0.5; // velocity y
      arcData[idx + 5] = (Math.random() - 0.5) * 2.0; // velocity z
      arcData[idx + 6] = Math.random(); // life
      arcData[idx + 7] = 0.3 + Math.random() * 0.7; // intensity
    }
    this.device.queue.writeBuffer(this.energyArcParticles, 0, arcData);
  }

  async setupCore() {
    // Core geometry for SEG device
    this.coreInstances = this.device.createBuffer({
      size: 100 * 32, // instance data
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.visualizer.profiler.trackBuffer(`device-${this.id}-core`, 100 * 32, GPUBufferUsage.STORAGE);
  }
}