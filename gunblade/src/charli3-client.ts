import axios from "axios";
import {
  NodeConfig,
  OdvFeedRequest,
  SignedNodeMessage,
  OdvTxSignatureRequest,
} from "./types";

/**
 * POST /odv/feed – ask a node for its signed price message.
 * Returns null if the node is unreachable or returns an error.
 */
export async function fetchNodeFeed(
  node: NodeConfig,
  request: OdvFeedRequest
): Promise<SignedNodeMessage | null> {
  try {
    const { data } = await axios.post<SignedNodeMessage>(
      `${node.root_url}/odv/feed`,
      request,
      { timeout: 10_000 }
    );
    return data;
  } catch (err) {
    console.warn(`[charli3] node ${node.root_url} feed error:`, (err as Error).message);
    return null;
  }
}

/**
 * Collect feed responses from all nodes, filtering failures.
 * Throws if fewer than `minRequired` nodes respond.
 */
export async function collectFeedUpdates(
  nodes: NodeConfig[],
  request: OdvFeedRequest,
  minRequired: number
): Promise<Record<string, SignedNodeMessage>> {
  const results = await Promise.all(
    nodes.map(async (n) => {
      const msg = await fetchNodeFeed(n, request);
      return msg ? [n.pub_key, msg] as const : null;
    })
  );

  const valid = Object.fromEntries(
    results.filter((r): r is [string, SignedNodeMessage] => r !== null)
  );

  if (Object.keys(valid).length < minRequired) {
    throw new Error(
      `Only ${Object.keys(valid).length}/${nodes.length} nodes responded (need ${minRequired})`
    );
  }

  return valid;
}

/**
 * POST /odv/sign – ask each node to co-sign the built transaction body.
 */
export async function collectTxSignatures(
  nodes: NodeConfig[],
  request: OdvTxSignatureRequest
): Promise<Record<string, string>> {
  const results = await Promise.all(
    nodes.map(async (n) => {
      try {
        const { data } = await axios.post<{ signature: string }>(
          `${n.root_url}/odv/sign`,
          request,
          { timeout: 15_000 }
        );
        return [n.pub_key, data.signature] as const;
      } catch (err) {
        console.warn(`[charli3] node ${n.root_url} sign error:`, (err as Error).message);
        return null;
      }
    })
  );

  return Object.fromEntries(
    results.filter((r): r is [string, string] => r !== null)
  );
}

/** Compute median of integer feeds (matches Charli3 Python median logic). */
export function computeMedianFeed(
  messages: Record<string, SignedNodeMessage>
): number {
  const { deserializeDatum } = require("@meshsdk/core");
  const feeds = Object.values(messages)
    .map((m) => {
      const d = deserializeDatum(m.message) as any;
      return Number(d.fields?.[0]?.int ?? d.fields?.[0] ?? 0);
    })
    .sort((a, b) => a - b);

  const mid = Math.floor(feeds.length / 2);
  if (feeds.length % 2 === 0) {
    return Math.round((feeds[mid - 1] + feeds[mid]) / 2);
  }
  return feeds[mid];
}
