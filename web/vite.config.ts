import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { otoolsTauriShimPlugin } from 'otools-plugin-sdk/vite'

export default defineConfig({
  base: './',
  // The copied SDK types use Vite 7, but this alias-only plugin is runtime
  // compatible with the existing host's Vite 6 toolchain (characterized in API tests).
  plugins: [vue(), UnoCSS(), otoolsTauriShimPlugin() as unknown as Plugin],
  define: { __OTOOLS_PLUGIN_UUID__: JSON.stringify('otools-clipboard') },
  server: { host: '127.0.0.1', port: 6549, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
})
