<template>
  <div class="card" :data-testid="`product-${product.id}`">
    <router-link :to="`/products/${product.id}`">{{ product.name }}</router-link>
    <span>{{ product.price.toFixed(2) }}</span>
    <span v-if="product.stock === 0" class="badge">Out of stock</span>
    <button :disabled="product.stock === 0" @click="$emit('add', product)">Add to cart</button>
  </div>
</template>

<script>
export default {
  props: { product: { type: Object, required: true } },
  emits: ['add'],
}
</script>
