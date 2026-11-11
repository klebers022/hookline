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
    <main className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center px-4 py-10 sm:px-10">
        <form onSubmit={submit} className="w-full max-w-[400px] space-y-5">
          <span className="flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.02em]">
            <Mark />
            Hookline
          </span>
          <div className="pt-6">
            <h1 className="text-[34px]">Open your project</h1>
            <p className="mt-2.5 text-ink-2">
              Paste the API key that{' '}
              <code className="font-mono text-[13px]">create-project</code>{' '}
              printed. You will see every event you published and what each
              endpoint answered.
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
      </div>
      <div
        aria-hidden="true"
        className="hidden items-center justify-center bg-[#18203a] p-12 text-[#e6e9f2] lg:flex dark:bg-[#151b2e]"
      >
        <FanOut />
      </div>
    </main>
  );
}

// One event leaving for three endpoints, each at a different point of its
// route: the product in one picture. Colours are fixed because the panel is
// dark in both themes.
function FanOut() {
  return (
    <svg
      viewBox="0 0 460 300"
      fill="none"
      className="h-auto w-full max-w-[460px]"
    >
      <g fontFamily="'JetBrains Mono Variable', monospace" fontSize="12">
        <rect
          x="10"
          y="126"
          width="120"
          height="48"
          rx="8"
          stroke="currentColor"
          strokeOpacity=".5"
        />
        <text x="26" y="155" fill="currentColor">
          order.paid
        </text>
        <path
          d="M130 150 C 200 150 200 60 270 60"
          stroke="#3fc79a"
          strokeWidth="2.5"
        />
        <path
          d="M130 150 H 270"
          stroke="#e8a93b"
          strokeWidth="2.5"
          strokeDasharray="6 6"
        />
        <path
          d="M130 150 C 200 150 200 240 270 240"
          stroke="#f0675c"
          strokeWidth="2.5"
        />
        <circle cx="270" cy="60" r="7" fill="#3fc79a" />
        <text x="288" y="56" fill="currentColor">
          shop.example
        </text>
        <text x="288" y="74" fill="#3fc79a">
          200 on the 1st try
        </text>
        <circle cx="270" cy="150" r="7" stroke="#e8a93b" strokeWidth="2.5" />
        <text x="288" y="146" fill="currentColor">
          erp.acme.io
        </text>
        <text x="288" y="164" fill="#e8a93b">
          next try in 28 min
        </text>
        <circle cx="270" cy="240" r="7" fill="#f0675c" />
        <text x="288" y="236" fill="currentColor">
          crm.example
        </text>
        <text x="288" y="254" fill="#f0675c">
          gave up after 6 tries
        </text>
      </g>
    </svg>
  );
}
