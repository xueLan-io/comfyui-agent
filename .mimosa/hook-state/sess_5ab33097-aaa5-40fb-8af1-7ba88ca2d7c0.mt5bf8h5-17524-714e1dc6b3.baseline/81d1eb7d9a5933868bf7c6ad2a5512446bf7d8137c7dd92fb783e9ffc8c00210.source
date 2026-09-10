import { Component } from 'react';
import { redactFeedbackText } from '../runtime/feedback-report.mjs';
import { I18nContext } from '../i18n/I18nContext.jsx';

function windowKind() {
  return new URLSearchParams(window.location.search).get('floating') === '1'
    ? 'floating'
    : 'main';
}

export default class RenderErrorBoundary extends Component {
  static contextType = I18nContext;
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    window.electronAPI?.reportRendererError?.({
      kind: windowKind(),
      message: error?.message || String(error),
      stack: error?.stack || '',
      componentStack: info?.componentStack || '',
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const tr = key => this.context?.t?.(key) || key;
    const message = redactFeedbackText(this.state.error?.message || tr('renderFailed'), 1000);
    const kind = windowKind() === 'floating' ? tr('renderFailedKindFloating') : tr('renderFailedKindMain');
    return (
      <main style={{ minHeight: '100vh', padding: 32, color: '#f5f5f5', background: '#171717', fontFamily: 'sans-serif' }}>
        <h1>{tr('renderFailed')}</h1>
        <p>{tr('renderFailedBody', { kind })}</p>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#ffb4ab' }}>{message}</pre>
        <button type="button" onClick={() => window.location.reload()}>{tr('reload')}</button>
      </main>
    );
  }
}
