import type { BuildOptions } from "esbuild";

export const entryPoint: string;
export const distPath: string;
export const buildOptions: BuildOptions;
export function build(outfile: string): Promise<void>;
export function buildToString(): Promise<string>;
