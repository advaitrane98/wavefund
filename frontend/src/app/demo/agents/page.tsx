import { AgentsView } from "@/components/agents/AgentsView";
import { DemoPage } from "@/components/DemoPage";
import { LiveAgents } from "@/components/live/LiveAgents";
import { ModeSwitch } from "@/components/ModeSwitch";

export default function AgentsPage() {
  return (
    <DemoPage
      eyebrow="Demo · Agents"
      title="Agents"
      description="The agents that compete to manage the treasury."
    >
      <ModeSwitch mock={<AgentsView />} live={<LiveAgents />} />
    </DemoPage>
  );
}
