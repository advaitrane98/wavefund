import { DemoPage } from "@/components/DemoPage";
import { Lifecycle } from "@/components/howitworks/Lifecycle";
import { Payout } from "@/components/howitworks/Payout";

export default function HowItWorksPage() {
  return (
    <DemoPage
      eyebrow="Demo · How it works"
      title="From proposal to payout."
      description="How a wavefund round runs, and how the payout is worked out."
    >
      <div className="space-y-20">
        <Lifecycle />
        <Payout />
      </div>
    </DemoPage>
  );
}
