import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/auth/LoginView.vue'

const routes = [
  { path: '/', redirect: '/products' },
  { path: '/login', name: 'login', component: LoginView, meta: { guestOnly: true } },
  { path: '/register', name: 'register', component: () => import('@/views/auth/RegisterView.vue'), meta: { guestOnly: true } },
  { path: '/forgot-password', name: 'forgot-password', component: () => import('@/views/auth/ForgotPasswordView.vue') },
  { path: '/reset-password/:token', name: 'reset-password', component: () => import('@/views/auth/ResetPasswordView.vue') },
  { path: '/login/2fa', name: 'two-factor', component: () => import('@/views/auth/TwoFactorView.vue') },
  { path: '/oauth/callback', name: 'oauth-callback', component: () => import('@/views/auth/OAuthCallbackView.vue') },
  {
    path: '/products',
    children: [
      { path: '', name: 'products', component: () => import('@/views/shop/ProductsView.vue') },
      { path: ':id', name: 'product', component: () => import('@/views/shop/ProductDetailView.vue') },
    ],
  },
  { path: '/cart', name: 'cart', component: () => import('@/views/shop/CartView.vue') },
  { path: '/checkout', name: 'checkout', component: () => import('@/views/shop/CheckoutView.vue'), meta: { requiresAuth: true } },
  { path: '/orders', name: 'orders', component: () => import('@/views/shop/OrdersView.vue'), meta: { requiresAuth: true } },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { requiresAuth: true } },
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.guestOnly && auth.isLoggedIn) {
    return { name: 'products' }
  }
})

export default router
