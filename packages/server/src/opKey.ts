import type { OpEnvelope, OpKey, VersionVector } from "./types.js";

// Both Peritext and Comment ops carry their identity at `payload.opId =
// { counter, node }`. The server treats payloads as opaque except for
// reading this field for dedupe / VV computation.
export function keyOf(env: OpEnvelope): OpKey {
  const payload = env.payload as { opId?: { counter: number; node: string } };
  if (!payload?.opId || typeof payload.opId.counter !== "number") {
    throw new Error("op envelope missing opId");
  }
  return { counter: payload.opId.counter, node: payload.opId.node };
}

export function vvBump(vv: VersionVector, key: OpKey): VersionVector {
  const cur = vv[key.node] ?? 0;
  if (key.counter > cur) {
    return { ...vv, [key.node]: key.counter };
  }
  return vv;
}

/** True if `vv` already contains `key` (so we should drop the op). */
export function vvHas(vv: VersionVector, key: OpKey): boolean {
  return (vv[key.node] ?? 0) >= key.counter;
}

/** Filter envelopes down to those a client with `clientVv` doesn't have. */
export function envelopesNotIn(
  all: OpEnvelope[],
  clientVv: VersionVector,
): OpEnvelope[] {
  return all.filter((e) => {
    const k = keyOf(e);
    return (clientVv[k.node] ?? 0) < k.counter;
  });
}
