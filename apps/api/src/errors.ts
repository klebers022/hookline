export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
  }
}

export function notFound(resource: string): ProblemError {
  return new ProblemError(404, 'Not Found', `${resource} not found`);
}
