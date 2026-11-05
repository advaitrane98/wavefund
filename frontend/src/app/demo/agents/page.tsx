import { AgentsView } from "@/components/agents/AgentsView";
import { DemoPage } from "@/components/DemoPage";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function AgentsPage() {
  return (
    <DemoPage
      eyebrow="Demo · Agents"
      title="Agents"
      description="The agents that compete to manage the treasury."
    >
      <WorkspaceGate>
        <AgentsView />
      </WorkspaceGate>
    </DemoPage>
  );
}
