<template>
  <form @submit.prevent="submit">
    <h1>Choose a new password</h1>
    <input v-model="password" name="password" type="password" />
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="submit">Save password</button>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resetPassword } from '@/api/auth'
import { passwordProblems } from '@/utils/validators'

const route = useRoute()
const router = useRouter()
const password = ref('')
const error = ref('')

async function submit() {
  const problems = passwordProblems(password.value)
  if (problems.length) { error.value = `Password needs ${problems.join(', ')}`; return }
  try {
    await resetPassword(route.params.token as string, password.value)
    router.push('/login?reset=1')
  } catch (e: any) {
    error.value = e.response?.status === 410 ? 'This reset link has expired' : 'Could not reset password'
  }
}
</script>
