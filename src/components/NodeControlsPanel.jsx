import { useId, useState } from 'react';
import Icon from './Icon.jsx';
import {
  EMPTY_GENERATION_CONTROLS,
  cloneGenerationControls,
  countControlChanges,
  parseControlValue,
  setNodeControl,
  setSettingControl,
  toggleOutputControl,
} from './node-controls.mjs';
import { buildParameterSchema } from '../runtime/parameter-schema.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

function nodeInputLabels(t) {
  return {
    positive: t('ppPositiveLabel'),
    negative: t('ppNegativeLabel'),
    text: t('ncInputText'),
    seed: t('ncInputSeed'),
    steps: t('ncInputSteps'),
    cfg: t('ncInputCfg'),
    sampler_name: t('ncInputSampler'),
    scheduler: t('ncInputScheduler'),
    denoise: t('ncInputDenoise'),
    width: t('ncInputWidth'),
    height: t('ncInputHeight'),
    batch_size: t('ncInputBatch'),
  };
}

function nodeInputDescriptions(t) {
  return {
    positive: t('ncDescPositive'),
    negative: t('ncDescNegative'),
    seed: t('ncDescSeed'),
    steps: t('ncDescSteps'),
    cfg: t('ncDescCfg'),
    denoise: t('ncDescDenoise'),
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function displayValue(value, t) {
  if (value === undefined || value === null || value === '') return t('ncUnset');
  return String(value);
}

function commonDefinition(field, manifest) {
  const definition = { ...field, value: manifest.commonSettings?.[field.key] };
  if (!field.inputNames) return definition;

  for (const node of manifest.editableNodes || []) {
    const input = (node.inputs || []).find(item => field.inputNames.includes(item.name) && item.options?.length);
    if (input) return { ...definition, type: 'select', options: input.options };
  }
  return definition;
}

function ControlField({ definition, value, changed, onChange, onReset }) {
  const { t } = useI18n();
  const controlId = useId();
  const type = String(definition.type || '').toLowerCase();
  const label = definition.label || definition.name;
  const defaultLabel = t('ncDefault', { value: displayValue(definition.value, t) });
  let control;

  if (type === 'select' || (type === 'model' && (definition.options || []).length > 0)) {
    control = (
      <select id={controlId} value={changed ? value : ''} onChange={event => onChange(parseControlValue(definition, event.target.value))}>
        <option value="">{defaultLabel}</option>
        {(definition.options || []).map(option => <option key={String(option)} value={option}>{String(option)}</option>)}
      </select>
    );
  } else if (type === 'boolean' || typeof definition.value === 'boolean') {
    control = (
      <select id={controlId} value={changed ? String(value) : ''} onChange={event => onChange(parseControlValue(definition, event.target.value))}>
        <option value="">{defaultLabel}</option>
        <option value="true">{t('ncYes')}</option>
        <option value="false">{t('ncNo')}</option>
      </select>
    );
  } else if (type === 'string' && String(value ?? definition.value ?? '').length > 80) {
    control = (
      <textarea
        id={controlId}
        value={changed ? value : definition.value ?? ''}
        onChange={event => onChange(parseControlValue(definition, event.target.value))}
      />
    );
  } else {
    const numeric = ['number', 'int', 'float'].includes(type) || typeof definition.value === 'number';
    control = numeric && definition.min !== undefined && definition.max !== undefined ? (
      <div className="parameter-range-control"><input id={controlId} type="range" min={definition.min} max={definition.max} step={definition.step} value={changed ? value : definition.value ?? definition.min} onChange={event => onChange(parseControlValue(definition, event.target.value))} /><output>{displayValue(changed ? value : definition.value, t)}</output></div>
    ) : (
      <input id={controlId} type={numeric ? 'number' : 'text'}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={changed ? value : ''}
        onChange={event => onChange(parseControlValue(definition, event.target.value))}
        placeholder={defaultLabel}
      />
    );
  }

  return (
    <div className={`node-input-field${changed ? ' changed' : ''}`}>
      <span>
        <label htmlFor={controlId}>{label}</label>
        {changed && <button type="button" onClick={onReset} title={t('ncResetTitle', { label })}><Icon name="refresh" size={13} /></button>}
      </span>
      {control}
      {definition.description && <small className="node-input-description">{definition.description}</small>}
    </div>
  );
}

export default function NodeControlsPanel({ manifest, controls, onChange, onClose }) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(() => cloneGenerationControls(controls));
  const query = search.trim().toLowerCase();
  const editableNodes = (manifest.editableNodes || []).filter(node => {
    if (!query) return true;
    return [node.id, node.type, node.title, node.group].some(value => String(value || '').toLowerCase().includes(query));
  });
  const outputNodes = manifest.outputNodes || [];
  const visibleOutputNodes = outputNodes.filter(node => {
    if (!query) return true;
    return [node.id, node.type, node.title, node.group].some(value => String(value || '').toLowerCase().includes(query));
  });
  const changeCount = countControlChanges(draft);
  const parameterSchema = buildParameterSchema(manifest);
  const selectedOutputIds = Array.isArray(draft.outputNodeIds)
    ? draft.outputNodeIds.map(String)
    : (manifest.preferredOutputNodeIds || outputNodes.map(node => node.id)).map(String);

  function applyChanges() {
    onChange(cloneGenerationControls(draft));
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="node-controls-panel" onClick={event => event.stopPropagation()} aria-label={t('ncPanelAria')}>
        <div className="modal-header">
          <div>
            <h2>{t('ncTitle')}</h2>
            <p>{manifest.workflowName}</p>
          </div>
          <button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button>
        </div>

        <div className="node-controls-body">
          <div className="node-runtime-summary">
            <span>{manifest.modelType || 'generic'}</span>
            <span>{t('ncActiveNodes', { n: manifest.activeNodeCount || 0 })}</span>
            <span>{t('ncEditableNodes', { n: manifest.editableNodeCount || 0 })}</span>
            <strong>{t('ncChanges', { n: changeCount })}</strong>
          </div>

          <section className="node-control-section">
            <div className="node-section-heading">
              <div><h3>{t('ncCommonParams')}</h3><p>{t('ncCommonNote')}</p></div>
            </div>
            <div className="common-controls-grid">
              {parameterSchema.filter(field => field.source === 'common').map(field => {
                const definition = commonDefinition({ ...field, inputNames: field.name === 'sampler' ? ['sampler_name', 'sampler'] : field.name === 'scheduler' ? ['scheduler'] : undefined }, manifest);
                const changed = hasOwn(draft.settings, field.key);
                return (
                  <ControlField
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
          </section>

          {outputNodes.length > 0 && (
            <section className="node-control-section">
              <div className="node-section-heading">
                <div><h3>{t('ncOutputs')}</h3><p>{t('ncOutputsNote')}</p></div>
              </div>
              <div className="output-node-options">
                {visibleOutputNodes.map(node => (
                  <label key={node.id} className="output-node-option">
                    <input
                      type="checkbox"
                      checked={selectedOutputIds.includes(String(node.id))}
                      onChange={() => setDraft(current => toggleOutputControl(current, node.id, outputNodes))}
                    />
                    <span><strong>{node.title || node.type || node.id}</strong><small>{node.id} · {node.type}{node.group ? ` · ${node.group}` : ''}</small></span>
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="node-control-section">
            <div className="node-section-heading">
              <div><h3>{t('ncNodeInputs')}</h3><p>{t('ncNodeInputsNote')}</p></div>
              <input className="node-search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('ncSearchPlaceholder')} />
            </div>
            <div className="node-list">
              {editableNodes.map(node => (
                <div key={node.id} className="node-control-row">
                  <div className="node-control-meta">
                    <strong>{node.title || node.type || node.id}</strong>
                    <span>{node.id} · {node.type}{node.group ? ` · ${node.group}` : ''}</span>
                  </div>
                  <div className="node-inputs">
                    {(node.inputs || []).map(input => {
                      const schema = parameterSchema.find(field => field.nodeId === String(node.id) && field.name === input.name);
                      const changed = hasOwn(draft.nodeOverrides[node.id], input.name);
                      return (
                        <ControlField
                          key={input.name}
                          definition={{
                            ...input,
                            ...(schema || {}),
                            label: schema?.label || nodeInputLabels(t)[input.name] || input.name,
                            description: schema?.description || nodeInputDescriptions(t)[input.name] || '',
                          }}
                          value={draft.nodeOverrides[node.id]?.[input.name]}
                          changed={changed}
                          onChange={value => setDraft(current => setNodeControl(current, node.id, input.name, value))}
                          onReset={() => setDraft(current => setNodeControl(current, node.id, input.name, undefined))}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {editableNodes.length === 0 && <div className="node-list-empty">{t('ncNoMatchingNodes')}</div>}
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <span>{changeCount > 0 ? t('ncApplyNext', { n: changeCount }) : t('ncUseDefaults')}</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={() => setDraft(cloneGenerationControls(EMPTY_GENERATION_CONTROLS))} disabled={changeCount === 0}>{t('ncResetAll')}</button>
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-primary" onClick={applyChanges}>{t('ncApply')}</button>
        </div>
      </section>
    </div>
  );
}
