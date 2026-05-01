#ifndef SENSOR_MANAGER_H
#define SENSOR_MANAGER_H

#include <Arduino.h>
#include "protocol.h"

class SensorManager {
public:
  SensorManager();

  void begin(const uint8_t* hallPins, uint8_t numHalls);

  // Must be called frequently to read magnetometer
  void update();

  // Hall interrupt handlers (call from ISR)
  void onHallPulse(uint8_t hallIndex);

  float getPhase() const { return _fusedPhase; }
  float getRpm() const { return _rpm; }
  float getMagX() const { return _magX; }
  float getMagY() const { return _magY; }
  float getMagZ() const { return _magZ; }
  uint32_t getHallMask() const { return _hallMask; }

  void setMagnetometerOffset(float x, float y, float z);
  void resetFusion();

private:
  // Hall sensors
  uint8_t _hallPins[MAX_HALLS];
  uint8_t _numHalls;
  volatile uint32_t _hallMask;
  volatile uint32_t _lastHallTime[MAX_HALLS];
  volatile float _rpm; // updated from ISR

  // Magnetometer (QMC5883L / HMC5883L)
  float _magX, _magY, _magZ;
  float _magOffsetX, _magOffsetY, _magOffsetZ;
  bool _magAvailable;
  uint8_t _magAddr; // 0x0D for QMC5883L, 0x1E for HMC5883L

  // Fusion
  float _fusedPhase;
  float _extrapolatedPhase;
  float _lastFusionTime;
  float _fusionAlpha;

  void readMagnetometer();
  void fuse();
  float magnetometerToPhase();
};

#endif // SENSOR_MANAGER_H
