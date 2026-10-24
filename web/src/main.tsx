import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles/global.css';
import { AppStateProvider, useAppState } from './state/AppState';
import SignIn from './screens/SignIn';
import Welcome from './screens/Welcome';
import Quiz from './screens/Quiz';
import Setup from './screens/Setup';
import Plan from './screens/Plan';
import PracticeStudio from './screens/PracticeStudio';
import Summary from './screens/Summary';

/**
 * Flow guard: every screen past sign-in needs the mock login, and practice
 * screens need onboarding (welcome, quiz, setup, plan) finished this session.
 */
function Guard({ onboarding, children }: { onboarding?: boolean; children: ReactNode }) {
  const { learnerName, onboarded } = useAppState();
  if (!learnerName) return <Navigate to="/" replace />;
  if (onboarding && !onboarded) return <Navigate to="/welcome" replace />;
  return children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/welcome" element={<Guard><Welcome /></Guard>} />
          <Route path="/quiz/:step" element={<Guard><Quiz /></Guard>} />
          <Route path="/quiz" element={<Navigate to="/quiz/1" replace />} />
          <Route path="/setup" element={<Guard><Setup /></Guard>} />
          <Route path="/plan" element={<Guard><Plan /></Guard>} />
          <Route path="/practice" element={<Guard onboarding><PracticeStudio /></Guard>} />
          <Route path="/summary" element={<Guard onboarding><Summary /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppStateProvider>
  </StrictMode>,
);
