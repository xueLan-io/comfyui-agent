import { useEffect } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const GROUPS = [
  { id: 'global', keys: ['globalShortcuts', 'globalFloating', 'globalWorkflowSearch', 'globalWorkflowSwitch', 'globalMessageSearch', 'globalPasteImage'] },
  { id: 'chat', keys: ['chatEnterSend', 'chatShiftEnter', 'chatTabComplete', 'chatEscape', 'chatSlash'] },
  { id: 'float', keys: ['floatCtrlEnter'] },
];

export default function ShortcutsHelpModal({ onClose }) {
  const { t } = useI18n();
  useEffect(() => {
    const handler = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="shortcuts-panel" onClick={event => event.stopPropagation()} aria-label={t('shortcuts')}>
        <div className="modal-header">
          <h3>{t('shortcuts')}</h3>
          <button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map(group => (
            <div className="shortcuts-group" key={group.id}>
              <div className="shortcuts-group-title">{t(`shortcutGroup_${group.id}`)}</div>
              {group.keys.map(key => (
                <div className="shortcuts-row" key={key}>
                  <span className="shortcuts-label">{t(`${key}_label`)}</span>
                  <code className="shortcuts-keys">{t(`${key}_keys`)}</code>
                </div>
              ))}
            </div>
          ))}
          <div className="shortcuts-group">
            <div className="shortcuts-group-title">{t('shortcutGroup_commands')}</div>
            <div className="shortcuts-row"><span className="shortcuts-label">{t('shortcutsCommandsHint')}</span><code className="shortcuts-keys">/</code></div>
          </div>
        </div>
      </section>
    </div>
  );
}
