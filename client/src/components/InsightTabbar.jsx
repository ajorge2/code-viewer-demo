export default function InsightTabbar({ label = 'Insight views', tabs, activeTab, onTabChange, onClose, className = '', leading = null }) {
  return (
    <div className={`insight-tabbar${className ? ` ${className}` : ''}`} role="tablist" aria-label={label}>
      {leading && <div className="insight-tabbar-scope">{leading}</div>}
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
      {onClose && (
        <button type="button" className="insight-collapse" onClick={onClose} aria-label="Hide Insight"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      )}
    </div>
  )
}
