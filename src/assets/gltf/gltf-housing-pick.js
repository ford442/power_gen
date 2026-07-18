/**
 * Canvas click handler — ray-pick annotated glTF housing meshes → SEG tour step.
 */

import { pickGltfAnnotations } from './gltf-pick.js';

const DRAG_PX = 6;

/**
 * @param {object} visualizer MultiDeviceVisualizer instance
 */
export function attachGltfHousingPickHandler(visualizer) {
  if (visualizer._gltfPickBound) return;
  visualizer._gltfPickBound = true;

  const canvas = visualizer.canvas;
  let downX = 0;
  let downY = 0;
  let downBtn = 0;

  canvas.addEventListener('mousedown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
    downBtn = e.button;
  });

  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || downBtn !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
    if (!visualizer.gltfHousingEnabled || !visualizer.gltfHousingPickables?.length) return;
    if (visualizer.currentView !== 'seg' && visualizer.currentView !== 'overview') return;

    const viewProj = visualizer.cameraController?.getViewProjMatrix?.();
    const cam = visualizer.camera?.camera?.position || visualizer.cameraController?.camera?.position;
    if (!viewProj || !cam) return;

    const hit = pickGltfAnnotations(
      visualizer.gltfHousingPickables,
      canvas,
      e.clientX,
      e.clientY,
      viewProj,
      cam
    );
    if (!hit) return;

    e.preventDefault();
    e.stopPropagation();
    window.segTour?.goToStepForHighlight?.(hit.annotationId);
  });
}
