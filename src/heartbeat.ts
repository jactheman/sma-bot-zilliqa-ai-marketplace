// Synced from the marketplace repo by scripts/export-kit.mjs — edit it there, not here.
/**
 * Liveness heartbeats. A running bot tells the marketplace website it is alive once a minute by
 * posting a message signed with its operator key; the buyer app only offers agents for hire whose
 * last heartbeat is recent, so a stopped bot drops out of the hire list within minutes and comes
 * back when it restarts. Shared by the runner (sender) and the web app (reader); the server side
 * is functions/api/heartbeat.js in the marketplace repo.
 *
 * The signed text commits to the chain, marketplace, agent and a timestamp, so a heartbeat can't
 * be replayed for another agent, another deployment or a later time.
 */
import type { Hex } from "viem";

/** How often a bot reports in. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/**
 * Default live window: agents are offered to buyers while their last stored heartbeat is younger
 * than this. The server states the window it wants in each response (`window`), because its
 * storage decides how often beats are persisted: 3 beats on D1, longer on the KV fallback.
 */
export const LIVE_WINDOW_SEC = 180;
/** A heartbeat older or newer than this, by the server's clock, is rejected. */
export const MAX_CLOCK_SKEW_SEC = 300;
/** The web app's endpoint (same origin as the app). Bots use NETWORKS[network].heartbeat or HEARTBEAT_URL. */
export const HEARTBEAT_PATH = "/api/heartbeat";

/** The exact text the operator signs (EIP-191 personal message). Mirrored in functions/api/heartbeat.js. */
export const heartbeatMessage = (chainId: number, marketplace: string, agentId: bigint | number | string, at: number) =>
  `Zilliqa AI Marketplace heartbeat\nchain: ${chainId}\nmarketplace: ${marketplace.toLowerCase()}\nagent: ${agentId}\nat: ${at}`;

/** Sign and post one heartbeat. Throws with a one-line reason when the server refuses it. */
export async function sendHeartbeat(
  url: string,
  sign: (message: string) => Promise<Hex>,
  chainId: number,
  marketplace: string,
  agentId: bigint | number,
  timeoutMs = 8000,
): Promise<void> {
  const at = Math.floor(Date.now() / 1000);
  const signature = await sign(heartbeatMessage(chainId, marketplace, agentId, at));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, marketplace, agentId: String(agentId), at, signature }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) reason += `: ${body.error}`;
      } catch {
        /* not JSON */
      }
      throw new Error(reason);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Last heartbeat per agent id, as seconds of age at `fetchedAt` (server clock, so client skew doesn't matter). */
export interface Liveness {
  ageSec: Map<string, number>;
  fetchedAt: number;
  /** Seconds of age up to which an agent counts as live, as stated by the server. */
  windowSec: number;
}

/** Read the last heartbeat of the given agents for a deployment. Throws when the endpoint is unavailable. */
export async function fetchLiveness(
  url: string,
  chainId: number,
  marketplace: string,
  agentIds: readonly (bigint | number | string)[],
  timeoutMs = 8000,
): Promise<Liveness> {
  if (!agentIds.length) return { ageSec: new Map(), fetchedAt: Date.now(), windowSec: LIVE_WINDOW_SEC };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q = new URLSearchParams({ chainId: String(chainId), marketplace: marketplace.toLowerCase(), agents: agentIds.map(String).join(",") });
    const res = await fetch(`${url}?${q}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { now?: number; window?: number; agents?: Record<string, number> };
    if (typeof body?.now !== "number" || typeof body.agents !== "object" || body.agents === null) throw new Error("bad response");
    const ageSec = new Map<string, number>();
    for (const [id, at] of Object.entries(body.agents)) if (typeof at === "number") ageSec.set(id, Math.max(0, body.now - at));
    const windowSec = typeof body.window === "number" && body.window > 0 ? body.window : LIVE_WINDOW_SEC;
    return { ageSec, fetchedAt: Date.now(), windowSec };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the agent's last heartbeat is within the live window right now. */
export function isLive(l: Liveness, agentId: bigint | number | string): boolean {
  const age = l.ageSec.get(String(agentId));
  if (age === undefined) return false;
  return age + (Date.now() - l.fetchedAt) / 1000 <= l.windowSec;
}
