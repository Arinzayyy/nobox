import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { google } from 'googleapis'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_FILE = path.join(__dirname, '.tokens.json')

const app = express()
const PORT = 3175

app.use(cors({ origin: 'http://localhost:5175' }))
app.use(express.json())

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
)

// Load tokens from disk on startup
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'))
      oauth2Client.setCredentials(tokens)
      console.log('Tokens loaded from disk')
      return tokens
    }
  } catch (e) {
    console.warn('Could not load tokens:', e.message)
  }
  return null
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens))
  } catch (e) {
    console.warn('Could not save tokens:', e.message)
  }
}

let storedTokens = loadTokens()

// GET /api/auth — generate OAuth URL
app.get('/api/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  })
  res.json({ url })
})

// GET /api/callback — exchange code for tokens
app.get('/api/callback', async (req, res) => {
  const { code } = req.query
  try {
    const { tokens } = await oauth2Client.getToken(code)
    storedTokens = tokens
    saveTokens(tokens)
    oauth2Client.setCredentials(tokens)
    res.redirect('http://localhost:5175?authed=true')
  } catch (err) {
    console.error('Token exchange error:', err)
    res.status(500).json({ error: 'Failed to exchange token' })
  }
})

// GET /api/status — check if authenticated
app.get('/api/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.json({ authed: !!storedTokens })
})

// Helper: decode base64url email body
function decodeBody(payload) {
  if (!payload) return ''
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
      }
    }
  }
  return ''
}

// GET /api/emails/stream — SSE: fetch ALL emails, stream progress
app.get('/api/emails/stream', async (req, res) => {
  // Set up SSE headers first
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  if (!storedTokens) {
    send('auth_required', {})
    res.end()
    return
  }

  try {
    oauth2Client.setCredentials(storedTokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Step 1: Fetch ALL unread message IDs with pagination
    send('status', { message: 'Counting your unread emails...' })
    let allMessages = []
    let pageToken = undefined

    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 500,
        pageToken
      })
      const msgs = listRes.data.messages || []
      allMessages = allMessages.concat(msgs)
      pageToken = listRes.data.nextPageToken
    } while (pageToken)

    const total = allMessages.length
    send('total', { total })

    if (total === 0) {
      send('done', { emails: [] })
      res.end()
      return
    }

    // Step 2: Fetch full email details one at a time to avoid rate limits
    const TRIAGE_BATCH = 20
    let allEmailData = []
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    async function fetchWithRetry(msgId, retries = 3) {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const full = await gmail.users.messages.get({
            userId: 'me',
            id: msgId,
            format: 'full'
          })
          return full
        } catch (err) {
          if (err.code === 429 || (err.errors && err.errors[0]?.reason === 'rateLimitExceeded')) {
            const wait = 2000 * (attempt + 1)
            send('status', { message: `Rate limited, waiting ${wait / 1000}s...` })
            await sleep(wait)
          } else {
            throw err
          }
        }
      }
      throw new Error(`Failed to fetch email ${msgId} after ${retries} retries`)
    }

    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i]
      const full = await fetchWithRetry(msg.id)
      const headers = full.data.payload?.headers || []
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)'
      const from = headers.find(h => h.name === 'From')?.value || '(unknown)'
      const body = decodeBody(full.data.payload).slice(0, 800)
      allEmailData.push({ id: msg.id, subject, from, body })

      send('progress', { fetched: i + 1, total, phase: 'fetching' })

      // Small delay every 5 emails to stay under quota
      if ((i + 1) % 5 === 0) await sleep(300)
    }

    // Step 3: Triage with Claude in batches of 20
    send('status', { message: 'Analyzing with Claude...' })
    let allTriaged = []

    for (let i = 0; i < allEmailData.length; i += TRIAGE_BATCH) {
      const batch = allEmailData.slice(i, i + TRIAGE_BATCH)
      const prompt = batch.map((e, idx) =>
        `Email ${idx + 1}:\nID: ${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nBody: ${e.body}`
      ).join('\n\n---\n\n')

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: `You are an email triage assistant. For each email provided, return a JSON array where each item has:
- id: the email id
- subject: email subject
- sender: sender name or email
- priority: "urgent" | "moderate" | "low"
- needs_action: true or false
- summary: 1-2 sentence summary of what the email is about
- action: what the user should do, or null if no action needed

Return ONLY valid JSON, no markdown, no explanation.`,
        messages: [{ role: 'user', content: prompt }]
      })

      const raw = response.content[0].text.trim()
      const triaged = JSON.parse(raw)
      allTriaged = allTriaged.concat(triaged)

      send('progress', { fetched: Math.min(i + TRIAGE_BATCH, total), total, phase: 'triaging' })
    }

    send('done', { emails: allTriaged })
    res.end()

  } catch (err) {
    console.error('Stream error:', err)
    // If token is expired/invalid, clear it
    if (err.code === 401 || err.message?.includes('invalid_grant')) {
      storedTokens = null
      try { fs.unlinkSync(TOKEN_FILE) } catch {}
      send('auth_required', {})
    } else {
      send('error', { message: err.message || 'Something went wrong' })
    }
    res.end()
  }
})

// POST /api/emails/mark-read — mark given email IDs as read
app.post('/api/emails/mark-read', async (req, res) => {
  if (!storedTokens) return res.status(401).json({ error: 'Not authenticated' })

  const { ids } = req.body
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' })

  try {
    oauth2Client.setCredentials(storedTokens)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    let marked = 0
    for (let i = 0; i < ids.length; i++) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: ids[i],
        requestBody: { removeLabelIds: ['UNREAD'] }
      })
      marked++
      if ((i + 1) % 10 === 0) await sleep(300)
    }

    res.json({ marked })
  } catch (err) {
    console.error('Mark-read error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`NoBox server running on http://localhost:${PORT}`)
})
