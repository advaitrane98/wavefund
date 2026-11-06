import { DemoPage } from "@/components/DemoPage";
import { LiveMarkets } from "@/components/live/LiveMarkets";
import { MarketsView } from "@/components/markets/MarketsView";
import { ModeSwitch } from "@/components/ModeSwitch";

export default function MarketsPage() {
  return (
    <DemoPage
      eyebrow="Demo · Markets"
      title="Markets"
      description="Every proposal has its own market. Deposit once, claim credits in each, and trade what you believe."
    >
      <ModeSwitch mock={<MarketsView />} live={<LiveMarkets />} />
    </DemoPage>
  );
}
