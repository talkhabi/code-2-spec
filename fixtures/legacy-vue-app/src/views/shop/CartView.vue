<template>
  <section>
    <h1>Your cart</h1>
    <p v-if="!cart.items.length">Your cart is empty</p>
    <div v-for="i in cart.items" :key="i.id" class="line">
      {{ i.name }} × {{ i.qty }} — {{ (i.price * i.qty).toFixed(2) }}
      <button @click="cart.remove(i.id)">Remove</button>
    </div>
    <form @submit.prevent="apply">
      <input v-model="code" name="coupon" placeholder="Coupon code" />
      <button type="submit">Apply</button>
      <p v-if="couponError" role="alert">{{ couponError }}</p>
    </form>
    <p>Subtotal: {{ cart.subtotal.toFixed(2) }}</p>
    <p>Shipping: {{ cart.shipping === 0 ? 'Free' : cart.shipping.toFixed(2) }}</p>
    <p>Total: {{ cart.total.toFixed(2) }}</p>
    <router-link v-if="cart.items.length" to="/checkout">Checkout</router-link>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useCartStore } from '@/stores/cart'

const cart = useCartStore()
const code = ref('')
const couponError = ref('')

async function apply() {
  couponError.value = ''
  try { await cart.applyCoupon(code.value) } catch (e: any) { couponError.value = e.message }
}
</script>
