<template>
  <section>
    <p v-if="$route.query.placed" class="info">Thank you! Your order was placed.</p>
    <h1>Your orders</h1>
    <p v-if="!orders.length">You have no orders yet</p>
    <div v-for="o in orders" :key="o.id">#{{ o.id }} — {{ o.status }} — {{ o.total }}</div>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getOrders } from '@/api/orders'

const orders = ref<any[]>([])
onMounted(async () => { orders.value = (await getOrders()).data })
</script>
