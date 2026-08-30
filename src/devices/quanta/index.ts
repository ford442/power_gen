/**
 * Quanta Magnetics research apparatus plugins.
 */

import { registerDevice } from '../device-registry.js';
import { magneticLevitationPlugin } from './magnetic-levitation.js';
import { homopolarGeneratorPlugin } from './homopolar-generator.js';
import { halbachVizPlugin } from './halbach-viz.js';
import { pulseCoilPlugin } from './pulse-coil.js';
import { transformerPlugin } from './transformer.js';
import { vdgPlugin } from './van-de-graaff.js';
import { hallPlugin } from './hall-effect.js';

registerDevice(magneticLevitationPlugin);
registerDevice(homopolarGeneratorPlugin);
registerDevice(halbachVizPlugin);
registerDevice(pulseCoilPlugin);
registerDevice(transformerPlugin);
registerDevice(vdgPlugin);
registerDevice(hallPlugin);
