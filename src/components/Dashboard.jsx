import { useState } from 'react'
import EmailCard from './EmailCard.jsx'

export default function Dashboard({ emails, onRescan }) {
  const [autoMarkRead, setAutoMarkRead] = useState(false)
  const [marking, setMarking] = useState(false)
  const [markedCount, setMarkedCount] = useState(null)

  const urgent = emails.filter(e => e.priority === 'urgent').length
  const moderate = emails.filter(e => e.priority === 'moderate').length
  const needsAction = emails.filter(e => e.needs_action).length

  async function handleMarkRead(idsToMark) {
    if (idsToMark.length === 0) return
    setMarking(true)
    setMarkedCount(null)
    try {
      const res = await fetch('/api/emails/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: idsToMark })
      })
      const data = await res.json()
      setMarkedCount(data.marked)
    } catch (err) {
      console.error('Mark read failed:', err)
    } finally {
      setMarking(false)
    }
  }

  function markAllRead() {
    handleMarkRead(emails.map(e => e.id))
  }

  function markLowRead() {
    handleMarkRead(emails.filter(e => !e.needs_action && e.priority === 'low').map(e => e.id))
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>NOBOX</h1>
        <div className="header-actions">
          <button className="btn-secondary" onClick={onRescan}>Rescan</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Total Unread</span>
          <span className="stat-value total">{emails.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Urgent</span>
          <span className="stat-value urgent">{urgent}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Moderate</span>
          <span className="stat-value moderate">{moderate}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Needs Action</span>
          <span className="stat-value action">{needsAction}</span>
        </div>
      </div>

      {/* Mark as Read controls */}
      <div className="mark-read-bar">
        <div className="mark-read-buttons">
          <button
            className="btn-secondary"
            onClick={markLowRead}
            disabled={marking}
            title="Mark low-priority, no-action emails as read in Gmail"
          >
            {marking ? 'Marking...' : 'Mark Low-Priority as Read'}
          </button>
          <button
            className="btn-secondary btn-danger"
            onClick={markAllRead}
            disabled={marking}
            title="Mark all scanned emails as read in Gmail"
          >
            {marking ? 'Marking...' : 'Mark All as Read'}
          </button>
        </div>
        <label className="auto-toggle">
          <input
            type="checkbox"
            checked={autoMarkRead}
            onChange={e => setAutoMarkRead(e.target.checked)}
          />
          <span>Auto-mark low-priority as read on rescan</span>
        </label>
        {markedCount !== null && (
          <span className="marked-confirm">✓ {markedCount} emails marked as read in Gmail</span>
        )}
      </div>

      <div className="email-list">
        {emails.length === 0 ? (
          <p style={{ color: '#333', fontSize: '0.875rem', padding: '32px 0' }}>
            No unread emails found.
          </p>
        ) : (
          emails.map(email => (
            <EmailCard key={email.id} email={email} />
          ))
        )}
      </div>
    </div>
  )
}
