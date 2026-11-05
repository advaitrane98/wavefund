/** Illustrative agents. Mock data only: none of these are real agents. */
export interface AgentProfile {
  id: string;
  name: string;
  kind: string;
  summary: string;
  /** Typical tETH share this agent proposes. */
  baseTethShare: number;
  /** Illustrative track record. */
  roundsProposed: number;
  roundsWon: number;
  avgRealisedReturn: number;
}

export const AGENTS: AgentProfile[] = [
  {
    id: "momentum",
    name: "Momentum-7",
    kind: "Momentum agent",
    summary: "Leans into recent strength and raises tETH exposure when the trend is up.",
    baseTethShare: 0.75,
    roundsProposed: 10,
    roundsWon: 4,
    avgRealisedReturn: 0.021,
  },
  {
    id: "mean-reversion",
    name: "Reverter",
    kind: "Mean-reversion agent",
    summary: "Fades extremes and trims tETH after sharp moves.",
    baseTethShare: 0.4,
    roundsProposed: 10,
    roundsWon: 3,
    avgRealisedReturn: 0.009,
  },
  {
    id: "risk-parity",
    name: "Ballast",
    kind: "Risk-parity agent",
    summary: "Balances risk between tETH and USDC and avoids big swings.",
    baseTethShare: 0.5,
    roundsProposed: 9,
    roundsWon: 2,
    avgRealisedReturn: 0.006,
  },
  {
    id: "macro",
    name: "Macro Lens",
    kind: "Macro agent",
    summary: "Reads funding and rates data to size a defensive or risk-on allocation.",
    baseTethShare: 0.35,
    roundsProposed: 8,
    roundsWon: 3,
    avgRealisedReturn: 0.012,
  },
  {
    id: "yield-tilt",
    name: "Carry",
    kind: "Yield-tilt agent",
    summary: "Favours steady USDC carry and holds tETH only as a satellite.",
    baseTethShare: 0.3,
    roundsProposed: 7,
    roundsWon: 1,
    avgRealisedReturn: 0.004,
  },
  {
    id: "breakout",
    name: "Breakout",
    kind: "Breakout agent",
    summary: "Targets volatility expansions with a concentrated tETH position.",
    baseTethShare: 0.8,
    roundsProposed: 9,
    roundsWon: 2,
    avgRealisedReturn: 0.015,
  },
];

export const agentById = (id: string): AgentProfile | undefined =>
  AGENTS.find((a) => a.id === id);
