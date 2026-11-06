import current from "@/generated/current.json";

export type DeployedContract = {
  name: string;
  address: `0x${string}`;
};

/** Roles the live mode needs, resolved from whatever names the deployment file uses. */
export type DeploymentRole =
  | "quantumRound"
  | "market"
  | "vault"
  | "registry"
  | "tokens"
  | "oracle"
  | "resolver"
  | "hook"
  | "tEth";

export type Deployment = {
  chainId: number | null;
  /** Block the contracts were deployed at, when the file records it. */
  deployBlock: bigint | null;
  addresses: Partial<Record<DeploymentRole, `0x${string}`>>;
};

const ALIASES: Record<DeploymentRole, string[]> = {
  quantumRound: ["quantumround"],
  market: ["wavev4proposalmarket", "proposalmarket", "market", "adapter"],
  vault: ["wavefundvault", "vault"],
  registry: ["proposerregistry", "registry"],
  tokens: ["proposaltokens", "tokens"],
  oracle: ["mockpriceoracle", "priceoracle", "oracle"],
  resolver: ["resolver"],
  hook: ["wavehook", "hook"],
  tEth: ["testasset", "teth"],
};

const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

function addressOf(entry: unknown): `0x${string}` | null {
  if (isAddress(entry)) return entry;
  if (typeof entry === "object" && entry !== null) {
    const inner = (entry as { address?: unknown }).address;
    if (isAddress(inner)) return inner;
  }
  return null;
}

/**
 * Accepts `{ contracts: { Name: "0x..." } }`, a flat `{ Name: "0x..." }`, or entries shaped
 * `{ Name: { address: "0x..." } }`. Invalid entries are ignored.
 */
export function parseDeployment(file: unknown): { deployment: Deployment; all: DeployedContract[] } {
  const raw = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
  const table = (
    typeof raw.contracts === "object" && raw.contracts !== null ? raw.contracts : raw
  ) as Record<string, unknown>;

  const all: DeployedContract[] = [];
  const addresses: Deployment["addresses"] = {};
  for (const [name, entry] of Object.entries(table)) {
    const address = addressOf(entry);
    if (!address) continue;
    all.push({ name, address });
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const [role, names] of Object.entries(ALIASES) as [DeploymentRole, string[]][]) {
      if (!addresses[role] && names.includes(key)) addresses[role] = address;
    }
  }

  const blockRaw = raw.deployBlock ?? raw.startBlock ?? raw.blockNumber;
  let deployBlock: bigint | null = null;
  try {
    if (typeof blockRaw === "number" || typeof blockRaw === "string") deployBlock = BigInt(blockRaw);
  } catch {
    deployBlock = null;
  }
  const chainId = typeof raw.chainId === "number" ? raw.chainId : null;

  return { deployment: { chainId, deployBlock, addresses }, all };
}

const parsed = parseDeployment(current);

/** Every contract listed in the deployment file (used by the footer). */
export const deployedContracts: DeployedContract[] = parsed.all;

export const deployment: Deployment = parsed.deployment;

/** True when the deployment has every contract live mode reads and writes. */
export const hasLiveDeployment: boolean =
  !!deployment.addresses.quantumRound &&
  !!deployment.addresses.market &&
  !!deployment.addresses.vault &&
  !!deployment.addresses.registry &&
  !!deployment.addresses.tokens &&
  (deployment.chainId === null || deployment.chainId === 5042002);
