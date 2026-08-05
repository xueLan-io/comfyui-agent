import Icon from './Icon.jsx';

const CATEGORY_LABELS = {
  sexual_content: '色情内容',
  sexualized_minors: '未成年色情内容',
  graphic_violence: '暴力血腥内容',
  self_harm: '自残自杀内容',
  illicit_instructions: '非法指令',
  unreviewed_media: '未审查的媒体内容',
};

export default function PolicyConfirmModal({ pending, onConfirm, onCancel }) {
  if (!pending) return null;
  const categories = (pending.categories || []).map(category => CATEGORY_LABELS[category] || category);
  return (
    <div className="modal-overlay prompt-preview-overlay">
      <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label="云端审查确认">
        <header className="modal-header prompt-preview-header">
          <div>
            <h2>云端审查拦截</h2>
            <p>内容未发送到云端模型</p>
          </div>
          <button className="btn btn-icon" onClick={onCancel} title="关闭"><Icon name="close" /></button>
        </header>
        <div className="prompt-preview-body">
          <div className="prompt-preview-warning">{pending.message || '该内容未通过云端安全审查，已被拦截。'}</div>
          {categories.length > 0 && (
            <section className="prompt-preview-section">
              <h3>拦截原因</h3>
              <p className="prompt-preview-text">{categories.join('、')}</p>
            </section>
          )}
          <section className="prompt-preview-section">
            <h3>被拦截的内容</h3>
            <p className="prompt-preview-text">{pending.text}</p>
          </section>
          <p className="prompt-preview-assistant-note">如果执意要发送到云端，需要手动确认。发送后云端服务商仍可能对其内容承担责任，请自行评估风险。</p>
        </div>
        <footer className="settings-footer prompt-preview-footer">
          <span>取消后内容不会发送到云端。</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={onConfirm}>仍然发送到云端</button>
        </footer>
      </section>
    </div>
  );
}
