<template><p>{{ error || 'Signing you in…' }}</p></template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const error = ref('')

onMounted(async () => {
  const code = route.query.code as string
  if (!code) { error.value = 'Sign-in was cancelled'; return }
  try {
    await auth.loginWithOAuth((route.query.provider as string) || 'google', code)
    router.replace('/products')
  } catch {
    error.value = 'Could not sign in with Google. Please try again.'
  }
})
</script>
