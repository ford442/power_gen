/**
 * SEG Learning / explainer panel — tour, experiments, classroom mode, shareable lab URL.
 */

import { explainerState } from './explainer-state.js';
import { initSEGTour } from './seg-tour-player.js';
import { shareLabLink, decodeLabHash, applyLabState } from './lab-url.js';
import { SEG_GLOSSARY } from './seg-glossary.js';

export function initExplainerUI() {
  const tour = initSEGTour();

  const tourBtn = document.getElementById('explainerTourBtn');
  const shareBtn = document.getElementById('explainerShareBtn');
  const classroomCb = document.getElementById('explainerClassroom');
  const motionCb = document.getElementById('explainerReducedMotion');
  const bMult = document.getElementById('explainerBMult');
  const bMultVal = document.getElementById('explainerBMultVal');
  const layoutSearl = document.getElementById('explainerLayoutSearl');
  const layoutRoschin = document.getElementById('explainerLayoutRoschin');
  const statusEl = document.getElementById('explainerStatus');
  const glossaryEl = document.getElementById('explainerGlossary');

  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

  tourBtn?.addEventListener('click', () => {
    if (tour.playing) tour.stop();
    else tour.start(0);
    setStatus(tour.playing ? 'Tour playing — Space to pause sim' : 'Tour ended');
  });

  shareBtn?.addEventListener('click', () => {
    const url = shareLabLink();
    setStatus(`Lab link copied (${url.length} chars)`);
  });

  classroomCb?.addEventListener('change', (e) => {
    explainerState.setClassroomMode(e.target.checked);
    if (e.target.checked) {
      window.segAnnotations?.setEnabled(true);
      window.segDiagram2D?.show?.();
    }
    setStatus(e.target.checked ? 'Classroom mode — large labels, reduced chrome' : 'Classroom mode off');
  });

  motionCb?.addEventListener('change', (e) => {
    explainerState.setReducedMotion(e.target.checked);
    setStatus(e.target.checked ? 'Reduced motion — lower particle cap' : 'Full motion');
  });

  if (motionCb && explainerState.reducedMotion) {
    motionCb.checked = true;
  }

  const syncBMult = () => {
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
  const fieldControl = document.getElementById('fieldControl');
  fieldControl?.addEventListener('input', () => {
    explainerState.setBaseFieldStrength(parseInt(fieldControl.value, 10) / 100);
  });
  if (fieldControl) {
    explainerState.setBaseFieldStrength(parseInt(fieldControl.value, 10) / 100);
  }

  explainerState.subscribe((s) => {
    if (s.highlightId && glossaryEl) {
      const row = glossaryEl.querySelector(`dt[title]`);
      if (row) row.style.color = '#0ff';
    }
  });

  return { tour, applyLabFromHash: async () => {
    const lab = decodeLabHash();
    if (lab) {
      await applyLabState(lab);
      if (lab.tour) tour.start(0);
      setStatus('Restored lab from URL');
    }
  } };
}
