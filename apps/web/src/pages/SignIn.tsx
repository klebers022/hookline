import { useState, type FormEvent } from 'react';
import { createClient } from '../api/client';
import { useSession } from '../auth';
import { Mark } from '../components/Mark';
import { Button, ErrorMessage, Field, monoInputClass } from '../components/ui';

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
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-[400px] space-y-5 rounded-[10px] border border-rule bg-surface p-7"
      >
        <span className="flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.02em]">
          <Mark />
          Hookline
        </span>
        <div>
          <h1>Open your project</h1>
          <p className="mt-2 text-ink-2">
            Paste the API key that{' '}
            <code className="font-mono text-[13px]">create-project</code>{' '}
            printed.
          </p>
        </div>
        {expired && error === null && (
          <ErrorMessage error={new Error('The API rejected the key.')} />
        )}
        <Field label="API key">
          <input
            type="password"
            autoComplete="off"
            required
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="hk_…"
            className={monoInputClass}
          />
        </Field>
        {error !== null && <ErrorMessage error={error} />}
        <Button
          type="submit"
          variant="primary"
          disabled={checking}
          className="w-full py-3"
        >
          {checking ? 'Checking…' : 'Sign in'}
        </Button>
        <p className="text-[13px] text-ink-3">
          The key stays in this tab’s memory only. Reloading the page forgets
          it.
        </p>
      </form>
    </main>
  );
}
