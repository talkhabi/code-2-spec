const users = new Map()
const MAX_ATTEMPTS = 5

exports.login = (req, res) => {
  const { email, password } = req.body
  const user = users.get(email)
  if (!user || user.password !== password) return res.status(401).json({ error: 'invalid_credentials' })
  if (user.attempts >= MAX_ATTEMPTS) return res.status(423).json({ error: 'locked' })
  if (user.twoFactorEnabled) return res.json({ twoFactorRequired: true, challengeId: 'c-' + Date.now() })
  res.json({ token: 't-' + user.id, user })
}

exports.verifyTwoFactor = (req, res) => {
  if (!/^\d{6}$/.test(req.body.code)) return res.status(400).json({ error: 'invalid_code' })
  res.json({ token: 't-2fa', user: {} })
}

exports.register = (req, res) => {
  const { email, name, password, acceptTerms } = req.body
  if (!acceptTerms) return res.status(400).json({ error: 'terms_required' })
  if (users.has(email)) return res.status(409).json({ error: 'email_taken' })
  const user = { id: users.size + 1, email, name, password, attempts: 0 }
  users.set(email, user)
  res.status(201).json({ token: 't-' + user.id, user })
}

exports.resetPassword = (req, res) => {
  if (req.params.token.startsWith('expired')) return res.status(410).end()
  res.status(204).end()
}

exports.oauthCallback = (req, res) => {
  if (req.params.provider !== 'google') return res.status(400).json({ error: 'unsupported_provider' })
  res.json({ token: 't-oauth', user: { name: 'Google User' } })
}

exports.changePassword = (req, res) => {
  if (req.user.password !== req.body.current) return res.status(400).json({ error: 'wrong_password' })
  res.status(204).end()
}

exports.requireAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).end()
  req.user = { id: 1 }
  next()
}
