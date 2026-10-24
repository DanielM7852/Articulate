/**
 * Mock account for the demo. Checked in the browser only; nothing is sent anywhere.
 * Replace with real auth when the backend is ready.
 */
export const MOCK_ACCOUNT = {
  email: 'demo@articulate.app',
  password: 'articulate',
  name: 'Learner',
} as const;

export function checkMockCredentials(email: string, password: string) {
  return email.trim().toLowerCase() === MOCK_ACCOUNT.email && password === MOCK_ACCOUNT.password;
}
