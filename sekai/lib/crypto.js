// megaplay crypto: the AES-256-CBC sources payload and the HMAC CDN token.
//
// Keys are zero-padded literals taken from the player bundle. The token is
// base64url("<unix_expiry>|<path key>") + "." + base64url(hmac). WebCrypto only,
// so this module runs unchanged in Node >= 18 and in browsers.

export const CDN_TOKEN_TTL_SECONDS = 90;

const SOURCES_AES_KEY = "i?LMTAx0Q6,:}50U";
const SOURCES_AES_IV = "W0;27ToaUpl_P%'c";
const CDN_TOKEN_KEY = "MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let aesKeyPromise;
let hmacKeyPromise;

function subtle() {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.subtle) throw new Error("WebCrypto unavailable (browsers need https or localhost)");
  return webCrypto.subtle;
}

function toBytes(value) {
  return typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
}

function padBytes(value, length) {
  const source = toBytes(value);
  const out = new Uint8Array(length);
  out.set(source.subarray(0, Math.min(length, source.length)));
  return out;
}

function b64urlEncode(value) {
  const bytes = toBytes(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(value) {
  let text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const remainder = text.length % 4;
  if (remainder) text += "====".slice(remainder);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function aesKey() {
  aesKeyPromise ||= subtle().importKey("raw", padBytes(SOURCES_AES_KEY, 32), { name: "AES-CBC" }, false, ["decrypt"]);
  return aesKeyPromise;
}

function hmacKey() {
  hmacKeyPromise ||= subtle().importKey("raw", encoder.encode(CDN_TOKEN_KEY), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hmacKeyPromise;
}

/** Decrypt the `enc` field of a getSources response. */
export async function decryptSourcesPayload(enc) {
  const plain = await subtle().decrypt(
    { name: "AES-CBC", iv: padBytes(SOURCES_AES_IV, 16) },
    await aesKey(),
    b64urlDecode(enc),
  );
  const payload = JSON.parse(decoder.decode(plain));
  if (!payload || typeof payload.file !== "string") throw new Error("invalid enc payload");
  return payload;
}

/** The `<32hex>/<32hex>` path key of a signed CDN url, if present. */
export function extractPathKey(url) {
  const match = String(url).match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

async function signCdnToken(pathKey, ttlSeconds) {
  const message = `${Math.floor(Date.now() / 1000) + ttlSeconds}|${pathKey}`;
  const signature = await subtle().sign("HMAC", await hmacKey(), encoder.encode(message));
  return `${b64urlEncode(message)}.${b64urlEncode(signature)}`;
}

/** Append a fresh token when `url` matches the CDN pattern, else return it as-is. */
export async function attachCdnToken(url, { ttlSeconds = CDN_TOKEN_TTL_SECONDS } = {}) {
  const pathKey = extractPathKey(url);
  if (!pathKey) return url;
  const token = await signCdnToken(pathKey, ttlSeconds);
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    return `${url}${String(url).includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  }
}
