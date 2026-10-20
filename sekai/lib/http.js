// Fetch helpers. Every one takes an optional transport (lib/transport.js).

import { BROWSER_UA, createTransport } from "./transport.js";

export { BROWSER_UA };

export const defaultTransport = createTransport();

export class HttpError extends Error {
  constructor(message, { status = 0, url = "", body = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function request(
  url,
  { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, transport = defaultTransport, ...rest } = {},
) {
  try {
    return await transport.request(url, { headers, timeoutMs, ...rest });
  } catch (err) {
    throw new HttpError(`request failed: ${err.message}`, { url: String(url) });
  }
}

export async function fetchText(url, { transport = defaultTransport, ...options } = {}) {
  const response = await request(url, { transport, ...options });
  const body = await response.text();
  if (!response.ok) throw new HttpError(`HTTP ${response.status}`, { status: response.status, url, body });
  return body;
}

export async function fetchJson(url, { transport = defaultTransport, ...options } = {}) {
  const response = await request(url, { transport, ...options });
  const body = await response.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* reported below */
  }
  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status}`, { status: response.status, url, body: body.slice(0, 300) });
  }
  if (json === null) {
    throw new HttpError("invalid JSON response", { status: response.status, url, body: body.slice(0, 300) });
  }
  return json;
}
