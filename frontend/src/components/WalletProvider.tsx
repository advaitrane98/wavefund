"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { formatUnits, getAddress, numberToHex } from "viem";
import {
  USDC_ADDRESS,
  USDC_DECIMALS,
  arcTestnet,
  erc20BalanceAbi,
  publicClient,
} from "@/lib/chain";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const CONNECTED_KEY = "wavefund:wallet-connected";

type WalletState = {
  address: `0x${string}` | null;
  /** USDC balance in the ERC-20 view (6 decimals), formatted. */
  usdcBalance: string | null;
  chainId: number | null;
  wrongNetwork: boolean;
  connecting: boolean;
  error: string | null;
  hasProvider: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletState | null>(null);

async function switchToArc(provider: Eip1193Provider) {
  const chainIdHex = numberToHex(arcTestnet.id);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: arcTestnet.rpcUrls.default.http,
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        },
      ],
    });
  }
}

export function WalletProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(false);

  const refreshBalance = useCallback(async (account: `0x${string}`) => {
    try {
      const raw = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [account],
      });
      setUsdcBalance(formatUnits(raw, USDC_DECIMALS));
    } catch {
      setUsdcBalance(null);
    }
  }, []);

  const readChain = useCallback(async (provider: Eip1193Provider) => {
    const hex = (await provider.request({ method: "eth_chainId" })) as string;
    setChainId(Number.parseInt(hex, 16));
  }, []);

  const applyAccounts = useCallback(
    (accounts: string[]) => {
      if (accounts.length === 0) {
        setAddress(null);
        setUsdcBalance(null);
        window.localStorage.removeItem(CONNECTED_KEY);
        return;
      }
      const next = getAddress(accounts[0]);
      setAddress(next);
      void refreshBalance(next);
    },
    [refreshBalance],
  );

  // Detect an injected wallet and silently restore a previous connection.
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    setHasProvider(true);

    const onAccounts = (accounts: string[]) => applyAccounts(accounts);
    const onChain = (hex: string) => setChainId(Number.parseInt(hex, 16));
    provider.on?.("accountsChanged", onAccounts as never);
    provider.on?.("chainChanged", onChain as never);

    if (window.localStorage.getItem(CONNECTED_KEY) === "1") {
      void (async () => {
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        applyAccounts(accounts);
        await readChain(provider);
      })().catch(() => undefined);
    }

    return () => {
      provider.removeListener?.("accountsChanged", onAccounts as never);
      provider.removeListener?.("chainChanged", onChain as never);
    };
  }, [applyAccounts, readChain]);

  // Keep the balance fresh while connected.
  useEffect(() => {
    if (!address) return;
    const id = window.setInterval(() => void refreshBalance(address), 15_000);
    return () => window.clearInterval(id);
  }, [address, refreshBalance]);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) {
      setError("No browser wallet found. Install a wallet extension to connect.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      await switchToArc(provider);
      await readChain(provider);
      window.localStorage.setItem(CONNECTED_KEY, "1");
      applyAccounts(accounts);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Wallet connection failed";
      setError(message);
    } finally {
      setConnecting(false);
    }
  }, [applyAccounts, readChain]);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(CONNECTED_KEY);
    setAddress(null);
    setUsdcBalance(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      usdcBalance,
      chainId,
      wrongNetwork: address !== null && chainId !== null && chainId !== arcTestnet.id,
      connecting,
      error,
      hasProvider,
      connect,
      disconnect,
    }),
    [address, usdcBalance, chainId, connecting, error, hasProvider, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
