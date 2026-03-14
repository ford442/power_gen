/**
 * Scientific Data Module for Multi-Device Physics Visualizer
 * Data sources: Wolfram Alpha / Wolfram Language computational results
 * Generated: 4-Agent Swarm Analysis
 */

// ============================================
// PHYSICAL CONSTANTS (CODATA 2018)
// ============================================
export const PHYSICAL_CONSTANTS = {
  // Electromagnetic
  MU_0: 1.2566370614e-7,        // H/m - Vacuum permeability
  EPSILON_0: 8.854187817e-12,   // F/m - Vacuum permittivity
  C: 299792458,                 // m/s - Speed of light
  
  // Thermodynamic
  K_B: 1.380649e-23,            // J/K - Boltzmann constant
  T_ROOM: 300,                  // K - Room temperature (27°C)
  
  // Electrodynamic
  E_CHARGE: 1.602176634e-19,    // C - Elementary charge
  
  // Gravitational
  G: 9.80665,                   // m/s² - Standard gravity
  
  // Material Properties
  RHO_WATER: 1000,              // kg/m³ - Water density
  MU_WATER: 0.001,              // Pa·s - Water dynamic viscosity
  SIGMA_WATER: 0.072,           // N/m - Water surface tension
};

// ============================================
// SEG (SEARL EFFECT GENERATOR) - MAGNETIC DATA
// ============================================
export const SEG_DATA = {
  // Magnet Specifications (NdFeB N52)
  MAGNET: {
    Br: 1.48,                   // Tesla - Remanence
    mu_r: 1.05,                 // Relative permeability
    radius: 0.8,                // m
    height: 2.5,                // m
    volume: 5.02655,            // m³
    magnetization: 1.12166e6,   // A/m
  },
  
  // Toroidal Configuration
  CONFIG: {
    numRollers: 12,
    ringRadius: 4.0,            // m
    rollerDistance: 2.07055,    // m (straight-line between adjacent)
    angularSeparation: Math.PI / 6, // 30°
  },
  
  // Calculated Magnetic Moment
  MAGNETIC_MOMENT: 5.635e6,     // A·m²
  
  // B-Field at Various Distances (Axial, from Wolfram)
  B_FIELD: {
    surface: 0.7048,            // Tesla
    at1m: 0.1436,               // Tesla
    at2m: 0.0415,               // Tesla  
    at4m: 0.0088,               // Tesla
    at8m: 0.0015,               // Tesla
  },
  
  // Energy Density u = B²/(2μ₀)
  ENERGY_DENSITY: {
    surface: 1.976e6,           // J/m³
    at1m: 8.20e4,               // J/m³
    at2m: 6.85e3,               // J/m³
    at4m: 3.10e2,               // J/m³
  },
  
  // Force Between Adjacent Rollers
  // F = (3μ₀m²)/(2πd⁴)
  ADJACENT_FORCE: 1.037e7,      // N (~10.4 MN)
  
  // Roller Positions (pre-calculated for shader)
  getRollerPositions: function() {
    const positions = [];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      positions.push({
        x: Math.cos(angle) * this.CONFIG.ringRadius,
        y: 0,
        z: Math.sin(angle) * this.CONFIG.ringRadius,
        angle: angle
      });
    }
    return positions;
  },
  
  // Axial B-field function for cylindrical magnet (Wolfram verified)
  // B(z) = (Br/2)[(z+h)/√((z+h)²+R²) - z/√(z²+R²)]
  calculateAxialBField: function(z) {
    const R = this.MAGNET.radius;
    const h = this.MAGNET.height;
    const Br = this.MAGNET.Br;
    
    const term1 = (z + h) / Math.sqrt((z + h) ** 2 + R ** 2);
    const term2 = z / Math.sqrt(z ** 2 + R ** 2);
    
    return (Br / 2) * (term1 - term2);
  },
  
  // Dipole field approximation for far field
  // B = (μ₀/4π)[3(m·r̂)r̂ - m]/r³
  calculateDipoleField: function(r, m) {
    const mu0 = PHYSICAL_CONSTANTS.MU_0;
    const rLen = Math.sqrt(r.x ** 2 + r.y ** 2 + r.z ** 2);
    const rNorm = { x: r.x / rLen, y: r.y / rLen, z: r.z / rLen };
    const r3 = rLen ** 3;
    
    const mDotR = m.x * rNorm.x + m.y * rNorm.y + m.z * rNorm.z;
    const factor = (mu0 / (4 * Math.PI)) / r3;
    
    return {
      x: factor * (3 * mDotR * rNorm.x - m.x),
      y: factor * (3 * mDotR * rNorm.y - m.y),
      z: factor * (3 * mDotR * rNorm.z - m.z)
    };
  },
  
  // WGSL Shader Constants
  WGSL_CONSTANTS: `
    const MU_0: f32 = 1.2566370614e-7;
    const BR: f32 = 1.48;
    const MAGNET_RADIUS: f32 = 0.8;
    const MAGNET_HEIGHT: f32 = 2.5;
    const RING_RADIUS: f32 = 4.0;
    const NUM_ROLLERS: i32 = 12;
    const MAGNETIC_MOMENT: f32 = 5.635e6;
    const B_SURFACE: f32 = 0.7048;
    const ADJACENT_FORCE: f32 = 1.037e7;
    
    // Axial B-field for cylindrical magnet
    fn B_axial(z: f32) -> f32 {
      let R = MAGNET_RADIUS;
      let h = MAGNET_HEIGHT;
      let Br = BR;
      let t1 = (z + h) / sqrt((z + h) * (z + h) + R * R);
      let t2 = z / sqrt(z * z + R * R);
      return (Br / 2.0) * (t1 - t2);
    }
    
    // Energy density
    fn energy_density(B: f32) -> f32 {
      return (B * B) / (2.0 * MU_0);
    }
  `
};

// ============================================
// KELVIN'S THUNDERSTORM - ELECTROSTATIC DATA
// ============================================
export const KELVIN_DATA = {
  // Bucket Specifications
  BUCKET: {
    radius: 0.5,                // m
    height: 1.0,                // m
    capacitance: 40.1e-12,      // F (~40 pF)
  },
  
  // Configuration
  CONFIG: {
    bucketDistance: 6.0,        // m (between bucket centers)
    dropletRate: 1000,          // droplets/second
  },
  
  // Water Droplet Properties
  DROPLET: {
    radius: 1e-3,               // m (1 mm)
    volume: 4.189e-9,           // m³ (4.189 μL)
    mass: 4.189e-6,             // kg (4.189 mg)
    charge: 1e-9,               // C (1 nC typical induced)
    charge_pC: 1000,            // pC
  },
  
  // Air Breakdown
  BREAKDOWN: {
    fieldStrength: 3e6,         // V/m (3 MV/m)
    // Spark gap: d = V / E_breakdown
    sparkGap: function(voltage) {
      return voltage / this.fieldStrength;
    },
  },
  
  // Spark Gap Distances (from Wolfram)
  SPARK_GAPS: {
    at1kV: 0.33e-3,             // m (0.33 mm)
    at5kV: 1.67e-3,             // m (1.67 mm)
    at10kV: 3.33e-3,            // m (3.33 mm)
    at50kV: 16.7e-3,            // m (1.67 cm)
    at100kV: 33.3e-3,           // m (3.33 cm)
  },
  
  // Voltage Buildup Over Time
  // V(t) = (I × t) / C, I = 1000 droplets/s × 1nC = 1μA
  VOLTAGE_BUILDUP: {
    at0_1s: 2.5e3,              // V (2.5 kV)
    at0_5s: 12.5e3,             // V (12.5 kV)
    at1s: 25e3,                 // V (25 kV)
    at5s: 125e3,                // V (125 kV)
    at10s: 250e3,               // V (250 kV)
  },
  
  // Electric Field Between Buckets
  // E = Q / (2πε₀(d/2)²)
  calculateElectricField: function(charge) {
    const eps0 = PHYSICAL_CONSTANTS.EPSILON_0;
    const d = this.CONFIG.bucketDistance;
    return charge / (2 * Math.PI * eps0 * (d / 2) ** 2);
  },
  
  // Force on Charged Droplet: F = qE
  calculateDropletForce: function(electricField) {
    return this.DROPLET.charge * electricField;
  },
  
  // Electric Field Values (from Wolfram)
  E_FIELD: {
    at1nC: 0.2,                 // V/m
    at10nC: 2.0,                // V/m
    at100nC: 20.0,              // V/m
    at1uC: 200.0,               // V/m
    at10uC: 2000.0,             // V/m (2 kV/m)
  },
  
  // Force on Droplet (from Wolfram)
  DROPLET_FORCE: {
    at100Vm: 0.1e-6,            // N (0.1 μN)
    at500Vm: 0.5e-6,            // N (0.5 μN)
    at1000Vm: 1.0e-6,           // N (1.0 μN)
    at5000Vm: 5.0e-6,           // N (5.0 μN)
  },
  
  // Energy Stored: E = ½CV²
  calculateEnergy: function(voltage) {
    return 0.5 * this.BUCKET.capacitance * voltage ** 2;
  },
  
  // Microvolt Sensitivity
  MICROVOLT: {
    // Single electron voltage: V = e/C
    singleElectron: 4e-9,       // V (4 nV)
    // Voltage per droplet: V = q/C
    perDroplet: 25.0,           // V (~25 V)
    // Minimum detectable (10 fC resolution)
    minDetectable: 0.25e-6,     // V (0.25 μV)
  },
  
  // Thermal Noise (Johnson-Nyquist)
  // Vn = √(4kBTRΔf)
  calculateThermalNoise: function(resistance, bandwidth) {
    const kB = PHYSICAL_CONSTANTS.K_B;
    const T = PHYSICAL_CONSTANTS.T_ROOM;
    return Math.sqrt(4 * kB * T * resistance * bandwidth);
  },
  
  THERMAL_NOISE: {
    at1Hz_1MOhm: 0.129e-6,      // V (0.129 μV RMS)
    at0_01Hz_1MOhm: 0.013e-6,   // V (0.013 μV RMS)
    at100Hz_1MOhm: 1.29e-6,     // V (1.29 μV RMS)
  },
  
  // WGSL Shader Code
  WGSL_CONSTANTS: `
    const EPSILON_0: f32 = 8.854187817e-12;
    const BUCKET_CAPACITANCE: f32 = 40.1e-12;
    const DROPLET_CHARGE: f32 = 1e-9;
    const E_BREAKDOWN: f32 = 3e6;
    const K_B: f32 = 1.380649e-23;
    const T_ROOM: f32 = 300.0;
    
    // Electric field between buckets
    fn E_field(Q: f32, d: f32) -> f32 {
      return Q / (2.0 * 3.14159265359 * EPSILON_0 * (d / 2.0) * (d / 2.0));
    }
    
    // Force on droplet
    fn F_droplet(q: f32, E: f32) -> f32 {
      return q * E;
    }
    
    // Spark gap distance
    fn spark_gap(V: f32) -> f32 {
      return V / E_BREAKDOWN;
    }
    
    // Voltage buildup: V = I*t/C
    fn V_buildup(I: f32, t: f32, C: f32) -> f32 {
      return (I * t) / C;
    }
    
    // Energy stored
    fn energy_stored(C: f32, V: f32) -> f32 {
      return 0.5 * C * V * V;
    }
  `
};

// ============================================
// HERON'S FOUNTAIN - FLUID DYNAMICS DATA
// ============================================
export const HERON_DATA = {
  // SPH Parameters (from Wolfram)
  SPH: {
    smoothingLength: 0.012,     // m (h)
    restDensity: 1000,          // kg/m³ (ρ₀)
    dynamicViscosity: 0.001,    // Pa·s (μ)
    kinematicViscosity: 1e-6,   // m²/s (ν)
    surfaceTension: 0.072,      // N/m (σ)
    speedOfSound_real: 1482,    // m/s
    speedOfSound_SPH: 62.64,    // m/s (artificial for stability)
    gasConstant: 560571,        // Pa (B)
    gamma: 7,                   // Tait EOS exponent
    particleMass: 0.001,        // kg
    CFL: 0.2,                   // Courant number
    maxTimestep: 3.48e-5,       // s
  },
  
  // Cubic Spline Kernel Values (2D)
  KERNEL: {
    at0: 0.4547,
    at0_5: 0.3268,
    at1: 0.1137,
    at1_5: 0.0142,
    at2: 0.0,
  },
  
  // Chamber Configuration
  CHAMBER: {
    upperY: 4.0,                // m
    lowerY: -2.0,               // m
    siphonLevel: 2.0,           // m
    radius: 2.0,                // m
    heightDiff: 1.0,            // m (typical)
  },
  
  // Pressure Calculations
  PRESSURE: {
    atmospheric: 101325,        // Pa
    // Hydrostatic: P = ρgh
    at2m: 19620,                // Pa
    at1m: 9810,                 // Pa
    at0_5m: 4905,               // Pa
  },
  
  // Siphon Flow (Bernoulli's Principle)
  // v = √(2gh)
  SIPHON_VELOCITY: {
    at0_5m: 3.13,               // m/s
    at1m: 4.43,                 // m/s
    at2m: 6.26,                 // m/s
  },
  
  // Calculate siphon velocity
  calculateSiphonVelocity: function(height) {
    return Math.sqrt(2 * PHYSICAL_CONSTANTS.G * height);
  },
  
  // Flow Rate (tube diameter 0.01m)
  // Q = A × v = πr² × v
  FLOW_RATE: {
    at0_5m: 0.000246,           // m³/s (0.246 L/s)
    at1m: 0.000348,             // m³/s (0.348 L/s)
    at2m: 0.000492,             // m³/s (0.492 L/s)
  },
  
  // Required Air Pressure for Buoyancy
  // P = ρgh (to push water up)
  BUOYANCY_PRESSURE: {
    at0_5m: 4905,               // Pa
    at1m: 9810,                 // Pa
    at2m: 19620,                // Pa
  },
  
  // Equation of State (Tait)
  // P = B[(ρ/ρ₀)^γ - 1]
  calculatePressure: function(density) {
    const B = this.SPH.gasConstant;
    const gamma = this.SPH.gamma;
    const rho0 = this.SPH.restDensity;
    return B * ((density / rho0) ** gamma - 1);
  },
  
  // WGSL Shader Code
  WGSL_CONSTANTS: `
    const RHO_0: f32 = 1000.0;
    const G: f32 = 9.80665;
    const GAS_CONSTANT: f32 = 560571.0;
    const GAMMA: f32 = 7.0;
    const SMOOTHING_LENGTH: f32 = 0.012;
    const ATMOSPHERIC_PRESSURE: f32 = 101325.0;
    
    // Tait Equation of State
    fn pressure_EOS(rho: f32) -> f32 {
      return GAS_CONSTANT * (pow(rho / RHO_0, GAMMA) - 1.0);
    }
    
    // Hydrostatic pressure
    fn P_hydrostatic(depth: f32) -> f32 {
      return RHO_0 * G * depth;
    }
    
    // Siphon velocity (Bernoulli)
    fn v_siphon(height: f32) -> f32 {
      return sqrt(2.0 * G * height);
    }
    
    // Cubic spline kernel (2D)
    fn W_cubic(q: f32) -> f32 {
      if (q < 0.5) {
        return 0.4547 * (6.0 * q * q * q - 6.0 * q * q + 1.0);
      } else if (q < 1.0) {
        let t = 1.0 - q;
        return 0.4547 * 2.0 * t * t * t;
      }
      return 0.0;
    }
  `
};

// ============================================
// MICROVOLT PRECISION DATA
// ============================================
export const MICROVOLT_DATA = {
  // Thermal Noise (Johnson-Nyquist)
  // Vn = √(4kBTRΔf)
  THERMAL_NOISE: {
    at0_01Hz_1MOhm: 0.013e-6,   // V (0.013 μV)
    at0_1Hz_1MOhm: 0.041e-6,    // V (0.041 μV)
    at1Hz_1MOhm: 0.129e-6,      // V (0.129 μV) - key threshold
    at10Hz_1MOhm: 0.407e-6,     // V (0.407 μV)
    at100Hz_1MOhm: 1.29e-6,     // V (1.29 μV)
    at1000Hz_1MOhm: 4.07e-6,    // V (4.07 μV)
  },
  
  // SNR for 1 μV signal at 1Hz: ~60.4 linear = 17.8 dB
  SNR_1uV_1Hz: 60.4,
  
  // Single-Electron Effects
  SINGLE_ELECTRON: {
    // ΔV = e/C for various capacitances
    at0_1pF: 1.60e-6,           // V (1.60 μV)
    at1pF: 0.160e-6,            // V (0.160 μV = 160 nV)
    at10pF: 16e-9,              // V (16 nV)
    at100pF: 1.6e-9,            // V (1.6 nV)
  },
  
  // Charge Sensitivity (per 1 μV)
  CHARGE_SENSITIVITY: {
    at1pF: 1e-15,               // C (1 fC)
    at10pF: 10e-15,             // C (10 fC)
    at100pF: 100e-15,           // C (100 fC)
  },
  
  // Voltage Ramp Rate (dV/dt = I/C)
  calculateVoltageRamp: function(current, capacitance) {
    return current / capacitance;
  },
  
  // Time to accumulate 1 μV
  timeToMicrovolt: function(current, capacitance) {
    return (1e-6 * capacitance) / current;
  },
  
  // Energy of 1 μV
  calculateEnergy: function(capacitance) {
    return 0.5 * capacitance * (1e-6) ** 2;
  },
  
  ENERGY_1uV: {
    at1pF: 5e-25,               // J (~3.1×10⁻⁶ eV)
    at10pF: 5e-24,              // J
    at100pF: 5e-23,             // J
  },
  
  // Practical Simulation Parameters
  SIMULATION: {
    minVoltageStep: 0.1e-6,     // V (0.1 μV)
    typicalVoltageRange: 1e-3,  // V (0-1 mV)
    chargePerElectron: 0.16e-15,// C (0.16 fC)
    singleElectronOn1pF: 160e-9,// V (160 nV)
    realisticDropletCharge: { min: 50e-12, max: 200e-12 }, // C (50-200 pC)
    dropletFrequency: { min: 1, max: 10 }, // Hz
    capacitanceRange: { min: 1e-12, max: 100e-12 }, // F (1-100 pF)
    leakageCurrent: { min: 1e-12, max: 100e-12 }, // A (1-100 pA)
    thermalNoiseFloor: 0.129e-6,// V (0.129 μV RMS at 1Hz, 1MΩ)
    RCTimeConstant: { min: 0.0001, max: 0.1 }, // s (0.1-100 ms)
    chargeInductionEfficiency: { min: 0.01, max: 0.10 }, // 1-10%
  },
  
  // WGSL Shader Constants
  WGSL_CONSTANTS: `
    const K_B: f32 = 1.380649e-23;
    const E_CHARGE: f32 = 1.602176634e-19;
    const T_ROOM: f32 = 300.0;
    const ONE_MICROVOLT: f32 = 1e-6;
    
    // Thermal noise: Vn = sqrt(4*kB*T*R*Δf)
    fn thermal_noise(R: f32, delta_f: f32) -> f32 {
      return sqrt(4.0 * K_B * T_ROOM * R * delta_f);
    }
    
    // Single-electron voltage step
    fn single_electron_voltage(C: f32) -> f32 {
      return E_CHARGE / C;
    }
    
    // Voltage ramp rate dV/dt = I/C
    fn voltage_ramp(I: f32, C: f32) -> f32 {
      return I / C;
    }
  `
};

// ============================================
// UNIFIED PHYSICS SHADER LIBRARY
// ============================================
export const UNIFIED_PHYSICS_WGSL = `
  // ========================================
  // Physical Constants
  // ========================================
  const PI: f32 = 3.14159265359;
  const MU_0: f32 = 1.2566370614e-7;
  const EPSILON_0: f32 = 8.854187817e-12;
  const K_B: f32 = 1.380649e-23;
  const E_CHARGE: f32 = 1.602176634e-19;
  const G: f32 = 9.80665;
  
  // ========================================
  // SEG - Magnetic Field Functions
  // ========================================
  const SEG_BR: f32 = 1.48;
  const SEG_RING_RADIUS: f32 = 4.0;
  const SEG_NUM_ROLLERS: i32 = 12;
  const SEG_MAGNETIC_MOMENT: f32 = 5.635e6;
  
  fn seg_B_axial(z: f32, R: f32, h: f32) -> f32 {
    let t1 = (z + h) / sqrt((z + h) * (z + h) + R * R);
    let t2 = z / sqrt(z * z + R * R);
    return (SEG_BR / 2.0) * (t1 - t2);
  }
  
  fn seg_B_dipole(r: vec3f, m: vec3f) -> vec3f {
    let r_len = length(r);
    let r_norm = r / r_len;
    let r3 = r_len * r_len * r_len;
    let factor = MU_0 / (4.0 * PI * r3);
    let m_dot_r = dot(m, r_norm);
    return factor * (3.0 * m_dot_r * r_norm - m);
  }
  
  // ========================================
  // Kelvin - Electrostatic Functions
  // ========================================
  const KELVIN_BUCKET_CAP: f32 = 40.1e-12;
  const KELVIN_DROPLET_CHARGE: f32 = 1e-9;
  const KELVIN_E_BREAKDOWN: f32 = 3e6;
  
  fn kelvin_E_field(Q: f32, d: f32) -> f32 {
    return Q / (2.0 * PI * EPSILON_0 * (d / 2.0) * (d / 2.0));
  }
  
  fn kelvin_F_droplet(q: f32, E: f32) -> f32 {
    return q * E;
  }
  
  fn kelvin_spark_gap(V: f32) -> f32 {
    return V / KELVIN_E_BREAKDOWN;
  }
  
  fn kelvin_V_buildup(I: f32, t: f32) -> f32 {
    return (I * t) / KELVIN_BUCKET_CAP;
  }
  
  // ========================================
  // Heron - SPH Fluid Functions
  // ========================================
  const HERON_RHO_0: f32 = 1000.0;
  const HERON_GAS_CONST: f32 = 560571.0;
  const HERON_GAMMA: f32 = 7.0;
  
  fn heron_pressure_EOS(rho: f32) -> f32 {
    return HERON_GAS_CONST * (pow(rho / HERON_RHO_0, HERON_GAMMA) - 1.0);
  }
  
  fn heron_P_hydrostatic(depth: f32) -> f32 {
    return HERON_RHO_0 * G * depth;
  }
  
  fn heron_v_siphon(height: f32) -> f32 {
    return sqrt(2.0 * G * height);
  }
  
  // Cubic spline smoothing kernel
  fn heron_W_cubic(r: f32, h: f32) -> f32 {
    let q = r / h;
    let sigma = 8.0 / (PI * h * h * h);
    if (q < 0.5) {
      return sigma * (6.0 * q * q * q - 6.0 * q * q + 1.0);
    } else if (q < 1.0) {
      let t = 1.0 - q;
      return sigma * 2.0 * t * t * t;
    }
    return 0.0;
  }
  
  // ========================================
  // Microvolt Precision Functions
  // ========================================
  fn microvolt_thermal_noise(R: f32, delta_f: f32) -> f32 {
    return sqrt(4.0 * K_B * 300.0 * R * delta_f);
  }
  
  fn microvolt_single_electron_step(C: f32) -> f32 {
    return E_CHARGE / C;
  }
  
  fn microvolt_voltage_ramp(I: f32, C: f32) -> f32 {
    return I / C;
  }
`;

// ============================================
// EXPORT ALL DATA
// ============================================
export default {
  PHYSICAL_CONSTANTS,
  SEG_DATA,
  KELVIN_DATA,
  HERON_DATA,
  MICROVOLT_DATA,
  UNIFIED_PHYSICS_WGSL
};
