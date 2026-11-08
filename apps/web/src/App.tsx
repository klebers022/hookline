import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router';
import { ApiError } from './api/client';
import { SessionProvider, useSession } from './auth';
import { Mark } from './components/Mark';
import { Button } from './components/ui';
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
  const { keyPrefix, signOut } = useSession();
  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-7 gap-y-1 px-4 pt-3 sm:h-[60px] sm:flex-nowrap sm:px-6 sm:pt-0">
          <span className="flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.02em]">
            <Mark />
            Hookline
          </span>
          <nav
            aria-label="Main"
            className="order-3 -ml-3 flex h-11 w-full gap-1 overflow-x-auto sm:order-none sm:ml-0 sm:h-full sm:w-auto"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `-mb-px flex items-center border-b-2 px-3 font-medium ${
                    isActive
                      ? 'border-stamp text-ink'
                      : 'border-transparent text-ink-2 hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            {keyPrefix && (
              <span
                className="hidden items-center gap-2 text-ink-2 sm:inline-flex"
                title="The key this tab is signed in with"
              >
                <span className="size-2 rounded-full bg-ok" />
                <span className="font-mono text-[13px]">{keyPrefix}_…</span>
              </span>
            )}
            <Button variant="quiet" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1120px] px-4 pt-6 pb-16 sm:px-6 sm:pt-8">
        {children}
      </main>
    </div>
  );
}
