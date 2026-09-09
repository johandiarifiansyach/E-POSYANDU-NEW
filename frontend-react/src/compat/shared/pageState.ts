export type PageState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string };

export function pageIdle<T>(): PageState<T> {
  return { status: 'idle' };
}

export function pageLoading<T>(): PageState<T> {
  return { status: 'loading' };
}

export function pageSuccess<T>(data: T): PageState<T> {
  return { status: 'success', data };
}

export function pageError<T>(message: string): PageState<T> {
  return { status: 'error', message };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
