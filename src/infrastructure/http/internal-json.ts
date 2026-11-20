import { ProblemException, type InternalHttpClient } from '@cadenway/nest-common';

type JsonResponse = Readonly<{ status: number; headers: Headers; data: unknown }>;

/** Binds generated relative paths to the signed transport for their service. */
export function bindInternalFetch(http: InternalHttpClient): typeof fetch {
  return (path, options) => {
    if (typeof path !== 'string') throw new Error('An internal route must provide a path.');
    return http.fetch(path, options);
  };
}

/** Consumes an expected success or concealed 404 without retaining upstream data in errors. */
export async function readInternalJson(
  request: Promise<JsonResponse>,
  unavailable: string,
): Promise<JsonResponse | null> {
  try {
    const response = await request;
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (response.status === 200 && mediaType === 'application/json') return response;
  } catch (error) {
    if (error instanceof ProblemException && error.getStatus() === 404) return null;
  }
  throw new Error(unavailable);
}
