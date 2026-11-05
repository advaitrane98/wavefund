import { ComingSoon, DemoPage } from "@/components/DemoPage";

export default function PortfolioPage() {
  return (
    <DemoPage
      eyebrow="Demo · Portfolio"
      title="Portfolio"
      description="Your deposits, claims and payouts across rounds."
    >
      <ComingSoon>The portfolio view is built in the next task.</ComingSoon>
    </DemoPage>
  );
}
