import { DemoPage } from "@/components/DemoPage";
import { VaultView } from "@/components/vault/VaultView";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function VaultPage() {
  return (
    <DemoPage
      eyebrow="Demo · Vault"
      title="Vault"
      description="The treasury vault: what it holds, how it is priced, and every decision the market has made."
    >
      <WorkspaceGate>
        <VaultView />
      </WorkspaceGate>
    </DemoPage>
  );
}
