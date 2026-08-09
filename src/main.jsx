import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './App.css';
import { applyUIPreferences } from './ui-preferences.mjs';
import RenderErrorBoundary from './components/RenderErrorBoundary.jsx';

window.electronAPI?.uiPreferences?.().then(applyUIPreferences).catch(() => {});
window.addEventListener('error', event => {
  window.electronAPI?.reportRendererError?.({
    kind: new URLSearchParams(window.location.search).get('floating') === '1' ? 'floating' : 'main',
    message: event.error?.message || event.message || '未捕获的前端异常',
    stack: event.error?.stack || '',
  });
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  window.electronAPI?.reportRendererError?.({
    kind: new URLSearchParams(window.location.search).get('floating') === '1' ? 'floating' : 'main',
    message: reason?.message || String(reason || '未处理的 Promise 异常'),
    stack: reason?.stack || '',
  });
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RenderErrorBoundary>
      <App floating={new URLSearchParams(window.location.search).get('floating') === '1'} />
    </RenderErrorBoundary>
  </StrictMode>
);
