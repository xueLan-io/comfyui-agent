import { useEffect, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import Icon from './Icon.jsx';

const EMPTY_PROFILE = { styles: [], disliked: [], notes: [], workflows: {} };

// Long-term memory management: project profile and captured memory segments for
// the active project. Changes are written through to the agent worker's
// LongTermMemory; cleared data is gone immediately (no undo).
export default function MemorySettings() {
  const { t } = useI18n();
  const session = useSession();
  const projectId = session.activeProjectId || '';
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('');
  const [styleInput, setStyleInput] = useState('');
  const [dislikeInput, setDislikeInput] = useState('');

  async function refresh() {
    try {
      const next = await window.electronAPI.memoryGetState(projectId);
      setState(next || { profile: EMPTY_PROFILE, segments: [] });
    } catch (error) {
      setStatus(error.message || t('memoryLoadFailed'));
    }
  }

  useEffect(() => { if (projectId) void refresh(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!projectId) return <section className="memory-settings"><p>{t('memoryNoProject')}</p></section>;

  const profile = state?.profile || EMPTY_PROFILE;
  const segments = state?.segments || [];

  function pushProfile(patch) {
    return window.electronAPI.memorySetProfile(projectId, patch)
      .then(next => { setState({ ...state, profile: next?.profile || profile }); setStatus(t('memorySaved')); })
      .catch(error => setStatus(error.message || t('memorySaveFailed')));
  }

  async function addStyle() {
    const value = styleInput.trim();
    if (!value) return;
    setStyleInput('');
    await pushProfile({ styles: [...profile.styles, value] });
  }

  async function addDislike() {
    const value = dislikeInput.trim();
    if (!value) return;
    setDislikeInput('');
    await pushProfile({ disliked: [...profile.disliked, value] });
  }

  async function removeProfileItem(kind, value) {
    await pushProfile({ [kind]: profile[kind].filter(item => item !== value) });
  }

  async function clearProject() {
    if (!window.confirm(t('memoryClearProjectConfirm'))) return;
    try {
      await window.electronAPI.memoryClear(projectId);
      setState({ profile: EMPTY_PROFILE, segments: [] });
      setStatus(t('memoryCleared'));
    } catch (error) {
      setStatus(error.message || t('memoryClearFailed'));
    }
  }

  async function exportMemory() {
    try {
      const json = await window.electronAPI.memoryExport();
      await window.electronAPI.appSaveTextFile(`comfy-memory-${new Date().toISOString().slice(0, 10)}.json`, json);
      setStatus(t('memoryExported'));
    } catch (error) {
      setStatus(error.message || t('memoryExportFailed'));
    }
  }

  const workflowEntries = Object.entries(profile.workflows || {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="memory-settings">
      <p className="preview-note"><span className="preview-badge">{t('previewBadge')}</span>{t('previewNote')}</p>
      <div className="settings-section-heading">
        <div><h3>{t('memorySettings')}</h3><p>{t('memorySettingsNote')}</p></div>
        <div className="memory-actions">
          <button className="btn" onClick={exportMemory}><Icon name="download" size={14} /> {t('memoryExport')}</button>
          <button className="btn btn-danger" onClick={clearProject}><Icon name="trash" size={14} /> {t('memoryClearProject')}</button>
        </div>
      </div>
      {status && <p className="settings-status">{status}</p>}

      <section className="memory-section">
        <h4>{t('memoryProjectProfile')}</h4>
        <div className="settings-grid">
          <div className="settings-field">
            <label>{t('memoryStyles')}</label>
            <div className="tag-editor">
              {profile.styles.map(value => <span key={value} className="memory-tag">{value}<button onClick={() => removeProfileItem('styles', value)} aria-label={t('delete')}><Icon name="close" size={12} /></button></span>)}
              <input value={styleInput} onChange={event => setStyleInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void addStyle(); }} placeholder={t('memoryAddStyle')} />
            </div>
          </div>
          <div className="settings-field">
            <label>{t('memoryDisliked')}</label>
            <div className="tag-editor">
              {profile.disliked.map(value => <span key={value} className="memory-tag memory-tag-disliked">{value}<button onClick={() => removeProfileItem('disliked', value)} aria-label={t('delete')}><Icon name="close" size={12} /></button></span>)}
              <input value={dislikeInput} onChange={event => setDislikeInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void addDislike(); }} placeholder={t('memoryAddDislike')} />
            </div>
          </div>
        </div>
        {workflowEntries.length > 0 && (
          <p className="memory-workflows">{t('memoryWorkflows')}：{workflowEntries.map(([name, count]) => `${name}（${count}）`).join('、')}</p>
        )}
      </section>

      <section className="memory-section">
        <h4>{t('memorySegments')}（{segments.length}）</h4>
        {segments.length === 0 && <p className="memory-empty">{t('memoryNoSegments')}</p>}
        {segments.slice().reverse().map(segment => (
          <details className="memory-segment" key={segment.id}>
            <summary>
              <span>{new Date(segment.createdAt).toLocaleString()}</span>
              {segment.workflowName && <span className="memory-segment-workflow">{segment.workflowName}</span>}
              <span>{String(segment.summary?.objective || '').slice(0, 60) || (segment.summary?.facts || []).join('；').slice(0, 60)}</span>
            </summary>
            <div className="memory-segment-body">
              {Object.entries({ decisions: t('memoryDecisions'), constraints: t('memoryConstraints'), completed: t('memoryCompleted'), openItems: t('memoryOpenItems'), facts: t('memoryFacts') })
                .filter(([key]) => (segment.summary?.[key] || []).length > 0)
                .map(([key, label]) => (
                  <div key={key}><strong>{label}：</strong>{segment.summary[key].join('；')}</div>
                ))}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
