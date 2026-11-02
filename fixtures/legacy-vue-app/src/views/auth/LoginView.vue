<template>
  <form class="login" @submit.prevent="submit">
    <h1>Sign in</h1>
    <p v-if="$route.query.expired" class="info">Your session expired. Please sign in again.</p>
    <input v-model="email" type="email" name="email" placeholder="Email" />
    <input v-model="password" type="password" name="password" placeholder="Password" />
    <label><input v-model="remember" type="checkbox" name="remember" /> Remember me</label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="submit" :disabled="loading || auth.isLocked">Sign in</button>
    <button type="button" @click="loginWithGoogle">Continue with Google</button>
    <router-link to="/forgot-password">Forgot password?</router-link>
    <router-link to="/register">Create an account</router-link>
  </form>
</template>

<script>
import { useAuthStore } from '@/stores/auth'
import { isEmail } from '@/utils/validators'

export default {
  data() {
    return { email: '', password: '', remember: false, error: '', loading: false }
  },
  computed: {
    auth() { return useAuthStore() },
  },
  methods: {
    async submit() {
      this.error = ''
      if (!isEmail(this.email)) { this.error = 'Please enter a valid email address'; return }
      if (!this.password) { this.error = 'Password is required'; return }
      this.loading = true
      try {
        const result = await this.auth.login(this.email, this.password, this.remember)
        if (result.twoFactor) return this.$router.push({ name: 'two-factor' })
        this.$router.push(this.$route.query.redirect || '/products')
      } catch (e) {
        this.error = e.response?.status === 401 ? 'Invalid email or password' : (e.message || 'Something went wrong')
      } finally {
        this.loading = false
      }
    },
    loginWithGoogle() {
      const redirect = encodeURIComponent(window.location.origin + '/oauth/callback?provider=google')
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${import.meta.env.VITE_GOOGLE_CLIENT_ID}&redirect_uri=${redirect}&response_type=code&scope=email%20profile`
    },
  },
}
</script>
