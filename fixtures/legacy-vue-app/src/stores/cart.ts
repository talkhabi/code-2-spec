import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { applyCoupon as apiApplyCoupon } from '@/api/orders'

export const useCartStore = defineStore('cart', () => {
  const items = ref<{ id: string; name: string; price: number; qty: number; stock: number }[]>(JSON.parse(localStorage.getItem('cart') || '[]'))
  const coupon = ref<null | { code: string; discount: number }>(null)

  const subtotal = computed(() => items.value.reduce((s, i) => s + i.price * i.qty, 0))
  const shipping = computed(() => (subtotal.value >= 50 ? 0 : 4.99))
  const total = computed(() => Math.max(0, subtotal.value - (coupon.value?.discount ?? 0)) + shipping.value)

  function persist() { localStorage.setItem('cart', JSON.stringify(items.value)) }

  function add(product, qty = 1) {
    const existing = items.value.find((i) => i.id === product.id)
    const nextQty = (existing?.qty ?? 0) + qty
    if (nextQty > product.stock) throw new Error('Not enough stock')
    if (nextQty > 10) throw new Error('Maximum 10 per product')
    if (existing) existing.qty = nextQty
    else items.value.push({ id: product.id, name: product.name, price: product.price, qty, stock: product.stock })
    persist()
  }

  function remove(id: string) { items.value = items.value.filter((i) => i.id !== id); persist() }
  function clear() { items.value = []; coupon.value = null; persist() }

  async function applyCoupon(code: string) {
    const { data } = await apiApplyCoupon(code, subtotal.value)
    if (!data.valid) throw new Error(data.reason || 'Invalid coupon')
    coupon.value = { code, discount: data.discount }
  }

  return { items, coupon, subtotal, shipping, total, add, remove, clear, applyCoupon }
})
