// Minimal tar.gz builder for tests — lets us craft arbitrary (incl. malicious)
// entries without depending on the system tar.
import { gzipSync } from "node:zlib";

export interface TarInput {
  name: string;
  /** '0' file, '5' dir, '2' symlink, '1' hardlink. */
  typeflag?: string;
  data?: string;
  linkname?: string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function header(entry: TarInput, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(entry.name, 0, 100, "utf8");
  h.write("0000644\0", 100, "ascii"); // mode
  h.write("0000000\0", 108, "ascii"); // uid
  h.write("0000000\0", 116, "ascii"); // gid
  h.write(octal(size, 12), 124, "ascii"); // size
  h.write("00000000000\0", 136, "ascii"); // mtime
  h.write("        ", 148, "ascii"); // checksum placeholder (spaces)
  h.write(entry.typeflag ?? "0", 156, "ascii");
  if (entry.linkname) h.write(entry.linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  // checksum
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** Build a gzipped tar from the given entries. */
export function makeTarGz(entries: TarInput[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "", "utf8");
    blocks.push(header(e, data.length));
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks
  return gzipSync(Buffer.concat(blocks));
}
