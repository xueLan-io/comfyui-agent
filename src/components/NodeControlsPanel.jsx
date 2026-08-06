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

const NODE_SETTING_FIELDS = [
  { key: 'seed', label: '随机种子 Seed', description: '相同种子和参数通常会得到相近结果；留空使用工作流默认值。', type: 'number' },
  { key: 'steps', label: '采样步数 Steps', description: '控制去噪迭代次数，越高通常越细致，但速度更慢。', type: 'number', min: 1, max: 150, step: 1 },
  { key: 'cfg', label: '提示词遵循度 CFG', description: '控制画面遵循提示词的程度，过高可能导致画面僵硬或失真。', type: 'number', min: 0, max: 30, step: 0.1 },
  { key: 'width', label: '宽度 Width', description: '输出图像宽度，建议使用模型支持的尺寸倍数。', type: 'number', min: 64, max: 4096, step: 8 },
  { key: 'height', label: '高度 Height', description: '输出图像高度，建议使用模型支持的尺寸倍数。', type: 'number', min: 64, max: 4096, step: 8 },
  { key: 'batch', label: '批量 Batch', description: '一次生成的图片数量，会增加显存和耗时。', type: 'number', min: 1, max: 8, step: 1 },
  { key: 'denoise', label: '重绘幅度 Denoise', description: '图生图或重绘时控制保留原图的程度，越高改动越大。', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'sampler', label: '采样器 Sampler', description: '选择生成过程使用的采样算法，不同算法会影响速度和质感。', type: 'text', inputNames: ['sampler_name', 'sampler'] },
  { key: 'scheduler', label: '调度器 Scheduler', description: '控制采样过程中噪声变化的调度方式。', type: 'text', inputNames: ['scheduler'] },
];

const NODE_INPUT_LABELS = {
  positive: '正向提示词',
  negative: '负向提示词',
  text: '文本内容',
  seed: '随机种子 Seed',
  steps: '采样步数 Steps',
  cfg: '提示词遵循度 CFG',
  sampler_name: '采样器 Sampler',
  scheduler: '调度器 Scheduler',
  denoise: '重绘幅度 Denoise',
  width: '宽度 Width',
  height: '高度 Height',
  batch_size: '批量 Batch',
};

const NODE_INPUT_DESCRIPTIONS = {
  positive: '描述希望生成的主体、动作、构图和画面风格。',
  negative: '描述希望避免的内容；仅在工作流支持时生效。',
  seed: '控制随机性；相同种子和参数通常会得到相近结果。',
  steps: '去噪迭代次数，越高通常越细致，但速度更慢。',
  cfg: '控制画面遵循提示词的程度。',
  denoise: '图生图或重绘时控制改动幅度。',
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return '未设置';
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
  const controlId = useId();
  const type = String(definition.type || '').toLowerCase();
  const label = definition.label || definition.name;
  const defaultLabel = `默认：${displayValue(definition.value)}`;
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
        <option value="true">是</option>
        <option value="false">否</option>
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
      <div className="parameter-range-control"><input id={controlId} type="range" min={definition.min} max={definition.max} step={definition.step} value={changed ? value : definition.value ?? definition.min} onChange={event => onChange(parseControlValue(definition, event.target.value))} /><output>{displayValue(changed ? value : definition.value)}</output></div>
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
        {changed && <button type="button" onClick={onReset} title={`恢复 ${label} 的默认值`}><Icon name="refresh" size={13} /></button>}
      </span>
      {control}
      {definition.description && <small className="node-input-description">{definition.description}</small>}
    </div>
  );
}

export default function NodeControlsPanel({ manifest, controls, onChange, onClose }) {
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
      <section className="node-controls-panel" onClick={event => event.stopPropagation()} aria-label="节点控制">
        <div className="modal-header">
          <div>
            <h2>工作流参数</h2>
            <p>{manifest.workflowName}</p>
          </div>
          <button className="btn btn-icon" onClick={onClose} title="关闭"><Icon name="close" /></button>
        </div>

        <div className="node-controls-body">
          <div className="node-runtime-summary">
            <span>{manifest.modelType || 'generic'}</span>
            <span>{manifest.activeNodeCount || 0} 个激活节点</span>
            <span>{manifest.editableNodeCount || 0} 个可编辑节点</span>
            <strong>{changeCount} 项变更</strong>
          </div>

          <section className="node-control-section">
            <div className="node-section-heading">
              <div><h3>生成参数</h3><p>仅覆盖已修改项，其余继续使用工作流当前值。</p></div>
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
                <div><h3>输出分支</h3><p>至少保留一个输出；默认执行全部输出。</p></div>
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
              <div><h3>节点输入</h3><p>按节点 ID 精确覆盖未连接的输入值。</p></div>
              <input className="node-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索节点、分组或 ID" />
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
                            label: schema?.label || NODE_INPUT_LABELS[input.name] || input.name,
                            description: schema?.description || NODE_INPUT_DESCRIPTIONS[input.name] || '',
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
              {editableNodes.length === 0 && <div className="node-list-empty">没有匹配的可编辑节点</div>}
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <span>{changeCount > 0 ? `下一次生成将应用 ${changeCount} 项变更` : '下一次生成将使用工作流默认参数'}</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={() => setDraft(cloneGenerationControls(EMPTY_GENERATION_CONTROLS))} disabled={changeCount === 0}>恢复全部</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={applyChanges}>应用变更</button>
        </div>
      </section>
    </div>
  );
}
