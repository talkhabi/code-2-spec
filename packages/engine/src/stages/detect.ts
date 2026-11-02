import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import type { Project } from '../project.js';

export interface ProjectProfile {
  languages: Record<string, number>; // extension -> file count
  frameworks: string[];
  router: string[];
  state: string[];
  http: string[];
  server: string[];
  testing: string[];
  packageManager?: string;
  aliases: Record<string, string>;
  entryPoints: string[];
  workspaces: string[];
}

const FRAMEWORKS: Record<string, string> = {
  vue: 'vue', nuxt: 'nuxt', react: 'react', next: 'next', '@angular/core': 'angular', svelte: 'svelte',
  '@sveltejs/kit': 'sveltekit', 'solid-js': 'solid', express: 'express', koa: 'koa', fastify: 'fastify',
  '@nestjs/core': 'nestjs', hapi: 'hapi', '@hapi/hapi': 'hapi', electron: 'electron', jquery: 'jquery',
  'react-native': 'react-native', '@ionic/vue': 'ionic', quasar: 'quasar', vuetify: 'vuetify',
};
const ROUTERS = ['vue-router', 'react-router', 'react-router-dom', '@tanstack/react-router', '@angular/router'];
const STATE = ['pinia', 'vuex', 'redux', '@reduxjs/toolkit', 'mobx', 'zustand', 'recoil', 'jotai', '@ngrx/store'];
const HTTP = ['axios', 'ky', 'ofetch', 'superagent', 'graphql-request', '@apollo/client', '@tanstack/react-query', '@tanstack/vue-query', 'swr'];
const SERVER = ['express', 'koa', 'fastify', '@nestjs/core', 'hapi', '@hapi/hapi', 'prisma', '@prisma/client', 'typeorm', 'sequelize', 'mongoose', 'knex'];
const TESTING = ['jest', 'vitest', 'mocha', 'cypress', '@playwright/test', '@testing-library/vue', '@testing-library/react', 'karma'];

export async function detect(project: Project): Promise<ProjectProfile> {
  const root = project.root;
  const files = await fg(project.config.include, { cwd: root, ignore: project.config.exclude, dot: false });
  const languages: Record<string, number> = {};
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf('.') + 1);
    languages[ext] = (languages[ext] ?? 0) + 1;
  }

  const pkgFiles = await fg(['package.json', '**/package.json'], { cwd: root, ignore: project.config.exclude, deep: 4 });
  const deps = new Set<string>();
  const workspaces: string[] = [];
  const entryPoints = new Set<string>();
  for (const pf of pkgFiles) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, pf), 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(pkg[k] ?? {}).forEach((d) => deps.add(d));
      if (pf !== 'package.json') workspaces.push(pf.replace(/\/package\.json$/, ''));
      if (typeof pkg.main === 'string') entryPoints.add(join(pf.replace(/package\.json$/, ''), pkg.main));
    } catch {
      /* ignore broken package.json */
    }
  }
  for (const candidate of ['src/main.ts', 'src/main.js', 'src/index.ts', 'src/index.js', 'src/App.vue', 'src/app.ts', 'server.js', 'app.js', 'index.js', 'pages/index.vue', 'app.vue']) {
    if (existsSync(join(root, candidate))) entryPoints.add(candidate);
  }

  const pick = (list: string[]) => list.filter((d) => deps.has(d));
  const frameworks = [...new Set(Object.entries(FRAMEWORKS).filter(([d]) => deps.has(d)).map(([, n]) => n))];
  if (!frameworks.length && (languages.vue ?? 0) > 0) frameworks.push('vue');

  const packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(root, 'yarn.lock')) ? 'yarn'
    : existsSync(join(root, 'bun.lockb')) ? 'bun'
    : existsSync(join(root, 'package-lock.json')) ? 'npm' : undefined;

  const profile: ProjectProfile = {
    languages, frameworks, router: pick(ROUTERS), state: pick(STATE), http: pick(HTTP), server: pick(SERVER),
    testing: pick(TESTING), packageManager, aliases: readAliases(root), entryPoints: [...entryPoints], workspaces,
  };
  if (frameworks.includes('nuxt')) profile.router.push('nuxt-file-routing');
  if (frameworks.includes('next')) profile.router.push('next-file-routing');
  return profile;
}

/** Path aliases from tsconfig/jsconfig `paths`, plus the near-universal `@/` → `src/` convention. */
function readAliases(root: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (existsSync(join(root, 'src'))) {
    aliases['@'] = 'src';
    aliases['~'] = 'src';
  }
  for (const file of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json']) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
      const cfg = JSON.parse(text);
      const baseUrl: string = cfg.compilerOptions?.baseUrl ?? '.';
      for (const [k, v] of Object.entries<string[]>(cfg.compilerOptions?.paths ?? {})) {
        const key = k.replace(/\/\*$/, '');
        const target = v[0]?.replace(/\/\*$/, '');
        if (target) aliases[key] = join(baseUrl, target).replace(/^\.\//, '');
      }
    } catch {
      /* ignore unparsable tsconfig */
    }
  }
  return aliases;
}

export async function runDetect(project: Project) {
  project.setStage('detect', 'running');
  const profile = await detect(project);
  project.setMeta('profile', JSON.stringify(profile));
  project.log('info', `Detected: ${profile.frameworks.join(', ') || 'plain JS/TS'}; ${Object.entries(profile.languages).map(([k, v]) => `${v} .${k}`).join(', ')}`, 'detect');
  project.setStage('detect', 'done', { frameworks: profile.frameworks });
  return profile;
}

export function getProfile(project: Project): ProjectProfile | undefined {
  const raw = project.meta('profile');
  return raw ? JSON.parse(raw) : undefined;
}
