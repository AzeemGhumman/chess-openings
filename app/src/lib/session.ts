export interface GoogleUser {
  id: string; name: string; email: string; picture: string
}

export interface StoredSession {
  user: GoogleUser; idToken: string; chesscomUsername?: string
}

const KEY = 'chess_insights_session'

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredSession
    if (!s.idToken) { clearSession(); return null }
    return s
  } catch { return null }
}

export function saveSession(s: StoredSession) {
  localStorage.setItem(KEY, JSON.stringify(s))
}

export function clearSession() {
  localStorage.removeItem(KEY)
}

// Broadcast session state to any listeners (e.g. global auth widget in App.tsx)
export function broadcastSession(s: StoredSession | null) {
  window.dispatchEvent(new CustomEvent('chess-session', { detail: s }))
}

// Decode the exp claim from a Google JWT (returns ms timestamp)
export function getTokenExpiry(idToken: string): number {
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1]))
    return (payload.exp as number) * 1000
  } catch { return 0 }
}
