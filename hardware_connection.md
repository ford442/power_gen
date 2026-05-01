# SEG Hardware Connection Spec

## Overview
This document defines the protocol, wiring, and configuration for connecting the SEG WebGPU Visualizer to an Arduino-driven electromagnet array.

## Communication Protocol

### Physical Layer
- **Interface**: USB CDC Serial (UART over USB)
- **Baud Rate**: 115200 (configurable)
- **Line Ending**: `\n` (LF)
- **API**: Web Serial API (Chrome/Edge 113+)

### App → Arduino Commands

#### `P` - Phase Setpoint
```
P{phase},{speed},{mode}\n
```
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| phase | float | 0.0 – 360.0 | Target electrical angle in degrees |
| speed | float | -999.9 – 999.9 | Target speed in RPM (negative = reverse) |
| mode  | int   | 0, 1, 2 | 0=run, 1=brake, 2=coast |

Sent by the app at ~60Hz. Arduino extrapolates phase between commands using `speed`.

#### `C` - Manual Coil Override
```
C{coilMask},{pwmDuty},{durationMs}\n
```
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| coilMask | uint | 0 – 0xFFFF | Bitmask of coils to activate |
| pwmDuty  | int  | 0 – 255 | PWM duty cycle (255 = full on) |
| durationMs | int | 0 – 65535 | How long to hold (0 = infinite until next command) |

Immediately overrides automatic commutation. Send `C0,0,0` to release override.

#### `CONF` - Coil Geometry Configuration
```
CONF{numCoils},{offsetAngle},{dwellAngle},{advanceAngle}\n
```
| Field | Type | Description |
|-------|------|-------------|
| numCoils | int | Number of electromagnets (4, 6, 8, 12, etc.) |
| offsetAngle | float | Mechanical offset for coil 0 in degrees |
| dwellAngle | float | Angular width each coil stays active |
| advanceAngle | float | Lead angle for torque optimization |

### Arduino → App State Stream

#### `S` - Sensor State
```
S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}\n
```
| Field | Type | Description |
|-------|------|-------------|
| phase | float | Fused electrical angle 0-360° |
| rpm | float | Calculated revolutions per minute |
| magX | float | Magnetometer X in µT |
| magY | float | Magnetometer Y in µT |
| magZ | float | Magnetometer Z in µT |
| hallMask | uint | Bitmask of currently triggered hall sensors |
| coilMask | uint | Bitmask of currently active coils |
| timestampMs | uint | Arduino millis() at time of sample |

Streamed at 100–200Hz or on every hall state change.

#### `E` - Error
```
E{message}\n
```
Forwarded to browser console as an error.

#### `I` - Info/Debug
```
I{message}\n
```
Forwarded to browser console as a log.

## Coil Configuration Reference

### Default Dwell Angles
| Coils | Sector | Dwell (1.5x overlap) | Dwell (single) |
|-------|--------|----------------------|----------------|
| 4     | 90°    | 135°                 | 90°            |
| 6     | 60°    | 90°                  | 60°            |
| 8     | 45°    | 67.5°                | 45°            |
| 12    | 30°    | 45°                  | 30°            |

### Firing Patterns
- **single**: One coil on at a time, hard edges.
- **overlap**: Adjacent coils overlap by ~50% for smoother torque.
- **trapezoidal**: Ramped leading/trailing edges to reduce switching noise.
- **sinusoidal**: PWM-modulated sinusoidal envelope, lowest torque ripple.

## Wiring

### Arduino Pinout (Example: Uno/Nano)

#### Electromagnet Drivers (via MOSFET or DRV8871)
| Coil | Pin | Notes |
|------|-----|-------|
| 0    | D3  | PWM capable |
| 1    | D5  | PWM capable |
| 2    | D6  | PWM capable |
| 3    | D9  | PWM capable |
| 4    | D10 | PWM capable |
| 5    | D11 | PWM capable |

For >6 coils, use a Mega (D2–D13, D44–D46) or ESP32 (GPIO 0–33).

#### Hall Effect Sensors
| Sensor | Pin | Notes |
|--------|-----|-------|
| H0     | D2  | External interrupt |
| H1     | D3  | External interrupt |

More sensors can use pin-change interrupts on other digital pins.

#### Magnetometer (QMC5883L / HMC5883L)
| Signal | Pin |
|--------|-----|
| VCC    | 3.3V or 5V (module dependent) |
| GND    | GND |
| SDA    | A4 (Uno) / D20 (Mega) |
| SCL    | A5 (Uno) / D21 (Mega) |

### Power
- **Logic**: Arduino USB or 7–12V barrel jack.
- **Coils**: Separate 12V–24V supply, common ground with Arduino.
- **Flyback diode**: Required across every coil.

## Safety Rules
1. **Watchdog**: If no `P` command for >100ms, Arduino disables all coils.
2. **Current limiting**: Use PWM or series resistors to stay within driver/coil ratings.
3. **Thermal**: Monitor coil temperature; duty cycle should not exceed ratings.
4. **Back-EMF**: Flyback diodes mandatory. Without them, MOSFETs will fail.

## Sensor Fusion Notes

### Hall Sensors
- Provide instantaneous position pulses.
- Best for RPM calculation (pulse interval → frequency).
- Position resolution = 360° / numHallSensors.

### Magnetometer
- Provides continuous field vector.
- Angle derived from `atan2(magY, magX)` relative to sensor mounting.
- Update rate ~200Hz (I2C limited).
- Susceptible to stray fields and tilting.

### Fusion Strategy
```
extrapolatedPhase = lastTargetPhase + elapsed * targetSpeed * 6  // deg/s
magnetometerPhase = atan2(magY, magX) * (180/PI) + magOffset
fusedPhase = alpha * extrapolatedPhase + (1-alpha) * magnetometerPhase
```
Alpha is higher when magnetometer data is noisy or stale. Hall edges are used to snap `fusedPhase` to known angles and correct drift.
