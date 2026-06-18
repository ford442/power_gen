// DATA STRUCTURES
// =============================================================================

/// Photon packet representing a quantum of light energy
/// Physics: Photon energy E = hf = hc/λ (Planck-Einstein relation)
/// Wolfram: https://www.wolframalpha.com/input?i=photon+energy
struct Photon {
    position: vec3f,     // World-space position (m)
    direction: vec3f,    // Unit vector propagation direction
    energy: f32,         // Photon energy (eV)
    wavelength: f32,     // Wavelength (nm)
    intensity: f32,      // Relative intensity 0-1 (accounts for losses)
    path_length: f32,    // Distance traveled from source (m)
    bounces: u32,        // Number of reflections/interactions
}

/// LED emitter parameters
/// Models various LED types with spectral and geometric properties
struct LEDParams {
    position: vec3f,     // World-space position (m)
    normal: vec3f,       // Emission direction (unit vector)
    color_type: u32,     // 0=red, 1=green, 2=blue, 3=white, 4=amber, 5=uv, 6=ir
    power: f32,          // Electrical power input (W)
    luminous_efficacy: f32,  // lm/W (theoretical max: 683 lm/W for 555nm)
    emission_angle: f32, // Half-angle of emission cone (degrees)
    radius: f32,         // Physical radius of LED emitter (m)
    active: u32,         // 0=off, 1=on
}

/// Solar panel/cell parameters
/// Models silicon photovoltaic cell response
struct SolarCellParams {
    position: vec3f,     // Center position of panel (m)
    normal: vec3f,       // Surface normal (unit vector, points toward light)
    tangent: vec3f,      // Tangent vector for UV mapping
    bitangent: vec3f,    // Bitangent vector for UV mapping
    width: f32,          // Panel width (m)
    height: f32,         // Panel height (m)
    area: f32,           // Panel area (m²) = width * height
    efficiency: f32,     // Peak efficiency at STC (0-1, typical: 0.18-0.24)
    temperature: f32,    // Operating temperature (°C)
    series_resistance: f32,  // Ohms
    shunt_resistance: f32,   // Ohms
}

/// Simulation configuration and runtime parameters
struct SimulationConfig {
    photon_count: u32,       // Total photons to simulate
    max_bounces: u32,        // Maximum reflections per photon
    wavelength_min: f32,     // Minimum wavelength in simulation (nm)
    wavelength_max: f32,     // Maximum wavelength in simulation (nm)
    ambient_temperature: f32, // Ambient temp (°C)
    time_step: f32,          // Simulation time step (s)
    enable_fresnel: u32,     // 0=disable, 1=enable Fresnel reflections
    enable_scattering: u32,  // 0=disable, 1=enable atmospheric scattering
}

/// Simulation results aggregated across all compute threads
struct SimulationResult {
    emitted_photons: u32,     // Total photons emitted by LEDs
    absorbed_photons: u32,    // Photons absorbed by solar cell
    reflected_photons: u32,   // Photons reflected away
    transmitted_photons: u32, // Photons passing through cell
    total_energy_emitted: f32,   // Total energy emitted (J)
    total_energy_absorbed: f32,  // Total energy absorbed (J)
    photocurrent: f32,        // Generated current (A)
    photovoltage: f32,        // Open-circuit voltage (V)
    output_power: f32,        // Maximum power output (W)
    fill_factor: f32,         // Solar cell fill factor (0-1)
    conversion_efficiency: f32, // Overall LED-to-electricity efficiency
}

/// Per-pixel irradiance data for the solar panel surface
struct IrradianceData {
    spectral_density: vec4f,  // RGBA channels = integrated irradiance bands
    total_irradiance: f32,    // W/m² integrated over all wavelengths
    photon_flux: f32,         // Photons/(m²⋅s)
    peak_wavelength: f32,     // Dominant wavelength at this position (nm)
}

/// IV curve point for solar cell characterization
struct IVCurvePoint {
    voltage: f32,  // Volts
    current: f32,  // Amps
    power: f32,    // Watts = V × I
}

// =============================================================================
// UNIFORM BUFFER BINDINGS
// =============================================================================

@binding(0) @group(0) var<storage, read_write> photon_buffer: array<Photon>;
@binding(1) @group(0) var<storage, read_write> irradiance_buffer: array<IrradianceData>;
@binding(2) @group(0) var<uniform> led_params: array<LEDParams, 16>;  // Max 16 LEDs
@binding(3) @group(0) var<uniform> solar_cell: SolarCellParams;
@binding(4) @group(0) var<uniform> config: SimulationConfig;
@binding(5) @group(0) var<storage, read_write> simulation_result: SimulationResult;
@binding(6) @group(0) var<storage, read_write> iv_curve: array<IVCurvePoint>;
@binding(7) @group(0) var<uniform> time: f32;

// =============================================================================
