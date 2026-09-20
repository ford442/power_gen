/**
 * SEG Learning / explainer panel — tour, experiments, classroom mode, shareable lab URL.
 */

import { explainerState } from './explainer-state';
import { initLabTours, LAB_TOURS, type LabTourKey, SEGTourPlayer } from './seg-tour-player';
import { shareLabLink, decodeLabHash, applyLabState } from './lab-url';
import { SEG_GLOSSARY } from './seg-glossary';

export interface ExplainerUIHandle {
  tour: SEGTourPlayer;
  /** Every lab tour, keyed by its registry handle (`segTour`, `hallTour`, …). */
  tours: Record<LabTourKey, SEGTourPlayer>;
  vdgTour: SEGTourPlayer;
  lorentzTour: SEGTourPlayer;
  applyLabFromHash: () => Promise<void>;
}

export function initExplainerUI(): ExplainerUIHandle {
  const tours = initLabTours();
  const tour = tours.segTour;

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

  // One button per registry row: starting a tour stops whichever other one was
  // running, and pressing a playing tour's own button toggles it off.
  for (const def of LAB_TOURS) {
    const btn = document.getElementById(def.buttonId);
    if (!btn) continue;
    const player = tours[def.key];
    btn.addEventListener('click', () => {
      const wasPlaying = player.playing;
      for (const other of LAB_TOURS) {
        if (tours[other.key].playing) tours[other.key].stop();
      }
      if (!wasPlaying) player.start(0);
      setStatus(player.playing ? def.status : 'Tour ended');
    });
  }

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

  return { tour, tours, vdgTour: tours.vdgTour, lorentzTour: tours.lorentzTour, applyLabFromHash: async () => {
    const lab = decodeLabHash();
    if (lab) {
      await applyLabState(lab);
      setStatus('Restored lab from URL');
    }
  } };
}
