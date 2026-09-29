import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { pageLoadAssets } from './assets/AssetFilterContext.js';
import { ASSETS_PARAM, applyAssetsParam } from './assets/filter.js';
import './design/fonts.js';
import './design/index.css';
import { probeStorage } from './store/probe.js';
import { LocalStore } from './store/store.js';

// The asset filter's URL parameter (plan 00042), read once before the first render so a hidden
// asset never flashes on screen: stored (or cleared), then removed from the address bar.
if (new URLSearchParams(window.location.search).has(ASSETS_PARAM)) {
  const probe = probeStorage();
  const store = probe.status === 'ok' && probe.storage ? new LocalStore(probe.storage) : null;
  const { param, saved } = applyAssetsParam(window, store);
  if (param.kind === 'set' && !saved) pageLoadAssets.list = param.symbols;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
