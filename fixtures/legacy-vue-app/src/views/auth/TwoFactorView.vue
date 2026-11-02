<template>
  <form @submit.prevent="verify">
    <h1>Two-step verification</h1>
    <p>Enter the 6-digit code from your authenticator app.</p>
    <input v-model="code" name="code" inputmode="numeric" maxlength="6" />
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="submit" :disabled="code.length !== 6">Verify</button>
  </form>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const code = ref('')
const error = ref('')
const auth = useAuthStore()
const router = useRouter()

onMounted(() => {
  if (!auth.pendingChallenge) router.replace('/login')
})

async function verify() {
  try {
    await auth.verifyTwoFactor(code.value)
    router.push('/products')
  } catch {
    error.value = 'Invalid or expired code'
    code.value = ''
  }
}
</script>
