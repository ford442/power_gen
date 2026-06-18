// COMPUTE SHADER ENTRY POINTS
// =============================================================================

/// Compute shader: Initialize photon emission from LEDs
///
/// Each thread handles multiple photons to achieve high throughput
///
/// @param id - Global invocation ID
@compute @workgroup_size(64)
fn emit_photons(
    @builtin(global_invocation_id) id: vec3u,
    @builtin(num_workgroups) num_groups: vec3u
) {
    let global_id = id.x;
    let total_threads = num_groups.x * 64u;
    
    // Calculate which LED and photon this thread handles
    let led_count = 16u;  // Max LEDs
    let photons_per_led = config.photon_count / led_count;
    
    var rng = random_init(global_id + u32(time * 1000.0), 1u);
    
    for (var led_idx: u32 = 0u; led_idx < led_count; led_idx = led_idx + 1u) {
        let led = led_params[led_idx];
        
        if (led.active == 0u) {
            continue;
        }
        
        // Distribute photons across threads
        let photons_to_emit = photons_per_led / total_threads;
        let base_photon_idx = led_idx * photons_per_led + global_id * photons_to_emit;
        
        for (var i: u32 = 0u; i < photons_to_emit; i = i + 1u) {
            let photon_idx = base_photon_idx + i;
            if (photon_idx >= arrayLength(&photon_buffer)) {
                continue;
            }
            
            // Sample wavelength from LED spectrum
            let wavelength = sample_led_wavelength(random_next(&rng) + photon_idx, led.color_type);
            
            // Calculate photon energy
            let energy_ev = photon_energy(wavelength);
            
            // Sample position on LED surface
            let disk = random_on_disk(&rng);
            let offset = disk.x * vec3f(1.0, 0.0, 0.0) + disk.y * vec3f(0.0, 1.0, 0.0);
            let position = led.position + offset * led.radius;
            
            // Sample direction within emission cone
            let emission_half_angle = radians(led.emission_angle);
            let cos_half_angle = cos(emission_half_angle);
            let direction = random_in_cone(&rng, led.normal, cos_half_angle);
            
            // Calculate intensity based on Lambertian emission pattern
            // I(θ) = I₀ cos(θ) for diffuse emitter
            let cos_theta = dot(direction, led.normal);
            let intensity = max(0.0, cos_theta);
            
            // Store photon
            var photon: Photon;
            photon.position = position;
            photon.direction = direction;
            photon.energy = energy_ev;
            photon.wavelength = wavelength;
            photon.intensity = intensity;
            photon.path_length = 0.0;
            photon.bounces = 0u;
            
            photon_buffer[photon_idx] = photon;
            
            // Atomically increment emitted count
            // Note: In real implementation, use atomicAdd
            // simulation_result.emitted_photons += 1u;
        }
    }
}

/// Compute shader: Trace photons to solar panel
///
/// Calculates intersection, reflection, and absorption at panel surface
///
/// @param id - Global invocation ID
@compute @workgroup_size(64)
fn trace_to_panel(
    @builtin(global_invocation_id) id: vec3u
) {
    let global_id = id.x;
    
    if (global_id >= arrayLength(&photon_buffer)) {
        return;
    }
    
    var photon = photon_buffer[global_id];
    
    // Skip if photon already processed
    if (photon.intensity <= 0.0) {
        return;
    }
    
    // Calculate intersection with solar panel plane
    // Plane equation: (p - p₀) · n = 0
    // Ray equation: p = o + td
    // Intersection: t = (p₀ - o) · n / (d · n)
    
    let panel_normal = solar_cell.normal;
    let panel_pos = solar_cell.position;
    
    let denom = dot(photon.direction, panel_normal);
    
    // Check if ray is parallel to plane or pointing away
    if (denom >= 0.0) {
        // Photon missing panel or hitting back side
        // Mark as transmitted/reflected away
        photon.intensity = 0.0;
        photon_buffer[global_id] = photon;
        return;
    }
    
    let t = dot(panel_pos - photon.position, panel_normal) / denom;
    
    // Check if intersection is behind photon
    if (t < 0.0) {
        photon.intensity = 0.0;
        photon_buffer[global_id] = photon;
        return;
    }
    
    // Calculate intersection point
    let hit_point = photon.position + photon.direction * t;
    
    // Check if hit point is within panel bounds
    let local_x = dot(hit_point - panel_pos, solar_cell.tangent);
    let local_y = dot(hit_point - panel_pos, solar_cell.bitangent);
    
    let half_width = solar_cell.width * 0.5;
    let half_height = solar_cell.height * 0.5;
    
    if (abs(local_x) > half_width || abs(local_y) > half_height) {
        // Missed panel
        photon.intensity = 0.0;
        photon_buffer[global_id] = photon;
        return;
    }
    
    // Calculate Fresnel reflection
    let cos_theta = max(0.0, -dot(photon.direction, panel_normal));
    let reflectance = select(0.0, fresnel_reflectance(cos_theta, N_AIR, N_SILICON), config.enable_fresnel == 1u);
    
    // Absorbed fraction
    let absorbed_fraction = 1.0 - reflectance;
    
    // Apply Beer-Lambert law for absorption in silicon
    let absorption_depth = silicon_penetration_depth(photon.wavelength);
    let silicon_thickness = SILICON_CELL_THICKNESS;
    
    // Probability of absorption within cell thickness
    // P(abs) = 1 - exp(-thickness/penetration_depth)
    let absorption_prob = 1.0 - exp(-silicon_thickness / absorption_depth);
    
    // Update photon state
    photon.path_length = photon.path_length + t;
    photon.position = hit_point;
    
    // Store irradiance data
    // Calculate UV coordinates for buffer indexing
    let u = (local_x + half_width) / solar_cell.width;
    let v = (local_y + half_height) / solar_cell.height;
    
    let buffer_width = 256u;  // Resolution of irradiance buffer
    let buffer_height = 256u;
    let buf_x = u32(u * f32(buffer_width - 1u));
    let buf_y = u32(v * f32(buffer_height - 1u));
    let buf_idx = buf_y * buffer_width + buf_x;
    
    if (buf_idx < arrayLength(&irradiance_buffer)) {
        var irradiance = irradiance_buffer[buf_idx];
        
        // Accumulate spectral irradiance
        let power_contribution = photon.intensity * absorbed_fraction * absorption_prob;
        
        // Categorize by wavelength (simplified spectral bins)
        if (photon.wavelength < 450.0) {
            irradiance.spectral_density[0] += power_contribution;  // Blue
        } else if (photon.wavelength < 570.0) {
            irradiance.spectral_density[1] += power_contribution;  // Green
        } else if (photon.wavelength < 620.0) {
            irradiance.spectral_density[2] += power_contribution;  // Yellow/Orange
        } else {
            irradiance.spectral_density[3] += power_contribution;  // Red
        }
        
        irradiance.total_irradiance += power_contribution;
        irradiance.photon_flux += absorbed_fraction * absorption_prob;
        
        // Update peak wavelength (weighted average)
        let old_flux = irradiance.photon_flux - absorbed_fraction * absorption_prob;
        irradiance.peak_wavelength = (irradiance.peak_wavelength * old_flux + photon.wavelength * absorbed_fraction * absorption_prob) / irradiance.photon_flux;
        
        irradiance_buffer[buf_idx] = irradiance;
    }
    
    // Update simulation result
    if (absorbed_fraction * absorption_prob > 0.01) {
        photon.intensity = 0.0;  // Absorbed
        // Atomic increment would be used here
        // simulation_result.absorbed_photons += 1u;
        // simulation_result.total_energy_absorbed += photon.energy * ELECTRON_CHARGE * absorbed_fraction * absorption_prob;
    } else {
        photon.intensity = 0.0;  // Transmitted through
        // simulation_result.transmitted_photons += 1u;
    }
    
    photon_buffer[global_id] = photon;
}

/// Compute shader: Calculate solar cell electrical output
///
/// Integrates absorbed photons across spectrum and applies quantum efficiency
///
/// @param id - Global invocation ID
@compute @workgroup_size(64)
fn calculate_solar_output(
    @builtin(global_invocation_id) id: vec3u
) {
    let global_id = id.x;
    let total_pixels = arrayLength(&irradiance_buffer);
    
    if (global_id >= total_pixels) {
        return;
    }
    
    let irradiance = irradiance_buffer[global_id];
    
    if (irradiance.photon_flux <= 0.0) {
        return;
    }
    
    // Calculate pixel area
    let pixel_area = solar_cell.area / f32(total_pixels);
    
    // Estimate photocurrent from photon flux and QE
    // Use peak wavelength as representative
    let wavelength = irradiance.peak_wavelength;
    let qe = external_quantum_efficiency(wavelength);
    let photon_rate = irradiance.photon_flux * pixel_area;  // photons/s
    let pixel_current = photon_rate * qe * ELECTRON_CHARGE;  // Amps
    
    // Accumulate into global result (atomic operations would be used)
    // simulation_result.photocurrent += pixel_current;
    
    // Calculate contribution to output power
    let cell_voltage = 0.6;  // Typical Si cell voltage at MPP (V)
    let pixel_power = pixel_current * cell_voltage;
    
    // simulation_result.output_power += pixel_power;
}

/// Compute shader: Generate IV curve points
///
/// Calculates current-voltage characteristics for the solar cell
///
/// @param id - Global invocation ID
@compute @workgroup_size(64)
fn generate_iv_curve(
    @builtin(global_invocation_id) id: vec3u
) {
    let point_idx = id.x;
    let num_points = arrayLength(&iv_curve);
    
    if (point_idx >= num_points) {
        return;
    }
    
    // Calculate total photocurrent
    var total_photocurrent: f32 = 0.0;
    for (var i: u32 = 0u; i < arrayLength(&irradiance_buffer); i = i + 1u) {
        let irradiance = irradiance_buffer[i];
        if (irradiance.photon_flux > 0.0) {
            let pixel_area = solar_cell.area / f32(arrayLength(&irradiance_buffer));
            let qe = external_quantum_efficiency(irradiance.peak_wavelength);
            total_photocurrent += irradiance.photon_flux * pixel_area * qe * ELECTRON_CHARGE;
        }
    }
    
    // Single-diode model parameters
    let isc = total_photocurrent;
    let voc = 0.65;  // Typical open-circuit voltage (V)
    let n = 1.3;     // Ideality factor
    let temp_k = solar_cell.temperature + 273.15;
    let v_thermal = BOLTZMANN * temp_k / ELECTRON_CHARGE;
    
    // Calculate saturation current from Voc
    // I_sc = I_s (exp(V_oc / (n V_T)) - 1)
    let i_s = isc / (exp(voc / (n * v_thermal)) - 1.0);
    
    // Voltage sweep from 0 to Voc
    let voltage = voc * f32(point_idx) / f32(num_points - 1u);
    
    // Single-diode equation: I = I_ph - I_s (exp((V + IR_s) / (n V_T)) - 1) - (V + IR_s) / R_sh
    let rs = solar_cell.series_resistance;
    let rsh = solar_cell.shunt_resistance;
    
    // Iterative solution for current (simplified - assumes small R_s)
    let diode_current = i_s * (exp(voltage / (n * v_thermal)) - 1.0);
    let shunt_current = voltage / rsh;
    let current = isc - diode_current - shunt_current;
    
    let power = voltage * current;
    
    iv_curve[point_idx] = IVCurvePoint(voltage, current, power);
}

// =============================================================================
