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
        version: '0.0.38',
        updateURL: 'https://raw.githubusercontent.com/gsjz/linkualog/main/browser-plugin/user/linkualog.user.js',
        downloadURL: 'https://raw.githubusercontent.com/gsjz/linkualog/main/browser-plugin/user/linkualog.user.js',
        author: 'Sergio Gao',
        icon: 'https://vitejs.dev/logo.svg',
        namespace: 'npm/vite-plugin-monkey',
        match: [
          '*://*/*',
        ],
        exclude: [
          '*://gemini.google.com/*',
          '*://*.gemini.google.com/*',
          '*://bard.google.com/*',
          '*://*.bard.google.com/*',
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
