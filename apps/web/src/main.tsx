import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { galleryEnabled } from './app/gallery.ts';
import { StartupError } from './app/StartupError.tsx';
import { loadRuntimeConfig, setRuntimeConfig } from './config/runtime.ts';
import './ui/tokens.css';
import './ui/base.css';

async function boot(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('#root is missing from index.html');
  const root = createRoot(container);

  // The gallery renders fixtures only, and no server needs to exist for it.
  const galleryOnly = galleryEnabled && window.location.pathname.startsWith('/dev/gallery');
  if (!galleryOnly) {
    try {
      setRuntimeConfig(
        await loadRuntimeConfig({ isDev: import.meta.env.DEV, location: window.location }),
      );
    } catch (err) {
      console.error(err);
      root.render(<StartupError />);
      return;
    }
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
