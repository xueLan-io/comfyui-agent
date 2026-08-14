import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useAgent } from '../contexts/AgentContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const VISIBLE_PROMPT_MODES = ['raw', 'anime', 'anime-character', 'anime-scene', 'anime-polish'];

export default function PromptSection({ onOpenPromptLibrary }) {
  const { t } = useI18n();
  const { workflowManifest } = useComfyUI();
  const { promptMode, setPromptMode } = useAgent();
  const promptProfile = workflowManifest?.promptProfile;
  const positiveTargetCount = promptProfile?.positiveTargets?.length || 0;
  const negativeTargetCount = promptProfile?.negativeTargets?.length || 0;
  const promptModeHelp = { raw: 'promptHelpRaw', anime: 'promptHelpAnime', 'anime-character': 'promptHelpCharacter', 'anime-scene': 'promptHelpScene', 'anime-polish': 'promptHelpPolish' }[promptMode] || 'promptHelpAnime';
  const modeText = { raw: ['rawMode', 'rawModeDesc'], anime: ['animeMode', 'animeModeDesc'], 'anime-character': ['characterMode', 'characterModeDesc'], 'anime-scene': ['sceneMode', 'sceneModeDesc'], 'anime-polish': ['polishMode', 'polishModeDesc'] };

  return (
    <section className="workspace-section prompt-section">
      <div className="workspace-section-heading">
        <div>
          <span className="section-kicker">02</span>
          <div>
            <h3>{t('promptTemplate')}</h3>
            <p>{promptProfile?.family || t('waitingWorkflow')}</p>
          </div>
        </div>
        <span className="prompt-target-count">{t('positive')} {positiveTargetCount} · {t('negative')} {negativeTargetCount}</span>
      </div>
      <div className="prompt-mode-grid" role="group" aria-label={t('promptTemplate')}>
        {VISIBLE_PROMPT_MODES.map(id => <button key={id} type="button" className={`prompt-mode-card${promptMode === id ? ' active' : ''}`} onClick={() => setPromptMode(id)} aria-pressed={promptMode === id}><strong>{t(modeText[id][0])}</strong><span>{t(modeText[id][1])}</span></button>)}
      </div>
      <button className="prompt-library-launch" type="button" onClick={onOpenPromptLibrary}>
        <span className="prompt-library-launch-mark"><Icon name="library" size={15} /></span>
        <span><strong>{t('openPromptWorkspace')}</strong><small>{t('chooseEnglishFragments')}</small></span>
        <span className="prompt-library-launch-arrow"><Icon name="chevronRight" size={16} /></span>
      </button>
      <p className="prompt-mode-help"><strong>{t('currentEffect')}：</strong>{t(promptModeHelp)}</p>
      {workflowManifest && <p className="prompt-template-summary">{promptProfile?.supportsNegative === false ? t('promptOnlyPositive') : t('promptTargetsSummary', { positive: positiveTargetCount, negative: negativeTargetCount })}</p>}
    </section>
  );
}
