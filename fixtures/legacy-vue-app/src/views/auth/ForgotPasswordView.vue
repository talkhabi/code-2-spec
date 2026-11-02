<template>
  <form @submit.prevent="submit">
    <h1>Reset your password</h1>
    <template v-if="!sent">
      <input v-model="email" name="email" type="email" placeholder="Email" />
      <button type="submit" :disabled="!email">Send reset link</button>
    </template>
    <p v-else>If an account exists for {{ email }}, we sent a reset link. It expires in 1 hour.</p>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { requestPasswordReset } from '@/api/auth'

const email = ref('')
const sent = ref(false)

async function submit() {
  // always show success to avoid leaking which emails are registered
  try { await requestPasswordReset(email.value) } catch { /* ignore */ }
  sent.value = true
}
</script>
