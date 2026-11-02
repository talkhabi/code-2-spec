import { describe, expect, it } from 'vitest';
import { tsJsAdapter } from '../src/adapters/ts-js.js';
import { vueAdapter } from '../src/adapters/vue.js';

describe('ts/js adapter', () => {
  it('extracts vue-router routes with nested paths and lazy components', () => {
    const a = tsJsAdapter.analyze('src/router/index.ts', `
      import Login from '@/views/Login.vue'
      const routes = [
        { path: '/login', name: 'login', component: Login },
        { path: '/shop', children: [ { path: ':id', name: 'product', component: () => import('@/views/Product.vue') } ] },
      ]`);
    expect(a.routes.map((r) => [r.path, r.targetSpecifier])).toEqual([
      ['/login', '@/views/Login.vue'], ['/shop', undefined], ['/shop/:id', '@/views/Product.vue'],
    ]);
  });

  it('distinguishes express routes from axios calls', () => {
    const a = tsJsAdapter.analyze('server.js', `
      const auth = require('./auth')
      app.post('/api/login', auth.login)
      router.get('/api/items/:id', (req, res) => res.json({}))
      http.post('/auth/login', { email })
      axios.get(\`/products/\${id}\`)
      fetch('/api/x', { method: 'delete' })`);
    expect(a.routes.map((r) => `${r.method} ${r.path} ${r.targetSpecifier ?? ''}`.trim())).toEqual(['POST /api/login ./auth', 'GET /api/items/:id']);
    expect(a.httpCalls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /auth/login', 'GET /products/{id}', 'DELETE /api/x']);
  });

  it('resolves URLs held in same-file constants', () => {
    const a = tsJsAdapter.analyze('requests/useHelp.ts', `
      const ENDPOINT = '/api/v1/help'
      export const fetchHelp = () => axiosInstance.get<Help>(ENDPOINT)
      export const fetchOne = (id: string) => axiosInstance.delete(\`\${ENDPOINT}/\${id}\`)`);
    expect(a.httpCalls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/v1/help', 'DELETE /api/v1/help/{id}']);
  });

  it('extracts pinia option and setup stores', () => {
    const a = tsJsAdapter.analyze('store.ts', `
      export const useA = defineStore('a', { actions: { login() {}, logout() {} } })
      export const useB = defineStore('b', () => { function add() {} ; return { add } })`);
    expect(a.stores).toEqual([
      expect.objectContaining({ name: 'a', actions: ['login', 'logout'] }),
      expect.objectContaining({ name: 'b', actions: ['add'] }),
    ]);
  });

  it('extracts nest controllers', () => {
    const a = tsJsAdapter.analyze('users.controller.ts', `
      @Controller('users') export class UsersController { @Get(':id') find() {} @Post() create() {} }`);
    expect(a.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /users/:id', 'POST /users']);
  });
});

describe('vue adapter', () => {
  it('maps script lines back to the SFC and finds template handlers', () => {
    const src = `<template>\n  <button @click="save">Save</button>\n  <router-link to="/cart">Cart</router-link>\n</template>\n<script setup lang="ts">\nimport { api } from '@/api'\nfunction save() {\n  api.post('/items', {})\n}\n</script>\n`;
    const a = vueAdapter.analyze('src/views/Edit.vue', src);
    expect(a.imports).toContain('@/api');
    expect(a.symbols.find((s) => s.name === 'save')).toMatchObject({ startLine: 7, endLine: 9 });
    expect(a.httpCalls[0]).toMatchObject({ method: 'POST', url: '/items', line: 8 });
    expect(a.navigations).toContain('/cart');
    expect(a.symbols.some((s) => s.kind === 'handler' && s.startLine === 2)).toBe(true);
  });
});
