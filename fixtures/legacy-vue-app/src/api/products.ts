import http from './http'

export const getProducts = (params: { q?: string; category?: string; page?: number }) => http.get('/products', { params })
export const getProduct = (id: string) => http.get(`/products/${id}`)
