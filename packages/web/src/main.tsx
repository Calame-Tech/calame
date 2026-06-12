import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { BrandingProvider } from './lib/branding.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrandingProvider>
      <App />
    </BrandingProvider>
  </React.StrictMode>,
);
