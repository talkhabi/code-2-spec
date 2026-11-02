<template>
  <form @submit.prevent="submit">
    <h1>Create account</h1>
    <input v-model="form.name" name="name" placeholder="Full name" />
    <input v-model="form.email" name="email" type="email" placeholder="Email" />
    <input v-model="form.password" name="password" type="password" placeholder="Password" />
    <input v-model="confirm" name="confirm" type="password" placeholder="Confirm password" />
    <label><input v-model="form.acceptTerms" type="checkbox" name="terms" /> I accept the terms</label>
    <ul v-if="errors.length" role="alert"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
    <button type="submit">Create account</button>
  </form>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { isEmail, passwordProblems } from '@/utils/validators'

const form = reactive({ name: '', email: '', password: '', acceptTerms: false })
const confirm = ref('')
const errors = ref<string[]>([])
const auth = useAuthStore()
const router = useRouter()

async function submit() {
  errors.value = []
  if (form.name.trim().length < 2) errors.value.push('Name must be at least 2 characters')
  if (!isEmail(form.email)) errors.value.push('Please enter a valid email address')
  const pw = passwordProblems(form.password)
  if (pw.length) errors.value.push(`Password needs ${pw.join(', ')}`)
  if (form.password !== confirm.value) errors.value.push('Passwords do not match')
  if (!form.acceptTerms) errors.value.push('You must accept the terms')
  if (errors.value.length) return
  try {
    await auth.register(form)
    router.push('/products?welcome=1')
  } catch (e: any) {
    errors.value.push(e.response?.status === 409 ? 'An account with this email already exists' : 'Registration failed')
  }
}
</script>
