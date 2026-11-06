import deploymentFile from "./deployment.json";

/**
 * The address book. Addresses live in `deployment.json` (written by `npm run gen:abis`);
 * the ABIs live in `src/abis/`. Nothing else in the app hard-codes an address.
 */
export type Address = `0x${string}`;

export type DeployedContract = {
  name: string;
  address: Address;
};

/** Roles the live mode needs, mapped to the contract name in the deployment file. */
export const ROLE_CONTRACTS = {
  quantumRound: "QuantumRound",
  market: "WaveV4ProposalMarket",
  vault: "WavefundVault",
  registry: "ProposerRegistry",
  tokens: "ProposalTokens",
  oracle: "MockPriceOracle",
  resolver: "Resolver",
  hook: "WaveHook",
  tEth: "TestAsset",
  poolHelper: "WavefundPoolHelper",
} as const;

export type DeploymentRole = keyof typeof ROLE_CONTRACTS;

type DeploymentFile = {
  network?: string;
  chainId?: number;
  deployBlock?: number | string;
  external?: Record<string, string>;
  contracts?: Record<string, string>;
};

const file = deploymentFile as DeploymentFile;

const isAddress = (value: unknown): value is Address =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

export const CHAIN_ID: number = file.chainId ?? 5042002;

/** Contracts we did not deploy: USDC (ERC-20 view of the native balance) and the Uniswap v4 PoolManager. */
export const external: Partial<Record<string, Address>> = Object.fromEntries(
  Object.entries(file.external ?? {})
    .filter(([, a]) => isAddress(a))
    .map(([name, a]) => [name, a as Address]),
);

/** Every Wavefund contract listed in the deployment file (the footer shows these). */
export const deployedContracts: DeployedContract[] = Object.entries(file.contracts ?? {})
  .filter(([, address]) => isAddress(address))
  .map(([name, address]) => ({ name, address: address as Address }));

const byName = new Map(deployedContracts.map((c) => [c.name, c.address]));

export type Deployment = {
  chainId: number;
  /** Block the contracts were deployed at; bounds log queries. */
  deployBlock: bigint | null;
  addresses: Partial<Record<DeploymentRole, Address>>;
};

function parseBlock(value: number | string | undefined): bigint | null {
  try {
    return value === undefined ? null : BigInt(value);
  } catch {
    return null;
  }
}

export const deployment: Deployment = {
  chainId: CHAIN_ID,
  deployBlock: parseBlock(file.deployBlock),
  addresses: Object.fromEntries(
    (Object.entries(ROLE_CONTRACTS) as [DeploymentRole, string][])
      .map(([role, name]) => [role, byName.get(name)] as const)
      .filter(([, address]) => address !== undefined),
  ) as Partial<Record<DeploymentRole, Address>>,
};

/** True when the deployment has every contract live mode reads and writes. */
export const hasLiveDeployment: boolean =
  CHAIN_ID === 5042002 &&
  !!deployment.addresses.quantumRound &&
  !!deployment.addresses.market &&
  !!deployment.addresses.vault &&
  !!deployment.addresses.registry &&
  !!deployment.addresses.tokens;
