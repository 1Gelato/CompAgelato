import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHttpApi } from './lib/httpApi';
import './styles/global.css';

// Sans pont Electron (page servie par le serveur CompaGelato), le même
// `window.api` est construit au-dessus de HTTP : les écrans ne changent pas.
if (!window.api) {
  window.api = createHttpApi();
}

const container = document.getElementById('root');
if (!container) throw new Error('Élément racine introuvable.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
