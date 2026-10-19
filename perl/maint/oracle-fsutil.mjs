// Regenerates t/data/fsutil-oracle.json: Node's path.posix functions, the reference's
// innerSegments and readFileSync's lossy UTF-8 decoding. Run from perl/:
//   node maint/oracle-fsutil.mjs > t/data/fsutil-oracle.json
import { posix } from "node:path";
import { innerSegments } from "../../src/fsutil.ts";

const paths = [
  "", ".", "./", "..", "../", "a", "a/", "a/b", "a//b", "a/./b", "a/../b", "a/..", "a/../", "../a/..", "../../x",
  "/", "//", "//a", "/a/b/", "/a/../..", "/a/./b/../../c/", "a/b/../../..", "./a", "x/.../y", "/../a",
];
const joins = [["/c", "abc"], ["/c/", "x"], ["/c", "a/../b"], ["a", ""], ["", ""], ["/a", "/b"], ["a", "../.."], ["/a//b/", "./c/"]];
const resolves = [["/a", "b"], ["/a", "/b", "c"], ["/a/b", ".."], ["/a/", "x/", "./"], ["/", ".."], ["/a", "b/../../.."]];
const inner = ["a", "a/b", "a\\b", "./a", "a/./b", "", ".", "./", "/a", "\\a", "a/../b", "..", "a/..", "a//b/", "C:/x"];
const bytes = [
  "41", "c3a9", "e282ac", "f09f9880", "ff", "c3", "c328", "e282", "e28228", "f09f98", "eda080", "edbfbf",
  "c0af", "e080af", "f08f8f8f", "f4908080", "f5", "80", "bf41", "e0a080", "efbbbf7b7d", "fe41ff", "f09f",
  "41f09f9841", "c2c3a9", "e1808041",
];
const out = {
  normalize: paths.map((p) => ({ p, out: posix.normalize(p) })),
  join: joins.map((args) => ({ args, out: posix.join(...args) })),
  resolve: resolves.map((args) => ({ args, out: posix.resolve(...args) })),
  inner: inner.map((p) => ({ p, out: innerSegments(p) })),
  decode: bytes.map((hex) => ({ hex, out: Buffer.from(hex, "hex").toString("utf8") })),
};
console.log(JSON.stringify(out, null, 1));
