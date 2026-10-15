/** Trusted public verification keys for seven-day Cove EPUB licenses.
 * The private signing key is stored only in the authoritative Cloudflare Worker.
 * Never accept a verifier supplied by a cached book, license, or browser storage.
 * Rotate by shipping both public keys during a controlled overlap window.
 */
export const TRUSTED_OFFLINE_EPUB_PUBLIC_KEYS: readonly JsonWebKey[] = [
  {
    kty: "EC",
    crv: "P-256",
    x: "yDvSYvqHElF6Ev5OQv0CtdBm41s4k-17tlHVK0zyjio",
    y: "Cm3jS3oYhg3Pz7SYKRKeT4Mw9nvDBXS3HS6YGDUWzwY",
  },
];
