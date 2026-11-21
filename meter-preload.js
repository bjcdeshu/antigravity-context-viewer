'use strict';
// External preload registered on `session.defaultSession` via `registerPreloadScript({ type: 'frame' })`.
// Sandbox-safe: imports ONLY `electron` and exposes narrow read-only Context Meter IPC strictly in local Hub main frames.

try {
  const { contextBridge, ipcRenderer } = require('electron');
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const isSshWindow = argv.some(a => a === '--agy-backend=ssh' || String(a).startsWith('--agy-backend=ssh'));
  const isMainFrame = process.isMainFrame !== false;
  const loc = typeof globalThis.location === 'object' && globalThis.location ? globalThis.location : null;
  const isLocalHttpsOrigin = Boolean(loc && loc.protocol === 'https:' && loc.hostname === '127.0.0.1');

  if (isMainFrame && !isSshWindow && isLocalHttpsOrigin && contextBridge && ipcRenderer) {
    try {
      contextBridge.exposeInMainWorld('contextMeterAPI', {
        scan: (id, force) => ipcRenderer.invoke('context-meter:scan', id, force === true),
        getTokenHistory: force => ipcRenderer.invoke('context-meter:token-history', force === true),
        pollMetadata: (id, offset) => ipcRenderer.invoke('context-meter:poll-metadata', id, Number(offset) || 0),
        syncOverlay: opts => ipcRenderer.invoke('context-meter:sync-overlay', opts)
      });
    } catch {
      // Ignore duplicate exposeInMainWorld if legacy preload patch was also present.
    }
  }
} catch {}
