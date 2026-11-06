"use client";

import { LiveDataProvider } from "@/lib/live/LiveDataProvider";
import { SimProvider } from "@/sim/SimProvider";
import { PreferencesProvider } from "./PreferencesProvider";
import { WalletProvider } from "./WalletProvider";

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PreferencesProvider>
      <WalletProvider>
        <LiveDataProvider>
          <SimProvider>{children}</SimProvider>
        </LiveDataProvider>
      </WalletProvider>
    </PreferencesProvider>
  );
}
