<template>
  <section>
    <p v-if="$route.query.welcome" class="info">Welcome! Your account is ready.</p>
    <input v-model="q" name="search" placeholder="Search products" @input="debouncedLoad" />
    <select v-model="category" name="category" @change="load">
      <option value="">All</option><option value="books">Books</option><option value="games">Games</option>
    </select>
    <p v-if="!loading && !products.length">No products found</p>
    <ProductCard v-for="p in products" :key="p.id" :product="p" @add="addToCart" />
    <button v-if="hasMore" @click="loadMore">Load more</button>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ProductCard from '@/components/ProductCard.vue'
import { getProducts } from '@/api/products'
import { useCartStore } from '@/stores/cart'

const q = ref('')
const category = ref('')
const page = ref(1)
const products = ref<any[]>([])
const hasMore = ref(false)
const loading = ref(false)
const cart = useCartStore()
let timer: any

async function load() {
  loading.value = true
  page.value = 1
  const { data } = await getProducts({ q: q.value, category: category.value, page: 1 })
  products.value = data.items
  hasMore.value = data.hasMore
  loading.value = false
}
function debouncedLoad() { clearTimeout(timer); timer = setTimeout(load, 300) }
async function loadMore() {
  page.value++
  const { data } = await getProducts({ q: q.value, category: category.value, page: page.value })
  products.value.push(...data.items)
  hasMore.value = data.hasMore
}
function addToCart(p) {
  try { cart.add(p) } catch (e: any) { alert(e.message) }
}
onMounted(load)
</script>
