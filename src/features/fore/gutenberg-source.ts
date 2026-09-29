// The official mirror list includes gutenberg.pglaf.org. A private rsync mirror
// can replace it using the same main/generated collection directory layout.
export function mirrorUrl(source: string, base = "https://gutenberg.pglaf.org") {
  const u = new URL(source),
    mirror = new URL(base);
  if (
    u.protocol !== "https:" ||
    !["www.gutenberg.org", "gutenberg.org"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("Unsupported Gutenberg source.");
  if (mirror.protocol !== "https:" || mirror.username || mirror.password)
    throw Error("A secure mirror URL is required.");
  let path = u.pathname;
  const generated=path.match(/^\/ebooks\/(\d+)\.(epub3?)(?:\.(noimages|images))?$/);
  if(generated)path=`/cache/epub/${generated[1]}/pg${generated[1]}.${generated[2]}${generated[3]==='images'?'-images':''}`;
  const files = path.match(/^\/(?:files|ebooks)\/(\d+)\/(.*)$/);
  if (files) {
    const id = files[1];
    const directory = id.length === 1 ? "0" : id.slice(0, -1).split("").join("/");
    path = `/${directory}/${id}/${files[2]}`;
  }
  path = path.replace(/^\/cache\/generated\//, "/cache/epub/").replace(/^\/dirs\//, "/");
  return mirror.href.replace(/\/$/, "") + path;
}
