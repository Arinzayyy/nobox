export default function EmailCard({ email }) {
  const { sender, subject, summary, priority, needs_action, action } = email

  return (
    <div className={`email-card ${needs_action ? 'action-required' : 'no-action'}`}>
      <div className="card-top">
        <span className="card-sender">{sender}</span>
        <div className="card-badges">
          {needs_action && (
            <span className="action-badge">Action Required</span>
          )}
          <span className={`priority-badge ${priority}`}>{priority}</span>
        </div>
      </div>
      <div className="card-subject">{subject}</div>
      <div className="card-summary">{summary}</div>
      {needs_action && action && (
        <div className="card-action">
          <span>→</span> {action}
        </div>
      )}
    </div>
  )
}
