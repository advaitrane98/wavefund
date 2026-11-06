"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { erc20Abi, getAddress, type EIP1193Provider, type Hash } from "viem";
import { ARC_CHAIN_ID_HEX, USDC_ADDRESS, arcTestnet } from "@/lib/chain";
import { getPublicClient, setWalletTransport } from "@/lib/live/client";
import { classifyError } from "@/lib/live/errors";
import { sendContractTx, type TxRequest } from "@/lib/live/tx";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

interface ProviderDetail {
  info: { uuid: string; name: string; rdns: string };
  provider: EIP1193Provider;
}

export type WalletErrorKind =
  | "no-wallet"
  | "rejected"
  | "pending"
  | "wrong-network"
  | "other";

export interface WalletError {
  kind: WalletErrorKind;
  message: string;
}

const CONNECTED_KEY = "wavefund:wallet-connected";
const METAMASK_RDNS = "io.metamask";

type WalletState = {
  address: `0x${string}` | null;
  chainId: number | null;
  onArc: boolean;
  /** ERC-20 USDC balance, raw (6 decimals). */
  usdcBalance: bigint | null;
  connecting: boolean;
  error: WalletError | null;
  providerName: string | null;
  connect: () => Promise<void>;
  switchToArc: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  clearError: () => void;
  /** Simulate, broadcast and confirm a contract call, then refresh the balance. */
  send: (req: TxRequest) => Promise<Hash>;
};

const WalletContext = createContext<WalletState | null>(null);

/** wallet_switchEthereumChain, falling back to wallet_addEthereumChain on 4902. */
async function ensureArc(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: ARC_CHAIN_ID_HEX,
          chainName: "Arc Testnet",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: arcTestnet.rpcUrls.default.http,
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        },
      ],
    });
  }
}

function toWalletError(err: unknown): WalletError {
  const { kind, message } = classifyError(err);
  if (kind === "rejected") return { kind: "rejected", message };
  if (kind === "pending") return { kind: "pending", message };
  return { kind: "other", message };
}

export function WalletProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<WalletError | null>(null);
  const [providerName, setProviderName] = useState<string | null>(null);

  const discovered = useRef(new Map<string, ProviderDetail>());
  const active = useRef<EIP1193Provider | null>(null);
  const addressRef = useRef<`0x${string}` | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const onArc = chainId === arcTestnet.id;

  const refreshBalance = useCallback(async () => {
    const account = addressRef.current;
    if (!account) return;
    try {
      const raw = await getPublicClient().readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
      setUsdcBalance(raw);
    } catch {
      // Keep the last known balance rather than blanking the header.
    }
  }, []);

  const pickProvider = useCallback((): { provider: EIP1193Provider; name: string } | null => {
    const all = [...discovered.current.values()];
    const metamask = all.find(
      (d) => d.info.rdns === METAMASK_RDNS || /metamask/i.test(d.info.name),
    );
    const chosen = metamask ?? all[0];
    if (chosen) return { provider: chosen.provider, name: chosen.info.name };
    if (window.ethereum) return { provider: window.ethereum, name: "Browser wallet" };
    return null;
  }, []);

  const applyAccounts = useCallback(
    (accounts: string[]) => {
      if (accounts.length === 0) {
        addressRef.current = null;
        setAddress(null);
        setUsdcBalance(null);
        window.localStorage.removeItem(CONNECTED_KEY);
        return;
      }
      const next = getAddress(accounts[0]);
      addressRef.current = next;
      setAddress(next);
      void refreshBalance();
    },
    [refreshBalance],
  );

  const applyChain = useCallback(
    (id: number) => {
      setChainId(id);
      // Read through the wallet only while it is on Arc; otherwise use the public RPC.
      setWalletTransport(id === arcTestnet.id ? active.current : null);
      void refreshBalance();
    },
    [refreshBalance],
  );

  const attach = useCallback(
    async (provider: EIP1193Provider, name: string) => {
      detach.current?.();
      active.current = provider;
      setProviderName(name);
      const onAccounts = (accounts: string[]) => applyAccounts(accounts);
      const onChain = (hex: string) => applyChain(Number.parseInt(hex, 16));
      provider.on?.("accountsChanged", onAccounts as never);
      provider.on?.("chainChanged", onChain as never);
      detach.current = () => {
        provider.removeListener?.("accountsChanged", onAccounts as never);
        provider.removeListener?.("chainChanged", onChain as never);
      };
      const hex = (await provider.request({ method: "eth_chainId" })) as string;
      applyChain(Number.parseInt(hex, 16));
    },
    [applyAccounts, applyChain],
  );

  // EIP-6963 discovery, then silently restore a previous connection.
  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<ProviderDetail>).detail;
      if (detail?.info?.uuid) discovered.current.set(detail.info.uuid, detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || window.localStorage.getItem(CONNECTED_KEY) !== "1") return;
      const picked = pickProvider();
      if (!picked) return;
      void (async () => {
        const accounts = (await picked.provider.request({ method: "eth_accounts" })) as string[];
        if (cancelled) return;
        await attach(picked.provider, picked.name);
        applyAccounts(accounts);
      })().catch(() => undefined);
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, [applyAccounts, attach, pickProvider]);

  // Keep the header balance fresh while the tab is visible.
  useEffect(() => {
    if (!address) return;
    const tick = () => {
      if (!document.hidden) void refreshBalance();
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [address, refreshBalance]);

  const connect = useCallback(async () => {
    setError(null);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const picked = pickProvider();
    if (!picked) {
      setError({
        kind: "no-wallet",
        message: "No browser wallet found. Install MetaMask or another EVM wallet, then try again.",
      });
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await picked.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      await attach(picked.provider, picked.name);
      await ensureArc(picked.provider);
      const hex = (await picked.provider.request({ method: "eth_chainId" })) as string;
      applyChain(Number.parseInt(hex, 16));
      window.localStorage.setItem(CONNECTED_KEY, "1");
      applyAccounts(accounts);
    } catch (err) {
      setError(toWalletError(err));
    } finally {
      setConnecting(false);
    }
  }, [applyAccounts, applyChain, attach, pickProvider]);

  const switchToArc = useCallback(async () => {
    const provider = active.current;
    if (!provider) return;
    setError(null);
    try {
      await ensureArc(provider);
      const hex = (await provider.request({ method: "eth_chainId" })) as string;
      applyChain(Number.parseInt(hex, 16));
    } catch (err) {
      setError(toWalletError(err));
    }
  }, [applyChain]);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(CONNECTED_KEY);
    addressRef.current = null;
    setAddress(null);
    setUsdcBalance(null);
    setError(null);
  }, []);

  const send = useCallback(
    async (req: TxRequest): Promise<Hash> => {
      const provider = active.current;
      const account = addressRef.current;
      if (!provider || !account) throw new Error("Connect your wallet first.");
      const hex = (await provider.request({ method: "eth_chainId" })) as string;
      if (Number.parseInt(hex, 16) !== arcTestnet.id) {
        throw new Error("Your wallet is on the wrong network. Switch to Arc testnet.");
      }
      const hash = await sendContractTx(provider, account, req);
      void refreshBalance();
      return hash;
    },
    [refreshBalance],
  );

  const wrongNetworkError = useMemo<WalletError | null>(
    () =>
      address && chainId !== null && !onArc
        ? {
            kind: "wrong-network",
            message: "Your wallet is on the wrong network. Switch to Arc testnet to continue.",
          }
        : null,
    [address, chainId, onArc],
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      chainId,
      onArc,
      usdcBalance,
      connecting,
      error: error ?? wrongNetworkError,
      providerName,
      connect,
      switchToArc,
      disconnect,
      refreshBalance,
      clearError: () => setError(null),
      send,
    }),
    [
      address,
      chainId,
      onArc,
      usdcBalance,
      connecting,
      error,
      wrongNetworkError,
      providerName,
      connect,
      switchToArc,
      disconnect,
      refreshBalance,
      send,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
