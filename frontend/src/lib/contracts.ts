import current from "@/data/current.json";

export type DeployedContract = {
  name: string;
  address: `0x${string}`;
};

type CurrentFile = {
  network: string;
  chainId: number;
  contracts: Record<string, string>;
};

const file = current as CurrentFile;

const isAddress = (value: string): value is `0x${string}` =>
  /^0x[0-9a-fA-F]{40}$/.test(value);

/** Deployed contracts listed in current.json. Invalid entries are ignored. */
export const deployedContracts: DeployedContract[] = Object.entries(
  file.contracts,
)
  .filter(([, address]) => isAddress(address))
  .map(([name, address]) => ({ name, address: address as `0x${string}` }));
