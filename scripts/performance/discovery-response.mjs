/** Validate the actual API envelopes; no synthetic content fallback is accepted. */
export function discoveryResponse(route, payload) {
  let books;
  if (route === "/api/fore/recommendations/home") {
    if (!Array.isArray(payload?.rails)) return { valid: false, products: [] };
    books = payload.rails.flatMap((rail) => (Array.isArray(rail.books) ? rail.books : []));
  } else if (route === "/api/fore/storefront/bootstrap") {
    if (!Array.isArray(payload?.catalog?.results)) return { valid: false, products: [] };
    books = payload.catalog.results;
  } else if (route === "/api/fore/merchandising") {
    const slots = payload?.slots;
    const valid =
      !!slots &&
      typeof slots === "object" &&
      !Array.isArray(slots) &&
      Object.values(slots).every(Array.isArray);
    books = valid
      ? Object.values(slots)
          .flat()
          .flatMap((placement) => (Array.isArray(placement.books) ? placement.books : []))
      : [];
    return {
      valid: valid && books.every((book) => typeof book.productId === "string" && !!book.productId),
      products: books.map((book) => book.productId),
    };
  } else return { valid: false, products: [] };
  return {
    valid:
      books.length > 0 &&
      books.every((book) => typeof book.productId === "string" && !!book.productId),
    products: books.map((book) => book.productId),
  };
}
