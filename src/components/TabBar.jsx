import Icon from './Icon.jsx';

export default function TabBar({ tabs, active, onChange }) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`tab-bar-item${active === tab.id ? ' active' : ''}`}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          title={tab.label}
        >
          {tab.icon && <Icon name={tab.icon} size={14} />}
          <span>{tab.label}</span>
          {tab.badge != null && tab.badge > 0 && <span className="tab-bar-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
