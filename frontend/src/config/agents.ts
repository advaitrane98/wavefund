import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import raw from "./agents.json";

/** Public agent roster, copied from agents/agents.json by `npm run gen:abis`. Never holds keys. */
export type AgentType = "proposer" | "forecaster";

export interface AgentProfile {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  address: Address;
  /** How the agent's wallet is custodied. */
  wallet: "circle-developer-controlled";
}

interface RawAgent {
  id: string;
  name: string;
  type: string;
  description: string;
  address: string;
  wallet?: string;
}

function parse(entries: readonly RawAgent[]): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const e of entries) {
    if (!isAddress(e.address)) continue;
    if (e.type !== "proposer" && e.type !== "forecaster") continue;
    out.push({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      address: getAddress(e.address),
      wallet: "circle-developer-controlled",
    });
  }
  return out;
}

export const agents: readonly AgentProfile[] = parse((raw as { agents?: RawAgent[] }).agents ?? []);
export const proposerAgents = agents.filter((a) => a.type === "proposer");
export const forecasterAgents = agents.filter((a) => a.type === "forecaster");

const byAddress = new Map(agents.map((a) => [a.address.toLowerCase(), a]));

export function agentByAddress(address: string | null | undefined): AgentProfile | null {
  return address ? (byAddress.get(address.toLowerCase()) ?? null) : null;
}

export const WALLET_TAG = "Circle developer-controlled wallet";
