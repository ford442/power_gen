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
// All constants verified against CODATA values via Wolfram Alpha

const PI: f32 = 3.14159265358979323846;
const TWO_PI: f32 = 6.28318530717958647692;
const FOUR_PI: f32 = 12.56637061435917295385;
const LN2: f32 = 0.69314718055994530942;  // ln(2) from Wolfram: NaturalLog[2]

// Planck constant: h = 6.62607015 × 10^-34 J⋅s (exact, defined value)
// Wolfram: https://www.wolframalpha.com/input?i=planck+constant
const PLANCK_J: f32 = 6.62607015e-34;      // J⋅s
const PLANCK_EV: f32 = 4.135667696e-15;    // eV⋅s (converted via h/e)

// Speed of light in vacuum: c = 299792458 m/s (exact, defined)
// Wolfram: https://www.wolframalpha.com/input?i=speed+of+light
const SPEED_OF_LIGHT: f32 = 2.99792458e8;  // m/s

// Elementary charge: e = 1.602176634 × 10^-19 C (exact, defined)
// Wolfram: https://www.wolframalpha.com/input?i=elementary+charge
const ELECTRON_CHARGE: f32 = 1.602176634e-19;  // C

// Boltzmann constant: k_B = 1.380649 × 10^-23 J/K (exact, defined)
// Wolfram: https://www.wolframalpha.com/input?i=boltzmann+constant
const BOLTZMANN: f32 = 1.380649e-23;  // J/K

// Stefan-Boltzmann constant: σ = 5.670374419... × 10^-8 W/(m²⋅K⁴)
// Wolfram: https://www.wolframalpha.com/input?i=stefan+boltzmann+constant
const STEFAN_BOLTZMANN: f32 = 5.670374419e-8;  // W/(m²⋅K⁴)

// Avogadro's number: N_A = 6.02214076 × 10^23 mol^-1 (exact, defined)
// Wolfram: https://www.wolframalpha.com/input?i=avogadro+number
const AVOGADRO: f32 = 6.02214076e23;  // mol^-1

// =============================================================================
// MATERIAL CONSTANTS
// =============================================================================

// Refractive indices at 589 nm (sodium D-line) unless noted
// Source: Wolfram Alpha material properties database

// Air at STP: n ≈ 1.000293
// Wolfram: https://www.wolframalpha.com/input?i=refractive+index+of+air
const N_AIR: f32 = 1.000293;

// Silicon at 600 nm: n ≈ 3.9-4.0 (wavelength dependent)
// Wolfram: https://www.wolframalpha.com/input?i=refractive+index+of+silicon
const N_SILICON: f32 = 3.97;

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
