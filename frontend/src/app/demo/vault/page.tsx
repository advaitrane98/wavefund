import { DemoPage } from "@/components/DemoPage";
import { LiveVault } from "@/components/live/LiveVault";
import { ModeSwitch } from "@/components/ModeSwitch";
import { VaultView } from "@/components/vault/VaultView";

export default function VaultPage() {
  return (
    <DemoPage
      eyebrow="Demo · Vault"
      title="Vault"
      description="The treasury vault: what it holds, how it is priced, and every decision the market has made."
    >
      <ModeSwitch mock={<VaultView />} live={<LiveVault />} />
    </DemoPage>
  );
}
