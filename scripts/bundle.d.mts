export const projectRoot: string;
export const distPath: string;
export const pkg: { version: string; gettyBun?: { contractVersion: number; bunVersion: string } };
export function bundle(): Promise<Uint8Array>;
export function build(outfile: string): Promise<void>;
export function buildTo(outfile: string): void;
