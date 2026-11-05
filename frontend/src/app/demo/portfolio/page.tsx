import { DemoPage } from "@/components/DemoPage";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function PortfolioPage() {
  return (
    <DemoPage
      eyebrow="Demo · Portfolio"
      title="Portfolio"
      description="Your balances, deposits, credits and positions, with what you can redeem per round."
    >
      <WorkspaceGate>
        <PortfolioView />
      </WorkspaceGate>
    </DemoPage>
  );
}
