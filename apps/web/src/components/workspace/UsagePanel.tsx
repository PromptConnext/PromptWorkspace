import type { GovernanceUsage } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("en-US");

function sourceLine(u: GovernanceUsage): string {
  const label = u.source === "managed" ? "Managed model" : `Your model (${u.provider ?? "unknown"})`;
  const runs = `${fmt(u.runs)} ${u.runs === 1 ? "run" : "runs"}`;
  let line = `${label}: ${runs}, ${fmt(u.tokens)} tokens`;
  if (u.daily_budget !== null) {
    line += `; today ${fmt(u.today_tokens)} of the daily budget ${fmt(u.daily_budget)}`;
  }
  return line;
}

export function UsagePanel({ usage }: { usage: GovernanceUsage[] }) {
  return (
    <section className="mt-5 border-t border-slate-100 pt-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">AI usage, last 30 days</h3>
      {usage.map((u) => (
        <div key={`${u.source}-${u.provider ?? ""}`} className="mb-3">
          <p className="text-sm text-slate-800">{sourceLine(u)}</p>
          {u.by_stage.length > 0 && (
            <table className="mt-1 w-full text-left text-xs text-slate-600">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1 pr-3 font-medium">Stage</th>
                  <th className="py-1 pr-3 font-medium">Runs</th>
                  <th className="py-1 pr-3 font-medium">Model</th>
                  <th className="py-1 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {u.by_stage.map((s) => (
                  <tr key={`${s.stage}-${s.model}`} className="border-t border-slate-100">
                    <td className="py-1 pr-3">{s.stage}</td>
                    <td className="py-1 pr-3">{fmt(s.runs)}</td>
                    <td className="py-1 pr-3">{s.model}</td>
                    <td className="py-1">{fmt(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </section>
  );
}
