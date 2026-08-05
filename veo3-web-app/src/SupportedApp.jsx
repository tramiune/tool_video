import { lazy, Suspense } from 'react';

const App = lazy(() => import('./App.jsx'));

export default function SupportedApp() {
  return <Suspense fallback={null}><App /></Suspense>;
}
