import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createClient, type ApiClient } from './api/client';

interface Session {
  client: ApiClient | null;
  // Set when the API rejected the key, so the sign-in screen can say why.
  expired: boolean;
  signIn(apiKey: string): void;
  signOut(): void;
}

const SessionContext = createContext<Session | null>(null);

// The API key lives only in this component's state: not in localStorage,
// sessionStorage or a cookie. Reloading the page forgets it (ADR 11).
export function SessionProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const signOut = useCallback(() => setApiKey(null), []);
  const signIn = useCallback((key: string) => {
    setExpired(false);
    setApiKey(key);
  }, []);

  const client = useMemo(
    () =>
      apiKey
        ? createClient(apiKey, () => {
            setExpired(true);
            setApiKey(null);
          })
        : null,
    [apiKey],
  );

  const session = useMemo(
    () => ({ client, expired, signIn, signOut }),
    [client, expired, signIn, signOut],
  );
  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession outside SessionProvider');
  }
  return session;
}

// For the screens behind the sign-in, where a client always exists.
export function useApi(): ApiClient {
  const { client } = useSession();
  if (!client) {
    throw new Error('useApi without a signed-in session');
  }
  return client;
}
