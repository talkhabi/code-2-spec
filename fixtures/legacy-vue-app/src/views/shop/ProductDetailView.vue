<template>
  <article v-if="product">
    <h1>{{ product.name }}</h1>
    <p>{{ product.description }}</p>
    <input v-model.number="qty" type="number" min="1" max="10" name="qty" />
    <button :disabled="product.stock === 0" @click="add">Add to cart</button>
    <p v-if="message">{{ message }}</p>
  </article>
  <p v-else-if="notFound">Product not found</p>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { getProduct } from '@/api/products'
import { useCartStore } from '@/stores/cart'

const route = useRoute()
const product = ref<any>(null)
const notFound = ref(false)
const qty = ref(1)
const message = ref('')
const cart = useCartStore()

onMounted(async () => {
  try { product.value = (await getProduct(route.params.id as string)).data } catch { notFound.value = true }
})

function add() {
  try { cart.add(product.value, qty.value); message.value = 'Added to cart' } catch (e: any) { message.value = e.message }
}
</script>
