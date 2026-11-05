import Link from "next/link";

type Tone = "green" | "violet" | "amber" | "muted";

const toneClass: Record<Tone, string> = {
  green: "text-green",
  violet: "text-violet",
  amber: "text-amber",
  muted: "text-muted",
};

export function Eyebrow({
  children,
  tone = "muted",
  className = "",
}: Readonly<{ children: React.ReactNode; tone?: Tone; className?: string }>) {
  return <p className={`eyebrow ${toneClass[tone]} ${className}`}>{children}</p>;
}

export function Card({
  children,
  className = "",
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  return <div className={`card p-6 ${className}`}>{children}</div>;
}

export function Pill({
  children,
  tone = "green",
}: Readonly<{ children: React.ReactNode; tone?: Tone }>) {
  const bg: Record<Tone, string> = {
    green: "bg-green-soft text-green",
    violet: "bg-violet-soft text-violet",
    amber: "bg-amber-soft text-amber",
    muted: "bg-surface-2 text-muted",
  };
  return (
    <span
      className={`eyebrow inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${bg[tone]}`}
    >
      {children}
    </span>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: Readonly<{
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "ghost";
}>) {
  const base =
    "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors";
  const styles =
    variant === "primary"
      ? "bg-green text-on-accent hover:opacity-90"
      : "border border-border-strong text-text hover:bg-surface-2";
  return (
    <Link href={href} className={`${base} ${styles}`}>
      {children}
    </Link>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  children,
}: Readonly<{ eyebrow: string; title: string; children?: React.ReactNode }>) {
  return (
    <div className="max-w-2xl">
      <Eyebrow tone="green">{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-3xl leading-tight sm:text-4xl">{title}</h2>
      {children ? <p className="mt-4 text-muted">{children}</p> : null}
    </div>
  );
}
