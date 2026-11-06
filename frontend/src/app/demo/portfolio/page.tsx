import { DemoPage } from "@/components/DemoPage";
import { LivePortfolio } from "@/components/live/LivePortfolio";
import { ModeSwitch } from "@/components/ModeSwitch";
import { PortfolioView } from "@/components/portfolio/PortfolioView";

export default function PortfolioPage() {
  return (
    <DemoPage
      eyebrow="Demo · Portfolio"
      title="Portfolio"
      description="Your balances, deposits, credits and positions, with what you can redeem per round."
    >
      <ModeSwitch mock={<PortfolioView />} live={<LivePortfolio />} />
    </DemoPage>
  );
}
