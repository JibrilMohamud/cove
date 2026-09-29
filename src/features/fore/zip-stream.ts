// ZIP32, STORE, streaming data descriptors. No whole-audiobook buffers on browsers
// with File System Access. Other browsers are capped before memory grows unbounded.
import { downloadBlob } from "./client";
export type ZipEntry = { name: string; open: () => Promise<Response | Blob> };
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function header(size: number) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (at: number, v: number) => view.setUint16(at, v, true),
    u32: (at: number, v: number) => view.setUint32(at, v >>> 0, true),
  };
}
export async function downloadZip(
  entries: ZipEntry[],
  name: string,
  signal: AbortSignal,
  onProgress: (text: string) => void,
) {
  let file: any = null;
  if ("showSaveFilePicker" in window) {
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: name,
      types: [{ description: "Cove book package", accept: { "application/zip": [".zip"] } }],
    });
    file = await handle.createWritable();
  }
  let offset = 0;
  const buffers: Uint8Array[] = [];
  const central: { name: Uint8Array; offset: number; size: number; crc: number }[] = [];
  async function write(chunk: Uint8Array) {
    if (signal.aborted) throw new DOMException("Download canceled", "AbortError");
    offset += chunk.length;
    if (offset > 0xffffffff)
      throw Error("This package exceeds the 4 GB ZIP limit. Download individual tracks.");
    if (file) await file.write(chunk);
    else {
      if (offset > 192 * 1024 * 1024)
        throw Error(
          "This recording is too large for a ZIP in this browser. Use Chrome or Edge with file saving, or save the tracks for offline listening.",
        );
      buffers.push(chunk);
    }
  }
  try {
    for (const entry of entries) {
      onProgress(entry.name);
      const nameBytes = new TextEncoder().encode(entry.name);
      const start = offset,
        h = header(30);
      h.u32(0, 0x04034b50);
      h.u16(4, 20);
      h.u16(6, 0x0808);
      h.u16(26, nameBytes.length);
      await write(h.bytes);
      await write(nameBytes);
      const value = await entry.open();
      if (value instanceof Response && !value.ok) {
        const d = await value.json().catch(() => ({}));
        throw Error(d.error || "A package file could not be downloaded.");
      }
      const stream = value instanceof Blob ? value.stream() : value.body;
      if (!stream) throw Error("A package file is empty.");
      const reader = stream.getReader();
      let size = 0,
        crc = 0xffffffff;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          for (let i = 0; i < chunk.length; i++) crc = table[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
          size += chunk.length;
          await write(chunk);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const d = header(16);
      d.u32(0, 0x08074b50);
      d.u32(4, crc);
      d.u32(8, size);
      d.u32(12, size);
      await write(d.bytes);
      central.push({ name: nameBytes, offset: start, size, crc });
    }
    const centralOffset = offset;
    for (const e of central) {
      const h = header(46);
      h.u32(0, 0x02014b50);
      h.u16(4, 20);
      h.u16(6, 20);
      h.u16(8, 0x0808);
      h.u32(16, e.crc);
      h.u32(20, e.size);
      h.u32(24, e.size);
      h.u16(28, e.name.length);
      h.u32(42, e.offset);
      await write(h.bytes);
      await write(e.name);
    }
    const size = offset - centralOffset,
      end = header(22);
    end.u32(0, 0x06054b50);
    end.u16(8, central.length);
    end.u16(10, central.length);
    end.u32(12, size);
    end.u32(16, centralOffset);
    await write(end.bytes);
    if (file) await file.close();
    else downloadBlob(new Blob(buffers as BlobPart[], { type: "application/zip" }), name);
  } catch (error) {
    if (file) await file.abort().catch(() => {});
    throw error;
  }
}
