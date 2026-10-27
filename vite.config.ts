import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// `npm run dev` proxies /api to the local Node server (npm start on :3000).
export default defineConfig({ plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:3000' } } });
