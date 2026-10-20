import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { StoreProvider } from './lib/store';
import { DownloadsProvider } from './lib/downloads';
import { App } from './App';
import './globals.css';
import './player.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <DownloadsProvider>
          <App />
        </DownloadsProvider>
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>
);
