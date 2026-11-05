"use client";

import { PreferencesProvider } from "./PreferencesProvider";
import { WalletProvider } from "./WalletProvider";

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <PreferencesProvider>
      <WalletProvider>{children}</WalletProvider>
    </PreferencesProvider>
  );
}
