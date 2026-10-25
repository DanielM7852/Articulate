import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles/global.css';
import { AppStateProvider, useAppState } from './state/AppState';
import Intro from './screens/Intro';
import Quiz from './screens/Quiz';
import Tutorial from './screens/Tutorial';
import PracticeStudio from './screens/PracticeStudio';
import OnYourOwn from './screens/OnYourOwn';
import WordLesson from './screens/WordLesson';
import Dashboard from './screens/Dashboard';
import ConsonantCoach from './screens/ConsonantCoach';
import RecapScreen from './screens/RecapScreen';

/**
 * Flow: the guide greets the learner, then the quiz, then a tutorial where the
 * guide explains the graph, then practice. Progress is session-only, so a reload
 * returns to the step the learner has reached.
 */
function Guard({ need, children }: { need: 'quiz' | 'tutorial'; children: ReactNode }) {
  const { quizDone, onboarded } = useAppState();
  if (!quizDone) return <Navigate to="/" replace />;
  if (need === 'tutorial' && !onboarded) return <Navigate to="/tutorial" replace />;
  return children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Intro />} />
          <Route path="/quiz/:step" element={<Quiz />} />
          <Route path="/quiz" element={<Navigate to="/quiz/1" replace />} />
          <Route path="/tutorial" element={<Guard need="quiz"><Tutorial /></Guard>} />
          <Route path="/lesson" element={<Guard need="quiz"><WordLesson /></Guard>} />
          <Route path="/practice" element={<Guard need="tutorial"><PracticeStudio /></Guard>} />
          <Route path="/own" element={<Guard need="tutorial"><OnYourOwn /></Guard>} />
          <Route path="/consonants" element={<ConsonantCoach />} />
          <Route path="/recap/:recapId" element={<RecapScreen />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/summary" element={<Navigate to="/own" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppStateProvider>
  </StrictMode>,
);
