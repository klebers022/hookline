import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { ApiError } from './api/client';
import { SessionProvider, useSession } from './auth';
import { DeliveryDetail } from './pages/DeliveryDetail';
import { Endpoints } from './pages/Endpoints';
import { EventDetail } from './pages/EventDetail';
import { Events } from './pages/Events';
import { Failed } from './pages/Failed';
import { SignIn } from './pages/SignIn';

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </SessionProvider>
  );
}

function Shell() {
  const { client } = useSession();
  // A new cache per session, so nothing from one project's key shows up
  // under another's.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx will not change by asking again.
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
          },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );

  if (!client) {
    return <SignIn />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/events" replace />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/:id" element={<EventDetail />} />
          <Route path="/deliveries/:id" element={<DeliveryDetail />} />
          <Route path="/failed" element={<Failed />} />
          <Route path="/endpoints" element={<Endpoints />} />
          <Route path="*" element={<Navigate to="/events" replace />} />
        </Routes>
      </Layout>
    </QueryClientProvider>
  );
}

const NAV = [
  { to: '/events', label: 'Events' },
  { to: '/failed', label: 'Failed' },
  { to: '/endpoints', label: 'Endpoints' },
];

function Layout({ children }: { children: React.ReactNode }) {
  const { signOut } = useSession();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3">
          <span className="mr-4 font-semibold text-slate-900">Hookline</span>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={signOut}
            className="ml-auto text-sm text-slate-600 hover:text-slate-900"
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
