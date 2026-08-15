/**
 * Quanta Magnetics research apparatus plugins.
 */

import { registerDevice } from '../device-registry.js';
import { magneticLevitationPlugin } from './magnetic-levitation.js';
import { homopolarGeneratorPlugin } from './homopolar-generator.js';
import { halbachVizPlugin } from './halbach-viz.js';
import { pulseCoilPlugin } from './pulse-coil.js';
import { transformerPlugin } from './transformer.js';

registerDevice(magneticLevitationPlugin);
registerDevice(homopolarGeneratorPlugin);
registerDevice(halbachVizPlugin);
registerDevice(pulseCoilPlugin);
registerDevice(transformerPlugin);
