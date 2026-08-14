import { useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { countControlChanges, cloneGenerationControls, EMPTY_GENERATION_CONTROLS, setSettingControl, setNodeControl, parseControlValue } from './node-controls.mjs';
import { buildParameterSchema } from '../runtime/parameter-schema.mjs';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function displayValue(value, t) {
  if (value === undefined || value === null || value === '') return t('ncUnset');
  return String(value);
}

function InlineField({ definition, value, changed, onChange, onReset }) {
  const { t } = useI18n();
  const type = String(definition.type || '').toLowerCase();
  const label = definition.label || definition.name;
  const defaultLabel = t('ncDefault', { value: displayValue(definition.value, t) });
  let control;

  if (type === 'select' || (type === 'model' && (definition.options || []).length > 0)) {
    control = (
      <select value={changed ? value : ''} onChange={event => onChange(parseControlValue(definition, event.target.value))}>
        <option value="">{defaultLabel}</option>
        {(definition.options || []).map(option => <option key={String(option)} value={option}>{String(option)}</option>)}
      </select>
    );
  } else if (type === 'boolean' || typeof definition.value === 'boolean') {
    control = (
      <select value={changed ? String(value) : ''} onChange={event => onChange(parseControlValue(definition, event.target.value))}>
        <option value="">{defaultLabel}</option>
        <option value="true">{t('ncYes')}</option>
        <option value="false">{t('ncNo')}</option>
      </select>
    );
  } else {
    const numeric = ['number', 'int', 'float'].includes(type) || typeof definition.value === 'number';
    control = numeric && definition.min !== undefined && definition.max !== undefined ? (
      <div className="parameter-range-control">
        <input type="range" min={definition.min} max={definition.max} step={definition.step} value={changed ? value : definition.value ?? definition.min} onChange={event => onChange(parseControlValue(definition, event.target.value))} />
        <output>{displayValue(changed ? value : definition.value, t)}</output>
      </div>
    ) : (
      <input type={numeric ? 'number' : 'text'}
        min={definition.min} max={definition.max} step={definition.step}
        value={changed ? value : ''}
        onChange={event => onChange(parseControlValue(definition, event.target.value))}
        placeholder={defaultLabel}
      />
    );
  }

  return (
    <div className={`node-input-field${changed ? ' changed' : ''}`}>
      <span>
        <label>{label}</label>
        {changed && <button type="button" onClick={onReset} title={t('ncResetTitle', { label })}><Icon name="refresh" size={13} /></button>}
      </span>
      {control}
    </div>
  );
}

export default function ParamsSection() {
  const { t } = useI18n();
  const {
    workflowManifest,
    generationControls,
    setGenerationControls,
    setShowNodeControls,
  } = useComfyUI();
  const [draft, setDraft] = useState(() => cloneGenerationControls(generationControls));
  const [expanded, setExpanded] = useState(false);
  const changeCount = countControlChanges(draft);

  if (!workflowManifest) {
    return (
      <section className="workspace-section params-section">
        <div className="workspace-section-heading">
          <div>
            <span className="section-kicker">03</span>
            <div>
              <h3>{t('parameters')}</h3>
              <p>{t('waitingWorkflow')}</p>
            </div>
          </div>
        </div>
        <div className="params-empty">
          <Icon name="sliders" size={20} />
          <p>{t('chooseWorkflow')}</p>
        </div>
      </section>
    );
  }

  const parameterSchema = buildParameterSchema(workflowManifest);
  const commonFields = parameterSchema.filter(field => field.source === 'common');

  function applyChanges() {
    setGenerationControls(cloneGenerationControls(draft));
  }

  function resetAll() {
    setDraft(cloneGenerationControls(EMPTY_GENERATION_CONTROLS));
  }

  return (
    <section className="workspace-section params-section">
      <div className="workspace-section-heading">
        <div>
          <span className="section-kicker">03</span>
          <div>
            <h3>{t('parameters')}</h3>
            <p>{workflowManifest.workflowName}</p>
          </div>
        </div>
        {changeCount > 0 && <span className="params-change-badge">{changeCount}</span>}
      </div>

      <div className="params-runtime-summary">
        <span>{workflowManifest.modelType || 'generic'}</span>
        <span>{t('ncActiveNodes', { n: workflowManifest.activeNodeCount || 0 })}</span>
        <span>{t('ncEditableNodes', { n: workflowManifest.editableNodeCount || 0 })}</span>
      </div>

      {commonFields.length > 0 && (
        <div className="params-common-grid">
          {commonFields.map(field => {
            const definition = { ...field, value: workflowManifest.commonSettings?.[field.key] };
            if (field.inputNames) {
              for (const node of (workflowManifest.editableNodes || [])) {
                const input = (node.inputs || []).find(item => field.inputNames.includes(item.name) && item.options?.length);
                if (input) { Object.assign(definition, { type: 'select', options: input.options }); break; }
              }
            }
            const changed = hasOwn(draft.settings, field.key);
            return (
              <InlineField
                key={field.key}
                definition={{ ...definition, name: field.key }}
                value={draft.settings[field.key]}
                changed={changed}
                onChange={value => setDraft(current => setSettingControl(current, field.key, value))}
                onReset={() => setDraft(current => setSettingControl(current, field.key, undefined))}
              />
            );
          })}
        </div>
      )}

      <div className="params-actions">
        <button className="btn" onClick={() => setShowNodeControls(true)}>
          <Icon name="sliders" size={14} /> {t('ncTitle')}
        </button>
        <span className="params-actions-spacer" />
        {changeCount > 0 && <button className="btn" onClick={resetAll}>{t('ncResetAll')}</button>}
        {changeCount > 0 && <button className="btn btn-primary" onClick={applyChanges}>{t('ncApply')}</button>}
      </div>
    </section>
  );
}
