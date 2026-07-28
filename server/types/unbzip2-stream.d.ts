declare module "unbzip2-stream" {
  import type { Duplex } from "node:stream";
  export default function bz2(): Duplex;
}
