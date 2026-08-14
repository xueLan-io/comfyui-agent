import { useEffect, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import Icon from './Icon.jsx';

const EMPTY_PROFILE = { styles: [], disliked: [], notes: [], workflows: {} };

// Long-term memory management: profile, character cards, and captured memory
// segments for the active project. Changes are written through to the agent
// worker's LongTermMemory; cleared data is gone immediately (no undo).
export default function MemorySettings() {
  const { t } = useI18n();
  const session = useSession();
  const projectId = session.activeProjectId || '';
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('');
  const [styleInput, setStyleInput] = useState('');
  const [dislikeInput, setDislikeInput] = useState('');
  const [cardDraft, setCardDraft] = useState({ name: '', description: '', appearance: '', outfit: '', pose: '', tags: '', notes: '' });
  const [editingCard, setEditingCard] = useState('');

  async function refresh() {
    try {
      const next = await window.electronAPI.memoryGetState(projectId);
      setState(next || { profile: EMPTY_PROFILE, characterCards: [], segments: [] });
    } catch (error) {
      setStatus(error.message || t('memoryLoadFailed'));
    }
  }

  useEffect(() => { if (projectId) void refresh(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!projectId) return <section className="memory-settings"><p>{t('memoryNoProject')}</p></section>;

  const profile = state?.profile || EMPTY_PROFILE;
  const cards = state?.characterCards || [];
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

  async function saveCard() {
    const name = cardDraft.name.trim();
    if (!name) return;
    try {
      await window.electronAPI.memoryUpsertCharacterCard(projectId, {
        ...cardDraft,
        name,
        tags: cardDraft.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      });
      setCardDraft({ name: '', description: '', appearance: '', outfit: '', pose: '', tags: '', notes: '' });
      setEditingCard('');
      setStatus(t('memorySaved'));
      await refresh();
    } catch (error) {
      setStatus(error.message || t('memorySaveFailed'));
    }
  }

  async function deleteCard(name) {
    await window.electronAPI.memoryDeleteCharacterCard(projectId, name);
    if (editingCard === name) setEditingCard('');
    await refresh();
  }

  async function clearProject() {
    if (!window.confirm(t('memoryClearProjectConfirm'))) return;
    try {
      await window.electronAPI.memoryClear(projectId);
      setState({ profile: EMPTY_PROFILE, characterCards: [], segments: [] });
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
        <h4>{t('memoryCharacterCards')}</h4>
        {cards.length === 0 && !editingCard && <p className="memory-empty">{t('memoryNoCards')}</p>}
        <div className="memory-card-list">
          {cards.map(card => (
            <div className="memory-card" key={card.name}>
              <div className="memory-card-head">
                <strong>{card.name}</strong>
                <div>
                  <button className="btn btn-icon" onClick={() => { setEditingCard(card.name); setCardDraft({ ...card, tags: (card.tags || []).join(', ') }); }} title={t('edit')}><Icon name="edit" size={14} /></button>
                  <button className="btn btn-icon" onClick={() => void deleteCard(card.name)} title={t('delete')}><Icon name="trash" size={14} /></button>
                </div>
              </div>
              {[card.description, card.appearance, card.outfit].filter(Boolean).map(line => <p key={line} className="memory-card-line">{line}</p>)}
              {card.pose && <p className="memory-card-line">{t('memoryCardPose')}：{card.pose}</p>}
              {card.tags?.length > 0 && <p className="memory-card-tags">{card.tags.map(tag => <span key={tag}>{tag}</span>)}</p>}
            </div>
          ))}
        </div>
        <div className="memory-card-form">
          <div className="settings-grid">
            <div className="settings-field"><label>{t('memoryCardName')} *</label><input value={cardDraft.name} onChange={event => setCardDraft({ ...cardDraft, name: event.target.value })} placeholder={t('memoryCardName')} /></div>
            <div className="settings-field"><label>{t('memoryCardTags')}</label><input value={cardDraft.tags} onChange={event => setCardDraft({ ...cardDraft, tags: event.target.value })} placeholder="anime, oc" /></div>
            <div className="settings-field span-2"><label>{t('memoryCardDescription')}</label><input value={cardDraft.description} onChange={event => setCardDraft({ ...cardDraft, description: event.target.value })} /></div>
            <div className="settings-field"><label>{t('memoryCardAppearance')}</label><input value={cardDraft.appearance} onChange={event => setCardDraft({ ...cardDraft, appearance: event.target.value })} /></div>
            <div className="settings-field"><label>{t('memoryCardOutfit')}</label><input value={cardDraft.outfit} onChange={event => setCardDraft({ ...cardDraft, outfit: event.target.value })} /></div>
            <div className="settings-field"><label>{t('memoryCardPose')}</label><input value={cardDraft.pose} onChange={event => setCardDraft({ ...cardDraft, pose: event.target.value })} /></div>
            <div className="settings-field span-2"><label>{t('memoryCardNotes')}</label><input value={cardDraft.notes} onChange={event => setCardDraft({ ...cardDraft, notes: event.target.value })} /></div>
          </div>
          <div className="memory-card-actions">
            <button className="btn btn-primary" onClick={() => void saveCard()} disabled={!cardDraft.name.trim()}>{editingCard ? t('memoryUpdateCard') : t('memoryAddCard')}</button>
            {editingCard && <button className="btn" onClick={() => { setEditingCard(''); setCardDraft({ name: '', description: '', appearance: '', outfit: '', pose: '', tags: '', notes: '' }); }}>{t('cancel')}</button>}
          </div>
        </div>
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
