export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function request(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Quiz-Request': '1',
      'X-Dev-User': localStorage.getItem('classroom-demo-user') || 'professor',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  })
  if (!response.ok) {
    const message = response.headers.get('content-type')?.includes('application/json')
      ? (await response.json()).message : 'Sign-in or server request failed. Sign in again or retry.'
    throw new ApiError(response.status, message || `Request failed (${response.status}).`)
  }
  return response
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  return (await request(path, body)).json()
}

export async function apiText(path: string): Promise<string> {
  return (await request(path)).text()
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please retry.'
}
