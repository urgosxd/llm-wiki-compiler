/**
 * @file src/utils/http-listen.ts
 * @description Bind an `http.Server` and settle once it is actually accepting.
 *
 * `server.listen()` reports the outcome through events, never through its return
 * value, so every caller ends up writing the same four-line dance: attach `error`,
 * attach `listening`, and remember to detach the other one or a late failure from a
 * previous bind resolves the wrong promise. Two servers in this codebase had that
 * block copied verbatim; this is the single home for it.
 *
 * The subtlety worth keeping in one place: `port: 0` is a REQUEST for an OS-assigned
 * port, not a port. Callers must read `server.address()` after this resolves when
 * they need the real number — and anything that validates the incoming `Host`
 * header (the viewer does) must be configured with that resolved value, not the
 * requested one.
 */
import type { Server } from "node:http";

/**
 * Wait for a server to bind.
 *
 * @param server - Server to bind; the caller keeps ownership of it.
 * @param port - Port to listen on; `0` asks the OS for a free one.
 * @param host - Address to bind.
 * @returns A promise that rejects with the bind error, or resolves once listening.
 */
export function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
