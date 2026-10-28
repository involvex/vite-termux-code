import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'

export default defineConfig({
	plugins: [react()],
	define: {
		global: 'globalThis',
	},
	server: {
		port: 4444,
		host: '0.0.0.0',
		allowedHosts: true,
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:4445',
				changeOrigin: true,
			},
			'/ws': {
				target: 'ws://127.0.0.1:4445',
				ws: true,
				changeOrigin: true,
			},
			'/term': {
				target: 'ws://127.0.0.1:4445',
				ws: true,
				changeOrigin: true,
			},
		},
	},
	preview: {
		port: 4444,
		host: '0.0.0.0',
	},
})
