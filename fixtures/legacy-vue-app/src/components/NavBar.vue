<template>
  <nav>
    <router-link to="/products">Shop</router-link>
    <router-link to="/cart">Cart ({{ cart.items.length }})</router-link>
    <template v-if="auth.isLoggedIn">
      <router-link to="/orders">Orders</router-link>
      <router-link to="/profile">{{ auth.user?.name }}</router-link>
      <button @click="onLogout">Log out</button>
    </template>
    <router-link v-else to="/login">Sign in</router-link>
  </nav>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useCartStore } from '@/stores/cart'

const auth = useAuthStore()
const cart = useCartStore()
const router = useRouter()

async function onLogout() {
  await auth.logout()
  router.push('/login')
}
</script>
