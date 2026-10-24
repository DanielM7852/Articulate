import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles/global.css';
import { AppStateProvider } from './state/AppState';
import SignIn from './screens/SignIn';
import Welcome from './screens/Welcome';
import Quiz from './screens/Quiz';
import Setup from './screens/Setup';
import Plan from './screens/Plan';
import PracticeStudio from './screens/PracticeStudio';
import Summary from './screens/Summary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/quiz/:step" element={<Quiz />} />
          <Route path="/quiz" element={<Navigate to="/quiz/1" replace />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/plan" element={<Plan />} />
          <Route path="/practice" element={<PracticeStudio />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppStateProvider>
  </StrictMode>,
);
