// Legacy Express API (mock persistence)
const express = require('express')
const auth = require('./auth')
const app = express()
app.use(express.json())

app.post('/api/auth/login', auth.login)
app.post('/api/auth/2fa/verify', auth.verifyTwoFactor)
app.post('/api/auth/register', auth.register)
app.post('/api/auth/password/forgot', (req, res) => res.status(202).end())
app.post('/api/auth/password/reset/:token', auth.resetPassword)
app.post('/api/auth/oauth/:provider/callback', auth.oauthCallback)
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json(req.user))
app.post('/api/auth/logout', auth.requireAuth, (req, res) => res.status(204).end())
app.put('/api/users/me/password', auth.requireAuth, auth.changePassword)

app.get('/api/products', (req, res) => {
  const page = Number(req.query.page || 1)
  res.json({ items: [], hasMore: page < 3 })
})
app.get('/api/products/:id', (req, res) => res.status(404).end())
app.post('/api/coupons/validate', (req, res) => {
  const { code, subtotal } = req.body
  if (code === 'WELCOME10' && subtotal >= 20) return res.json({ valid: true, discount: 10 })
  res.json({ valid: false, reason: subtotal < 20 ? 'Minimum order of 20 required' : 'Unknown coupon' })
})
app.post('/api/orders', auth.requireAuth, (req, res) => res.status(201).json({ id: Date.now() }))
app.get('/api/orders', auth.requireAuth, (req, res) => res.json([]))

app.listen(3001)
