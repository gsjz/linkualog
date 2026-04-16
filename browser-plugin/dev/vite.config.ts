import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
  plugins: [
    react(),
    monkey({
      entry: 'src/apps/main.tsx',
      userscript: {
        name: 'Linkual Log',
        version: '0.0.5',
        author: 'Sergio Gao',
        icon: 'https://vitejs.dev/logo.svg',
        namespace: 'npm/vite-plugin-monkey',
        match: [
          '*://*.youtube.com/*',
          '*://youtube.com/*',
        ], 
        grant: [
          'GM_xmlhttpRequest', 
          'GM_getValue', 
          'GM_setValue',
          'unsafeWindow'
        ],
        connect: ['*']
      },
    }),
  ],
});
