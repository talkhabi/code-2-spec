<template>
  <section>
    <h1>{{ auth.user?.name }}</h1>
    <form @submit.prevent="change">
      <h2>Change password</h2>
      <input v-model="current" name="current" type="password" />
      <input v-model="next" name="next" type="password" />
      <p v-if="msg">{{ msg }}</p>
      <button type="submit">Update password</button>
    </form>
    <button @click="signOut">Log out</button>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { changePassword } from '@/api/auth'
import { passwordProblems } from '@/utils/validators'

const auth = useAuthStore()
const router = useRouter()
const current = ref('')
const next = ref('')
const msg = ref('')

async function change() {
  const p = passwordProblems(next.value)
  if (p.length) { msg.value = `Password needs ${p.join(', ')}`; return }
  if (next.value === current.value) { msg.value = 'New password must differ from the current one'; return }
  try { await changePassword(current.value, next.value); msg.value = 'Password updated' } catch { msg.value = 'Current password is incorrect' }
}

async function signOut() {
  await auth.logout()
  router.push('/login')
}
</script>
