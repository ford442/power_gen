/**
 * SEG Learning / explainer panel — tour, experiments, classroom mode, shareable lab URL.
 */

import { explainerState } from './explainer-state';
import { initSEGTour, initVdgTour, initLorentzTour, SEGTourPlayer } from './seg-tour-player';
import { shareLabLink, decodeLabHash, applyLabState } from './lab-url';
import { SEG_GLOSSARY } from './seg-glossary';

export interface ExplainerUIHandle {
  tour: SEGTourPlayer;
  vdgTour: SEGTourPlayer;
  lorentzTour: SEGTourPlayer;
  applyLabFromHash: () => Promise<void>;
}

export function initExplainerUI(): ExplainerUIHandle {
  const tour = initSEGTour();
  const vdgTour = initVdgTour();
  const lorentzTour = initLorentzTour();

  const tourBtn = document.getElementById('explainerTourBtn');
  const vdgTourBtn = document.getElementById('explainerVdgTourBtn');
  const lorentzTourBtn = document.getElementById('explainerLorentzTourBtn');
  const shareBtn = document.getElementById('explainerShareBtn');
  const classroomCb = document.getElementById('explainerClassroom') as HTMLInputElement | null;
  const motionCb = document.getElementById('explainerReducedMotion') as HTMLInputElement | null;
  const bMult = document.getElementById('explainerBMult') as HTMLInputElement | null;
  const bMultVal = document.getElementById('explainerBMultVal');
  const layoutSearl = document.getElementById('explainerLayoutSearl');
  const layoutRoschin = document.getElementById('explainerLayoutRoschin');
  const statusEl = document.getElementById('explainerStatus');
  const glossaryEl = document.getElementById('explainerGlossary');

  const setStatus = (t: string): void => { if (statusEl) statusEl.textContent = t; };

  tourBtn?.addEventListener('click', () => {
    if (vdgTour.playing) vdgTour.stop();
    if (lorentzTour.playing) lorentzTour.stop();
    if (tour.playing) tour.stop();
    else tour.start(0);
    setStatus(tour.playing ? 'Tour playing — Space to pause sim' : 'Tour ended');
  });

  vdgTourBtn?.addEventListener('click', () => {
    if (tour.playing) tour.stop();
    if (lorentzTour.playing) lorentzTour.stop();
    if (vdgTour.playing) vdgTour.stop();
    else vdgTour.start(0);
    setStatus(vdgTour.playing ? 'Van de Graaff tour playing' : 'Tour ended');
  });

  lorentzTourBtn?.addEventListener('click', () => {
    if (tour.playing) tour.stop();
    if (vdgTour.playing) vdgTour.stop();
    if (lorentzTour.playing) lorentzTour.stop();
    else lorentzTour.start(0);
    setStatus(lorentzTour.playing ? 'Lorentz sled tour playing' : 'Tour ended');
  });

  shareBtn?.addEventListener('click', () => {
    const url = shareLabLink();
    setStatus(`Lab link copied (${url.length} chars)`);
  });

  classroomCb?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    explainerState.setClassroomMode(checked);
    if (checked) {
      window.segAnnotations?.setEnabled(true);
      (window.segDiagram2D as { show?: () => void } | undefined)?.show?.();
    }
    setStatus(checked ? 'Classroom mode — large labels, reduced chrome' : 'Classroom mode off');
  });

  motionCb?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    explainerState.setReducedMotion(checked);
    setStatus(checked ? 'Reduced motion — lower particle cap' : 'Full motion');
  });

  if (motionCb && explainerState.reducedMotion) {
    motionCb.checked = true;
  }

  const syncBMult = (): void => {
    const v = parseFloat(bMult?.value || '1');
    explainerState.setFieldMultiplier(v);
    if (bMultVal) bMultVal.textContent = `×${v.toFixed(1)}`;
  };
  bMult?.addEventListener('input', syncBMult);

  layoutSearl?.addEventListener('click', async () => {
    await window.setSEGLayout?.('searl');
    window.setMode?.('seg');
    setStatus('Layout: Searl 10/25/35');
  });
  layoutRoschin?.addEventListener('click', async () => {
    await window.setSEGLayout?.('roschin');
    window.setMode?.('seg');
    setStatus('Layout: Roschin–Godin 12');
  });

  // Glossary list (compact)
  if (glossaryEl) {
    glossaryEl.innerHTML = Object.entries(SEG_GLOSSARY).slice(0, 6).map(([k, g]) =>
      `<dt title="${g.body.replace(/"/g, '&quot;')}">${g.title}</dt><dd>${g.value || k}</dd>`
    ).join('');
  }

  // Sync base field from operator slider
  const fieldControl = document.getElementById('fieldControl') as HTMLInputElement | null;
  fieldControl?.addEventListener('input', () => {
    explainerState.setBaseFieldStrength(parseInt(fieldControl.value, 10) / 100);
  });
  if (fieldControl) {
    explainerState.setBaseFieldStrength(parseInt(fieldControl.value, 10) / 100);
  }

  explainerState.subscribe((s) => {
    if (s.highlightId && glossaryEl) {
      const row = glossaryEl.querySelector(`dt[title]`) as HTMLElement | null;
      if (row) row.style.color = '#0ff';
    }
  });

  return { tour, vdgTour, lorentzTour, applyLabFromHash: async () => {
    const lab = decodeLabHash();
    if (lab) {
      await applyLabState(lab);
      setStatus('Restored lab from URL');
    }
  } };
}
