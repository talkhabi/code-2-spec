import http from './http'

export function login(email: string, password: string, remember: boolean) {
  return http.post('/auth/login', { email, password, remember })
}

export function verifyTwoFactor(challengeId: string, code: string) {
  return http.post('/auth/2fa/verify', { challengeId, code })
}

export function register(payload: { name: string; email: string; password: string; acceptTerms: boolean }) {
  return http.post('/auth/register', payload)
}

export function requestPasswordReset(email: string) {
  return http.post('/auth/password/forgot', { email })
}

export function resetPassword(token: string, password: string) {
  return http.post(`/auth/password/reset/${token}`, { password })
}

export function exchangeOAuthCode(provider: string, code: string) {
  return http.post(`/auth/oauth/${provider}/callback`, { code })
}

export function fetchMe() {
  return http.get('/auth/me')
}

export function logout() {
  return http.post('/auth/logout')
}

export function changePassword(current: string, next: string) {
  return http.put('/users/me/password', { current, next })
}
