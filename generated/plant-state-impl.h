// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// SEGSimulator::plantSave / plantLoad bodies (#224 §2). Included once, by
// cpp/src/plant/plant_state.cpp; the layout is in generated/plant-state.h.

int SEGSimulator::plantStateSize(int mode) const {
    return (mode >= 0 && mode < SIM_MODE_COUNT) ? PLANT_STATE_SIZES[mode] : 0;
}

int SEGSimulator::plantSave(int mode) {
    static_assert(sizeof(_rollers) / sizeof(_rollers[0]) == 66,
                  "physics/devices.json seg state: @_rollers[].omega count must match the array length");
    static_assert(sizeof(_ringLoadTorques) / sizeof(_ringLoadTorques[0]) == 3,
                  "physics/devices.json seg state: @_ringLoadTorques[] count must match the array length");
    const int n = plantStateSize(mode);
    if (n <= 0) return 0;
    float* s = reinterpret_cast<float*>(getScratchPtr(n));
    s[0] = _time;
    s[1] = _drive;
    switch (mode) {
        case SIM_MODE_SEG:
            for (int i = 0; i < 66; ++i) s[2 + i] = _rollers[i].omega;
            for (int i = 0; i < 66; ++i) s[68 + i] = _rollers[i].angle;
            for (int i = 0; i < 3; ++i) s[134 + i] = _ringLoadTorques[i];
            break;
        case SIM_MODE_HERON:
            s[2] = _heron.head;
            s[3] = _heron.vExit;
            s[4] = _heron.flowLmin;
            s[5] = _heron.pressureKPa;
            s[6] = _heron.reynolds;
            s[7] = _heron.drive;
            break;
        case SIM_MODE_KELVIN:
            s[2] = _kelvin.voltage;
            s[3] = _kelvin.sparkTimer;
            s[4] = _kelvin.voltageN;
            s[5] = _kelvin.E;
            s[6] = _kelvin.seedV;
            s[7] = _kelvin.drive;
            break;
        case SIM_MODE_SOLAR:
            s[2] = _solar.batteryCharge;
            s[3] = _solar.ledPower;
            break;
        case SIM_MODE_PELTIER:
            s[2] = _peltier.hotK;
            s[3] = _peltier.coldK;
            s[4] = _peltier.deltaTK;
            s[5] = _peltier.voltageV;
            s[6] = _peltier.currentA;
            s[7] = _peltier.powerW;
            s[8] = _peltier.cop;
            s[9] = _peltier.drive;
            break;
        case SIM_MODE_MHD:
            s[2] = _mhd.flowU;
            s[3] = _mhd.bFieldT;
            s[4] = _mhd.hartmann;
            s[5] = _mhd.voltageV;
            s[6] = _mhd.currentA;
            s[7] = _mhd.powerW;
            s[8] = _mhd.drive;
            break;
        case SIM_MODE_MAGLEV:
            s[2] = _maglev.gap;
            s[3] = _maglev.gapVel;
            s[4] = _maglev.gapMm;
            s[5] = _maglev.fieldT;
            s[6] = _maglev.liftN;
            s[7] = _maglev.rpm;
            s[8] = _maglev.drive;
            break;
        case SIM_MODE_HOMOPOLAR:
            s[2] = _homopolar.omega;
            s[3] = _homopolar.angle;
            s[4] = _homopolar.rpm;
            s[5] = _homopolar.emfV;
            s[6] = _homopolar.currentA;
            s[7] = _homopolar.fieldT;
            s[8] = _homopolar.drive;
            break;
        case SIM_MODE_TRANSFORMER:
            s[2] = _transformer.phase;
            s[3] = _transformer.leakage ? 1.f : 0.f;
            s[4] = _transformer.v1;
            s[5] = _transformer.v2;
            s[6] = _transformer.i1;
            s[7] = _transformer.i2;
            s[8] = _transformer.k;
            s[9] = _transformer.fluxN;
            s[10] = _transformer.drive;
            break;
        case SIM_MODE_VDG:
            s[2] = _vdg.chargeC;
            s[3] = _vdg.voltage;
            s[4] = _vdg.beltMps;
            s[5] = _vdg.sparkTimer;
            s[6] = _vdg.sparkAccum;
            s[7] = _vdg.sparkWindowT;
            s[8] = _vdg.sparkHz;
            s[9] = _vdg.drive;
            break;
        case SIM_MODE_HALL:
            s[2] = _hall.current;
            s[3] = _hall.fieldT;
            s[4] = _hall.voltage;
            s[5] = _hall.coeff;
            s[6] = _hall.carrierMetal ? 1.f : 0.f;
            s[7] = _hall.fieldCoupledT;
            s[8] = _hall.drive;
            break;
        case SIM_MODE_LORENTZ_SLED:
            s[2] = _lorentz.velocityMps;
            s[3] = _lorentz.currentA;
            s[4] = _lorentz.positionM;
            s[5] = _lorentz.forceN;
            s[6] = _lorentz.fieldT;
            s[7] = _lorentz.drive;
            break;
        case SIM_MODE_JUMPING_RING:
            s[2] = _thomson.primaryIA;
            s[3] = _thomson.ringCurrentA;
            s[4] = _thomson.velocityMps;
            s[5] = _thomson.heightM;
            s[6] = _thomson.phase;
            s[7] = _thomson.forceN;
            s[8] = _thomson.couplingK;
            s[9] = _thomson.drive;
            break;
        default:
            break;
    }
    return n;
}

bool SEGSimulator::plantLoad(int mode, int count, uint32_t layoutHash) {
    const int n = plantStateSize(mode);
    if (layoutHash != PLANT_STATE_LAYOUT_HASH || n <= 0 || count != n) return false;
    if (static_cast<int>(_scratch.size()) < n) return false;
    const float* s = _scratch.data();
    for (int i = 0; i < n; ++i) {
        if (!std::isfinite(s[i])) return false;
    }
    _time = s[0];
    _drive = s[1];
    switch (mode) {
        case SIM_MODE_SEG:
            for (int i = 0; i < 66; ++i) _rollers[i].omega = s[2 + i];
            for (int i = 0; i < 66; ++i) _rollers[i].angle = s[68 + i];
            for (int i = 0; i < 3; ++i) _ringLoadTorques[i] = s[134 + i];
            break;
        case SIM_MODE_HERON:
            _heron.head = s[2];
            _heron.vExit = s[3];
            _heron.flowLmin = s[4];
            _heron.pressureKPa = s[5];
            _heron.reynolds = s[6];
            _heron.drive = s[7];
            break;
        case SIM_MODE_KELVIN:
            _kelvin.voltage = s[2];
            _kelvin.sparkTimer = s[3];
            _kelvin.voltageN = s[4];
            _kelvin.E = s[5];
            _kelvin.seedV = s[6];
            _kelvin.drive = s[7];
            break;
        case SIM_MODE_SOLAR:
            _solar.batteryCharge = s[2];
            _solar.ledPower = s[3];
            break;
        case SIM_MODE_PELTIER:
            _peltier.hotK = s[2];
            _peltier.coldK = s[3];
            _peltier.deltaTK = s[4];
            _peltier.voltageV = s[5];
            _peltier.currentA = s[6];
            _peltier.powerW = s[7];
            _peltier.cop = s[8];
            _peltier.drive = s[9];
            break;
        case SIM_MODE_MHD:
            _mhd.flowU = s[2];
            _mhd.bFieldT = s[3];
            _mhd.hartmann = s[4];
            _mhd.voltageV = s[5];
            _mhd.currentA = s[6];
            _mhd.powerW = s[7];
            _mhd.drive = s[8];
            break;
        case SIM_MODE_MAGLEV:
            _maglev.gap = s[2];
            _maglev.gapVel = s[3];
            _maglev.gapMm = s[4];
            _maglev.fieldT = s[5];
            _maglev.liftN = s[6];
            _maglev.rpm = s[7];
            _maglev.drive = s[8];
            break;
        case SIM_MODE_HOMOPOLAR:
            _homopolar.omega = s[2];
            _homopolar.angle = s[3];
            _homopolar.rpm = s[4];
            _homopolar.emfV = s[5];
            _homopolar.currentA = s[6];
            _homopolar.fieldT = s[7];
            _homopolar.drive = s[8];
            break;
        case SIM_MODE_TRANSFORMER:
            _transformer.phase = s[2];
            _transformer.leakage = s[3] != 0.f;
            _transformer.v1 = s[4];
            _transformer.v2 = s[5];
            _transformer.i1 = s[6];
            _transformer.i2 = s[7];
            _transformer.k = s[8];
            _transformer.fluxN = s[9];
            _transformer.drive = s[10];
            break;
        case SIM_MODE_VDG:
            _vdg.chargeC = s[2];
            _vdg.voltage = s[3];
            _vdg.beltMps = s[4];
            _vdg.sparkTimer = s[5];
            _vdg.sparkAccum = s[6];
            _vdg.sparkWindowT = s[7];
            _vdg.sparkHz = s[8];
            _vdg.drive = s[9];
            break;
        case SIM_MODE_HALL:
            _hall.current = s[2];
            _hall.fieldT = s[3];
            _hall.voltage = s[4];
            _hall.coeff = s[5];
            _hall.carrierMetal = s[6] != 0.f;
            _hall.fieldCoupledT = s[7];
            _hall.drive = s[8];
            break;
        case SIM_MODE_LORENTZ_SLED:
            _lorentz.velocityMps = s[2];
            _lorentz.currentA = s[3];
            _lorentz.positionM = s[4];
            _lorentz.forceN = s[5];
            _lorentz.fieldT = s[6];
            _lorentz.drive = s[7];
            break;
        case SIM_MODE_JUMPING_RING:
            _thomson.primaryIA = s[2];
            _thomson.ringCurrentA = s[3];
            _thomson.velocityMps = s[4];
            _thomson.heightM = s[5];
            _thomson.phase = s[6];
            _thomson.forceN = s[7];
            _thomson.couplingK = s[8];
            _thomson.drive = s[9];
            break;
        default:
            break;
    }
    packRollerState();
    return true;
}
