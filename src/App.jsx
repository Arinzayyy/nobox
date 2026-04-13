import { useState, useEffect, useRef } from 'react'
import Dashboard from './components/Dashboard.jsx'

export default function App() {
  const [appState, setAppState] = useState('checking') // checking | login | scanning | done | error
  const [emails, setEmails] = useState(null)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState({ fetched: 0, total: 0, phase: 'fetching', message: '' })
  const eventSourceRef = useRef(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const comingFromOAuth = params.get('authed') === 'true'
    if (comingFromOAuth) {
      // Just finished OAuth — tokens are definitely saved, go straight to scan
      window.history.replaceState({}, '', '/')
      startScan()
      return
    }

    // Not coming from OAuth — check if already authed from a previous session
    fetch('/api/status?t=' + Date.now())
      .then(r => r.json())
      .then(({ authed }) => {
        if (authed) {
          setAppState('authed') // already have tokens, show scan button
        } else {
          setAppState('login')
        }
      })
      .catch(() => setAppState('login'))

    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close()
    }
  }, [])

  async function handleConnectGmail() {
    const res = await fetch('/api/auth')
    const { url } = await res.json()
    window.location.href = url
  }

  function startScan() {
    setAppState('scanning')
    setError(null)
    setEmails(null)
    setProgress({ fetched: 0, total: 0, phase: 'fetching', message: 'Connecting to Gmail...' })

    if (eventSourceRef.current) eventSourceRef.current.close()

    const es = new EventSource('/api/emails/stream')
    eventSourceRef.current = es

    es.addEventListener('auth_required', () => {
      es.close()
      setAppState('login')
    })

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      setProgress(p => ({ ...p, message: data.message }))
    })

    es.addEventListener('total', (e) => {
      const data = JSON.parse(e.data)
      setProgress(p => ({ ...p, total: data.total, message: `Found ${data.total} unread emails. Fetching...` }))
    })

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data)
      setProgress(p => ({
        ...p,
        fetched: data.fetched,
        total: data.total,
        phase: data.phase,
        message: data.phase === 'fetching'
          ? `Reading emails... ${data.fetched} / ${data.total}`
          : `Analyzing with Claude... ${data.fetched} / ${data.total}`
      }))
    })

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data)
      setEmails(data.emails)
      setAppState('done')
      es.close()
    })

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data)
        setError(data.message)
      } catch {
        setError('Connection lost. Please try again.')
      }
      setAppState('error')
      es.close()
    })

    // Catch EventSource-level connection failure
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // Already handled by event listeners
        return
      }
      es.close()
      setError('Could not connect to server. Make sure npm run dev is running.')
      setAppState('error')
    }
  }

  // Checking auth
  if (appState === 'checking') {
    return (
      <div className="status-screen">
        <span style={{ color: '#333', fontSize: '0.75rem', letterSpacing: '0.1em' }}>Loading...</span>
      </div>
    )
  }

  // Already authed — show scan button
  if (appState === 'authed') {
    return (
      <div className="login-screen">
        <h1>NOBOX</h1>
        <p>gmail connected</p>
        <button className="btn-primary" onClick={startScan}>
          Scan Inbox
        </button>
        <button className="btn-secondary" onClick={handleConnectGmail} style={{ marginTop: 8 }}>
          Reconnect Gmail
        </button>
      </div>
    )
  }

  // Login / connect screen
  if (appState === 'login') {
    return (
      <div className="login-screen">
        <h1>NOBOX</h1>
        <p>ai-powered inbox triage</p>
        <button className="btn-primary" onClick={handleConnectGmail}>
          Connect Gmail
        </button>
      </div>
    )
  }

  // Scanning with progress bar
  if (appState === 'scanning') {
    const pct = progress.total > 0 ? Math.round((progress.fetched / progress.total) * 100) : 0
    return (
      <div className="status-screen">
        <div className="scan-container">
          <div className="scan-title">NOBOX</div>
          <div className="scan-message">{progress.message || 'Connecting to Gmail...'}</div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-pct">
            {progress.total > 0 ? `${pct}%  —  ${progress.fetched} / ${progress.total}` : ''}
          </div>
        </div>
      </div>
    )
  }

  // Error screen
  if (appState === 'error') {
    return (
      <div className="status-screen">
        <span className="error-msg">Error: {error}</span>
        <button className="btn-secondary" onClick={startScan}>Retry</button>
        <button className="btn-secondary" onClick={() => setAppState('login')} style={{ marginTop: 8 }}>
          Reconnect Gmail
        </button>
      </div>
    )
  }

  // Dashboard
  return <Dashboard emails={emails || []} onRescan={startScan} />
}
