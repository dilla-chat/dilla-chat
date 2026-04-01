export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout = 15000, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...fetchInit, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
