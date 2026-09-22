// Common interface for source backends (local, git, url). Each knows how to
// resolve to a local directory + version and to cheaply check for changes.
// `sources/*` knows nothing about templating or the target filesystem.

export interface SourceLocation {
  /** Absolute path of the resolved source tree. */
  dir: string;
  /** Opaque version marker: "local", "git:<sha>", or "url:<etag>". */
  version: string;
}

export interface Source {
  /** Fetch/prepare the source and report where it landed and its version. */
  resolve(): Promise<SourceLocation>;
  /** Cheap check: has the source changed since `cachedVersion`? */
  check(cachedVersion: string | undefined): Promise<boolean>;
}
