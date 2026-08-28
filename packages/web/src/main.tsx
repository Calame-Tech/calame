import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { SessionProvider } from './context/SessionContext.js';
import { BrandingProvider } from './lib/branding.js';
import { I18nProvider } from './i18n/I18nProvider.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrandingProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrandingProvider>
    </I18nProvider>
  </React.StrictMode>,
);
