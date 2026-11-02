<template>
  <form @submit.prevent="placeOrder">
    <h1>Checkout</h1>
    <input v-model="address.street" name="street" placeholder="Street" />
    <input v-model="address.city" name="city" placeholder="City" />
    <input v-model="address.zip" name="zip" placeholder="ZIP" />
    <select v-model="payment" name="payment"><option value="card">Card</option><option value="cod">Cash on delivery</option></select>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="submit" :disabled="submitting">Place order ({{ cart.total.toFixed(2) }})</button>
  </form>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useCartStore } from '@/stores/cart'
import { createOrder } from '@/api/orders'

const cart = useCartStore()
const router = useRouter()
const address = reactive({ street: '', city: '', zip: '' })
const payment = ref('card')
const error = ref('')
const submitting = ref(false)

onMounted(() => { if (!cart.items.length) router.replace('/cart') })

async function placeOrder() {
  if (!address.street || !address.city || !/^\d{5}$/.test(address.zip)) { error.value = 'Please complete a valid shipping address'; return }
  if (payment.value === 'cod' && cart.total > 200) { error.value = 'Cash on delivery is only available for orders up to 200'; return }
  submitting.value = true
  try {
    await createOrder({ items: cart.items, address, payment: payment.value, coupon: cart.coupon?.code })
    cart.clear()
    router.push('/orders?placed=1')
  } catch (e: any) {
    error.value = e.response?.status === 409 ? 'Some items are no longer in stock' : 'Could not place order'
  } finally {
    submitting.value = false
  }
}
</script>
