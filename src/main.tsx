import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './editor/App.tsx';
import { bootstrap } from './editor/bootstrap.ts';
import './editor/styles.css';

const rootEl = document.getElementById('root')!;

bootstrap()
  .then(({ services, setController }) => {
    createRoot(rootEl).render(
      <StrictMode>
        <App services={services} setController={setController} />
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    rootEl.innerHTML = '';
    const p = document.createElement('pre');
    p.className = 'fatal';
    p.textContent = `Circuit Foundry could not start:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    rootEl.appendChild(p);
  });
