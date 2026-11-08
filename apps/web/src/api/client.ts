// The API's errors are application/problem+json; detail says what went wrong.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const problem = (await response.json()) as {
      title?: string;
      detail?: string;
    };
    return new ApiError(
      response.status,
      problem.title ?? response.statusText,
      problem.detail,
    );
  } catch {
    return new ApiError(response.status, response.statusText);
  }
}

// Paths are relative to the dashboard's own origin, which forwards /v1 to
// the API. A 401 means the key stopped working (revoked, or the database
// was reset), so the dashboard forgets it and asks again.
export function createClient(
  apiKey: string,
  onUnauthorized: () => void = () => {},
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetchImpl(path, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized();
      }
      throw await toError(response);
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
  };
}
