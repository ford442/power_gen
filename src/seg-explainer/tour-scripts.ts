/**
 * Every guided-tour script, keyed like `LAB_TOURS`. A lazy chunk: a player
 * fetches it on its first start, so ~70 kB of tour text stays out of the
 * entry bundle (#224: new features must not grow it).
 */
import tourScript from './seg-tour.json';
import vdgTourScript from './vdg-tour.json';
import lorentzTourScript from './lorentz-sled-tour.json';
import jumpingRingTourScript from './jumping-ring-tour.json';
import dropTubeTourScript from './drop-tube-tour.json';
import hallTourScript from './hall-tour.json';
import transformerTourScript from './transformer-tour.json';
import kelvinTourScript from './kelvin-tour.json';
import heronTourScript from './heron-tour.json';
import pulseCoilTourScript from './pulse-coil-tour.json';
import homopolarTourScript from './homopolar-tour.json';
import halbachVizTourScript from './halbach-viz-tour.json';
import peltierTourScript from './peltier-tour.json';
import mhdTourScript from './mhd-tour.json';
import maglevTourScript from './maglev-tour.json';
import solarTourScript from './solar-tour.json';
import type { LabTourKey, TourScript } from './seg-tour-player';

export const TOUR_SCRIPTS: Record<LabTourKey, TourScript> = {
  segTour: tourScript,
  vdgTour: vdgTourScript,
  lorentzTour: lorentzTourScript,
  jumpingRingTour: jumpingRingTourScript,
  dropTubeTour: dropTubeTourScript,
  hallTour: hallTourScript,
  transformerTour: transformerTourScript,
  kelvinTour: kelvinTourScript,
  heronTour: heronTourScript,
  pulseCoilTour: pulseCoilTourScript,
  homopolarTour: homopolarTourScript,
  halbachTour: halbachVizTourScript,
  peltierTour: peltierTourScript,
  mhdTour: mhdTourScript,
  maglevTour: maglevTourScript,
  solarTour: solarTourScript
};
