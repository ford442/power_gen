// Multi-device camera focus: snap view to a specific device
window.focusDevice = (deviceId: string): void => {
  if (window.multiVisualizer && window.multiVisualizer.cameraController) {
    window.multiVisualizer.cameraController.focusOnDevice(deviceId);
  }
};

// Multi-device toggle: show/hide a device in the overview
window.toggleDevice = (deviceId: string): void => {
  if (window.multiVisualizer) {
    const enabled = window.multiVisualizer.devicesEnabled;
    if (enabled && deviceId in enabled) {
      enabled[deviceId] = !enabled[deviceId];
      const btn = document.getElementById('toggle-' + deviceId);
      if (btn) btn.classList.toggle('active', enabled[deviceId]);
    }
  }
};
