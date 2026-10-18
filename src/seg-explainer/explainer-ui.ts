/**
 * SEG Learning / explainer panel — tour, experiments, classroom mode, shareable lab URL.
 */

import { explainerState } from './explainer-state';
import { initLabTours, LAB_TOURS, type LabTourKey, SEGTourPlayer } from './seg-tour-player';
import { bootLiveFields } from '../config/lab-config';
import { SEG_GLOSSARY } from './seg-glossary';

export interface ExplainerUIHandle {
  tour: SEGTourPlayer;
  /** Every lab tour, keyed by its registry handle (`segTour`, `hallTour`, …). */
  tours: Record<LabTourKey, SEGTourPlayer>;
  vdgTour: SEGTourPlayer;
  lorentzTour: SEGTourPlayer;
  applyLabFromHash: () => Promise<void>;
}

const TOUR_ROW_ID = 'explainerTourRow';

/**
 * One button per `LAB_TOURS` row, so a new tour script needs no markup edit.
 * Buttons go in front of whatever the row already holds (the Lab Link button)
 * and keep their registry ids. Idempotent.
 */
function renderTourButtons(): void {
  const row = document.getElementById(TOUR_ROW_ID);
  if (!row) return;
  const buttons: HTMLButtonElement[] = [];
  for (const def of LAB_TOURS) {
    if (document.getElementById(def.buttonId)) continue;
    const btn = document.createElement('button');
    btn.className = 'ctrl-btn';
    btn.id = def.buttonId;
    btn.type = 'button';
    btn.style.fontSize = '0.68rem';
    btn.textContent = def.label;
    buttons.push(btn);
  }
  row.prepend(...buttons);
}

export function initExplainerUI(): ExplainerUIHandle {
  renderTourButtons();
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
      if (wasPlaying) {
        setStatus('Tour ended');
        return;
      }
      // A first start fetches the tour-scripts chunk before it plays.
      void player.start(0).then(() => setStatus(player.playing ? def.status : 'Tour ended'));
    });
  }

  shareBtn?.addEventListener('click', () => {
    void import('../config/share-dialog')
      .then((m) => m.openShareDialog())
      .then(() => setStatus('Lab link copied'))
      .catch((e: unknown) => setStatus(`Could not build a link: ${e instanceof Error ? e.message : String(e)}`));
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
    const fields = bootLiveFields();
    if (Object.keys(fields).length) {
      // The share-link applier is its own chunk; a plain boot never loads it.
      const { applyLabConfig } = await import('./lab-url');
      await applyLabConfig(fields);
      setStatus('Restored lab from URL');
    }
  } };
}
