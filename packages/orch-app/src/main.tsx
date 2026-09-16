import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
// The shared palette, before index.css so the app's own tokens layer on top.
// Imported here rather than via `@import` inside index.css: Vite resolves bare
// package specifiers in CSS with a separate resolver that does not read the
// package's exports map, and fails with `Missing "./theme.css" specifier`.
import '@wadeck-app/dsl-ui/theme.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
