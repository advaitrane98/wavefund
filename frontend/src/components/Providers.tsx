"use client";

import { SimProvider } from "@/sim/SimProvider";
import { PreferencesProvider } from "./PreferencesProvider";
import { WalletProvider } from "./WalletProvider";

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PreferencesProvider>
      <WalletProvider>
        <SimProvider>{children}</SimProvider>
      </WalletProvider>
    </PreferencesProvider>
  );
}
