import { useState, type FormEvent } from 'react';
import { createClient } from '../api/client';
import { useSession } from '../auth';
import { Button, ErrorMessage, inputClass } from '../components/ui';

export function SignIn() {
  const { signIn, expired } = useSession();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  // The cheapest authenticated request tells whether the key works.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    setChecking(true);
    setError(null);
    try {
      await createClient(key).get('/v1/endpoints?limit=1');
      signIn(key);
    } catch (caught) {
      setError(caught);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Hookline</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sign in with your project’s API key.
          </p>
        </div>
        {expired && error === null && (
          <ErrorMessage error={new Error('The API rejected the key.')} />
        )}
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">API key</span>
          <input
            type="password"
            autoComplete="off"
            required
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="hk_…"
            className={inputClass}
          />
        </label>
        <p className="text-xs text-slate-500">
          The key stays in this tab’s memory only. Reloading the page forgets
          it.
        </p>
        {error !== null && <ErrorMessage error={error} />}
        <Button
          type="submit"
          variant="primary"
          disabled={checking}
          className="w-full"
        >
          {checking ? 'Checking…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
