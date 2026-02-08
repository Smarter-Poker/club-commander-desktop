const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods for the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => process.versions.electron,
  getPlatform: () => process.platform,
  
  // Window controls
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close: () => ipcRenderer.send('close-window'),
  
  // Updates
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  
  // Notifications
  showNotification: (title, body) => {
    new Notification(title, { body });
  },
  
  // Printing
  print: () => ipcRenderer.send('print'),
  
  // Check if running in Electron
  isElectron: true
});

// Inject a flag so the web app knows it's running in Electron
window.addEventListener('DOMContentLoaded', () => {
  // Add class to body for Electron-specific styling
  document.body.classList.add('electron-app');
  
  // Log startup
  console.log('Club Commander Desktop v' + process.versions.electron);
});
