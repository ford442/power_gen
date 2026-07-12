// =============================================================================
// LED-Solar Simulation Shader
// =============================================================================
// Physics-based simulation of LED photon emission, transport, and photovoltaic
// conversion in silicon solar cells.
//
// Physics References (Wolfram Alpha verified):
// - Planck-Einstein relation: E = hc/λ
//   https://www.wolframalpha.com/input?i=planck+relation
// - Fresnel equations for electromagnetic reflection
//   https://www.wolframalpha.com/input?i=fresnel+equations
// - Silicon absorption coefficient (ASPERS data)
//   https://www.wolframalpha.com/input?i=silicon+absorption+coefficient
// - Solar cell quantum efficiency physics
//   https://www.wolframalpha.com/input?i=solar+cell+quantum+efficiency
// =============================================================================

// =============================================================================
// =============================================================================
// LED-Solar Simulation Shader
// =============================================================================
// Physics-based simulation of LED photon emission, transport, and photovoltaic
// conversion in silicon solar cells.
//
// Physics References (Wolfram Alpha verified):
// - Planck-Einstein relation: E = hc/λ
//   https://www.wolframalpha.com/input?i=planck+relation
// - Fresnel equations for electromagnetic reflection
//   https://www.wolframalpha.com/input?i=fresnel+equations
// - Silicon absorption coefficient (ASPERS data)
//   https://www.wolframalpha.com/input?i=silicon+absorption+coefficient
// - Solar cell quantum efficiency physics
//   https://www.wolframalpha.com/input?i=solar+cell+quantum+efficiency
// =============================================================================

// =============================================================================
// PHYSICAL CONSTANTS
// =============================================================================
// CODATA / device core values: physics/constants.json → generated/constants.wgsl

#include "generated/constants.wgsl"

const TWO_PI: f32 = TAU;
const FOUR_PI: f32 = TAU * 2.0;
const LN2: f32 = 0.69314718055994530942;  // ln(2) from Wolfram: NaturalLog[2]

// Aliases used by led-solar-physics.wgsl
const ELECTRON_CHARGE: f32 = E_CHARGE;
const BOLTZMANN: f32 = K_B;
const N_SILICON: f32 = N_SILICON_LED;

// Planck constant in eV⋅s (converted via h/e)
const PLANCK_EV: f32 = 4.135667696e-15;

// =============================================================================
// MATERIAL CONSTANTS
// =============================================================================

// Refractive indices at 589 nm (sodium D-line) unless noted
// Source: Wolfram Alpha material properties database

// Air at STP: n ≈ 1.000293
// Wolfram: https://www.wolframalpha.com/input?i=refractive+index+of+air
// N_AIR from generated/constants.wgsl (MATERIALS.nAir)

// Silicon at 600 nm: n ≈ 3.9-4.0 (wavelength dependent)
// Wolfram: https://www.wolframalpha.com/input?i=refractive+index+of+silicon
// N_SILICON alias → N_SILICON_LED from generated/constants.wgsl

// Silica glass (SiO₂): n ≈ 1.46
// Wolfram: https://www.wolframalpha.com/input?i=refractive+index+of+silica
const N_SILICA: f32 = 1.458;

// LED encapsulant (epoxy): n ≈ 1.5-1.6
const N_EPOXY: f32 = 1.55;

// =============================================================================
// LED SPECTRAL CHARACTERISTICS
// =============================================================================
// Typical wavelengths and spectral widths (FWHM) for common LED types
// Sources: LED datasheets, Wolfram material properties

// Red LED (AlGaAs): peak ~650 nm, FWHM ~20-30 nm
// Wolfram: https://www.wolframalpha.com/input?i=red+LED+wavelength
const LED_RED_WL: f32 = 650.0;      // nm
const LED_RED_FWHM: f32 = 25.0;     // nm

// Green LED (InGaN): peak ~530 nm, FWHM ~30-40 nm
// Wolfram: https://www.wolframalpha.com/input?i=green+LED+wavelength
const LED_GREEN_WL: f32 = 530.0;    // nm
const LED_GREEN_FWHM: f32 = 35.0;   // nm

// Blue LED (InGaN): peak ~470 nm, FWHM ~20-30 nm
// Wolfram: https://www.wolframalpha.com/input?i=blue+LED+wavelength
const LED_BLUE_WL: f32 = 470.0;     // nm
const LED_BLUE_FWHM: f32 = 25.0;    // nm

// Amber/Orange LED: peak ~590 nm
const LED_AMBER_WL: f32 = 590.0;    // nm
const LED_AMBER_FWHM: f32 = 20.0;   // nm

// White LED (phosphor-converted): CCT ~2700K-6500K
// Correlated Color Temperature for cool white
const LED_WHITE_CCT: f32 = 6000.0;  // K

// UV LED: peak ~365-405 nm
const LED_UV_WL: f32 = 395.0;       // nm
const LED_UV_FWHM: f32 = 15.0;      // nm

// IR LED: peak ~850-940 nm (common for remote controls)
const LED_IR_WL: f32 = 940.0;       // nm
const LED_IR_FWHM: f32 = 50.0;      // nm

// =============================================================================
// SILICON SOLAR CELL PROPERTIES
// =============================================================================
// Based on crystalline silicon PV cell physics

// Bandgap of silicon at 300K: E_g = 1.12 eV
// Wolfram: https://www.wolframalpha.com/input?i=silicon+bandgap
const SILICON_BANDGAP_EV: f32 = 1.12;  // eV
const SILICON_BANDGAP_J: f32 = 1.794e-19;  // J

// Wavelength corresponding to bandgap: λ_g = hc/E_g ≈ 1107 nm
const SILICON_BANDGAP_WL: f32 = 1107.0;  // nm

// Typical cell thickness: 100-300 μm for crystalline Si
const SILICON_CELL_THICKNESS: f32 = 180e-6;  // m (180 μm)

// =============================================================================
