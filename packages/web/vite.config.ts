import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'node:path'

export default defineConfig(() => {
  const gatewayPort = process.env.GATEWAY_PORT ?? '7777'
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      outDir: 'out',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${gatewayPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://127.0.0.1:${gatewayPort}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  }
})
