import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        // electron-vite bundles JS only; the splash markup has to be copied.
        name: 'copy-splash',
        closeBundle(): void {
          mkdirSync(resolve(__dirname, 'out/main'), { recursive: true })
          copyFileSync(
            resolve(__dirname, 'src/main/splash.html'),
            resolve(__dirname, 'out/main/splash.html')
          )
        }
      }
    ]
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    },
    plugins: [react()]
  }
})
