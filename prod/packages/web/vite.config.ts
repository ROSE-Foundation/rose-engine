import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the @rose/web SPA (operator surfaces, FR-14). The app is bundled by Vite; the
// root `vitest.config.ts` (jsdom) runs the component tests, so this config is exercised only by
// `pnpm dev` / `pnpm build` (not by the CI gate). The API base URL is read at runtime from
// `import.meta.env.VITE_API_BASE_URL` (no secret baked in here).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
