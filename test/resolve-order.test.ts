// The order of what a sync reports about its sources (k165): it resolves them in parallel,
// and what each resolve ends in – a failure, a fall back to the cache – used to be reported
// as it completed, so two such sources swapped places in the report from run to run. Mocked
// downloads that complete in a forced order, temp dirs.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";
import { makeTarGz } from "./helpers/tar.ts";
import { resolveItems, sync, type EngineContext } from "../src/engine.ts";

const URLS = { a: "https://a.example.invalid/skills.tar.gz", b: "https://b.example.invalid/skills.tar.gz" };

function setup(t: TestContext) {
  const tmp = makeTmpDir();
  t.after(tmp.cleanup);
  const home = join(tmp.dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Declared a before b, in the sources and in the entries that need them.
  writeFileSync(join(home, ".claude/skilletor.json"), JSON.stringify({
    targets: ["claude"],
    sources: { a: { url: URLS.a }, b: { url: URLS.b } },
    install: { skills: ["sa@a", "sb@b"] },
  }));
  const ctx: EngineContext = {
    home, stateRoot: join(tmp.dir, "state"), codexHome: join(tmp.dir, "codex"), markers: { claude: [], codex: [] },
    isGitWorkTree: () => false, timeoutMs: 5_000,
  };
  return ctx;
}

/** Serve each URL a tarball with skill `s<name>`. */
function serveArchives(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (...[input]: Parameters<typeof fetch>) => {
    const name = Object.entries(URLS).find(([, u]) => u === String(input))![0];
    const body = makeTarGz([{ name: `pkg/skills/s${name}/SKILL.md`, data: `---\ndescription: s${name}\n---\n` }]);
    return new Response(new Uint8Array(body), { headers: { etag: `"${name}1"` } });
  });
}

/**
 * Fail every download, in `order`: none is answered before both have been asked for – the
 * resolves run in parallel, else the first times out (`timeoutMs`) as never answered – then
 * one at a time, the next only once the engine has taken the one before to its end (all of
 * that runs on microtasks, done before the next macrotask).
 */
function failInOrder(t: TestContext, order: (keyof typeof URLS)[]) {
  const waiting = new Map<string, (err: Error) => void>();
  const release = async () => {
    for (const name of order) {
      waiting.get(URLS[name])!(new Error(`offline ${name}`));
      await new Promise((res) => setImmediate(res));
    }
  };
  t.mock.method(globalThis, "fetch", (...[input, init]: Parameters<typeof fetch>) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new Error("never answered: the downloads did not run in parallel")));
    waiting.set(String(input), rej);
    if (waiting.size === order.length) void release();
  }));
}

// Asserts: two sources whose resolves fail are reported in their declaration order (a, b),
// whichever resolve completes first – the order a resolve of one source after the other
// gives. The resolve-only run lists the sources it needed in that order too.
for (const order of [["a", "b"], ["b", "a"]] as const) {
  test(`k165: two failing sources are reported in declaration order (${order.join(" completes before ")})`, async (t) => {
    const ctx = setup(t);
    failInOrder(t, [...order]);
    const report = await sync(ctx, { scope: "user" });
    assert.equal(report.error, undefined);
    assert.deepEqual(report.scopes[0]!.warnings, [
      `source a: url source ${URLS.a} failed: offline a`,
      `source b: url source ${URLS.b} failed: offline b`,
    ]);

    failInOrder(t, [...order]);
    const resolved = await resolveItems(ctx, { scope: "user" });
    assert.deepEqual(resolved.scopes[0]!.warnings, report.scopes[0]!.warnings);
    assert.deepEqual(resolved.scopes[0]!.sources.map((s) => [s.name, s.state]), [["a", "failed"], ["b", "failed"]]);
  });
}

// Asserts: two sources that fall back to their caches (a download fails after a sync that
// filled them) are named in their declaration order, whichever resolve completes first.
for (const order of [["a", "b"], ["b", "a"]] as const) {
  test(`k165: two sources served from their caches are reported in declaration order (${order.join(" completes before ")})`, async (t) => {
    const ctx = setup(t);
    serveArchives(t);
    const first = await sync(ctx, { scope: "user" });
    assert.equal(first.error, undefined);
    assert.deepEqual(first.scopes[0]!.warnings, []);
    assert.deepEqual(first.scopes[0]!.added.map((i) => i.key).sort(), ["skills/sa", "skills/sb"]);

    failInOrder(t, [...order]);
    const report = await sync(ctx, { scope: "user" });
    assert.equal(report.error, undefined);
    assert.deepEqual(report.scopes[0]!.warnings, [
      `download failed for ${URLS.a}, using cache (offline a)`,
      `download failed for ${URLS.b}, using cache (offline b)`,
    ]);
  });
}
