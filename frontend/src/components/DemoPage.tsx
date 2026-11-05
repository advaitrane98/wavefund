import { DataModeBanner } from "./DataModeBanner";
import { Eyebrow } from "./ui";

export function DemoPage({
  eyebrow,
  title,
  description,
  children,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}>) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Eyebrow tone="green">{eyebrow}</Eyebrow>
      <h1 className="mt-3 text-4xl leading-tight sm:text-5xl">{title}</h1>
      <p className="mt-4 max-w-2xl text-muted">{description}</p>
      <div className="mt-6">
        <DataModeBanner />
      </div>
      <div className="mt-10">{children}</div>
    </div>
  );
}

export function ComingSoon({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="card border-dashed p-8 text-sm text-muted">{children}</div>
  );
}
