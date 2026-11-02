import http from './http'

export const createOrder = (payload: any) => http.post('/orders', payload)
export const getOrders = () => http.get('/orders')
export const applyCoupon = (code: string, subtotal: number) => http.post('/coupons/validate', { code, subtotal })
