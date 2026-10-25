import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/global.css';
import '../classroom/classroom.css';
import './teach.css';
import { Console } from './Console';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Console />
  </StrictMode>,
);
