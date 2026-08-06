import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './App.css';
import { applyUIPreferences } from './ui-preferences.mjs';

window.electronAPI?.uiPreferences?.().then(applyUIPreferences).catch(() => {});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App floating={new URLSearchParams(window.location.search).get('floating') === '1'} />
  </StrictMode>
);
