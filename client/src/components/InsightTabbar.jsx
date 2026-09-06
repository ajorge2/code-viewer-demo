export default function InsightTabbar({ label = 'Insight views', tabs, activeTab, onTabChange, onClose, className = '' }) {
  return (
    <div className={`insight-tabbar${className ? ` ${className}` : ''}`} role="tablist" aria-label={label}>
      <span className="insight-tabbar-title">Insight</span>
      {tabs.map(({ id, label: tabLabel }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeTab === id}
          className={activeTab === id ? 'active' : ''}
          onClick={() => onTabChange?.(id)}
        >
          {tabLabel}
        </button>
      ))}
      <button type="button" className="insight-collapse" onClick={onClose} aria-label="Hide Insight">×</button>
    </div>
  )
}
