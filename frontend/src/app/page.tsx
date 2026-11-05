import { FourSteps } from "@/components/landing/FourSteps";
import { Guardrails } from "@/components/landing/Guardrails";
import { Hero } from "@/components/landing/Hero";
import { Pitch } from "@/components/landing/Pitch";
import { Roles } from "@/components/landing/Roles";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Pitch />
      <FourSteps />
      <Roles />
      <Guardrails />
    </>
  );
}
