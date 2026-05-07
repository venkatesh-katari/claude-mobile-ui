import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = process.env.PORT || 3456;
const certPath = process.env.CERT_PATH;
const keyPath = process.env.KEY_PATH;

const useHttps = certPath && keyPath;
const backendProto = useHttps ? 'https' : 'http';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `${backendProto}://localhost:${serverPort}`,
        // When backend is HTTPS with a local mkcert cert, we must disable strict SSL
        // verification in the dev proxy (the cert is trusted on-device but not by Node)
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
