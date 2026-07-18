/**
 * Halbach array field helpers — re-exported from shared physics library.
 * Maglev imports `estimateHalbachFieldT` from here.
 */

export {
  estimateHalbachFieldT,
  buildHalbachSegments,
  halbachFieldAt,
  halbachPeriodM,
  estimatePeakFieldT,
  estimateDipoleForceN,
  traceHalbachFieldLines,
  sampleFieldHeatmap,
  MAGNET_BR,
  MU0
} from '../../physics/magnetic-field';

export type {
  HalbachConfig,
  HalbachSegment,
  HalbachLayout,
  Vec3,
  FieldLineSeed
} from '../../physics/magnetic-field';
