import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { SessionProvider } from './context/SessionContext.js';
import { BrandingProvider } from './lib/branding.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrandingProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrandingProvider>
  </React.StrictMode>,
);
