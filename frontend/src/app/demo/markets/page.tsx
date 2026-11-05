import { DemoPage } from "@/components/DemoPage";
import { MarketsView } from "@/components/markets/MarketsView";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function MarketsPage() {
  return (
    <DemoPage
      eyebrow="Demo · Markets"
      title="Markets"
      description="Every proposal has its own market. Deposit once, claim credits in each, and trade what you believe."
    >
      <WorkspaceGate>
        <MarketsView />
      </WorkspaceGate>
    </DemoPage>
  );
}
