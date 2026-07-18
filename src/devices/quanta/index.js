/**
 * Quanta Magnetics research apparatus plugins.
 */

import { registerDevice } from '../device-registry.js';
import { magneticLevitationPlugin } from './magnetic-levitation.js';
import { homopolarGeneratorPlugin } from './homopolar-generator.js';

registerDevice(magneticLevitationPlugin);
registerDevice(homopolarGeneratorPlugin);
