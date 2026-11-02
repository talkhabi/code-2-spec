import { defineStore } from 'pinia'
import * as api from '@/api/auth'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as null | { id: string; name: string; email: string; twoFactorEnabled: boolean },
    token: localStorage.getItem('token'),
    pendingChallenge: null as null | string,
    failedAttempts: 0,
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    isLocked: (s) => s.failedAttempts >= 5,
  },
  actions: {
    async login(email: string, password: string, remember: boolean) {
      if (this.isLocked) throw new Error('Too many failed attempts. Try again in 15 minutes.')
      try {
        const { data } = await api.login(email, password, remember)
        this.failedAttempts = 0
        if (data.twoFactorRequired) {
          this.pendingChallenge = data.challengeId
          return { twoFactor: true }
        }
        this.setSession(data.token, data.user, remember)
        return { twoFactor: false }
      } catch (e) {
        this.failedAttempts++
        throw e
      }
    },
    async verifyTwoFactor(code: string) {
      const { data } = await api.verifyTwoFactor(this.pendingChallenge!, code)
      this.pendingChallenge = null
      this.setSession(data.token, data.user, true)
    },
    async loginWithOAuth(provider: string, code: string) {
      const { data } = await api.exchangeOAuthCode(provider, code)
      this.setSession(data.token, data.user, true)
    },
    async register(payload) {
      const { data } = await api.register(payload)
      this.setSession(data.token, data.user, true)
    },
    setSession(token: string, user, remember: boolean) {
      this.token = token
      this.user = user
      if (remember) localStorage.setItem('token', token)
      else sessionStorage.setItem('token', token)
    },
    async logout() {
      try { await api.logout() } finally {
        this.token = null
        this.user = null
        localStorage.removeItem('token')
        sessionStorage.removeItem('token')
      }
    },
  },
})
