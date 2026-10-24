import type { GovernanceDiscipline } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("en-US");

function median(hours: number | null): string {
  if (hours === null) return "Median time to decide: not yet known";
  const value = Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10;
  return `Median time to decide: ${value.toLocaleString("en-US")} ${value === 1 ? "hour" : "hours"}`;
}

export function DisciplinePanel({ discipline: d }: { discipline: GovernanceDiscipline }) {
  return (
    <section className="mt-5 border-t border-slate-100 pt-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">Decision discipline</h3>
      <div className="space-y-1 text-sm text-slate-800">
        <p>
          {`${fmt(d.resolved)} ${d.resolved === 1 ? "decision" : "decisions"} resolved, ${fmt(d.open)} open, ${fmt(d.expired_30d)} expired without an answer`}
        </p>
        <p>{median(d.median_hours_to_decide)}</p>
        <p>
          {`Receipt chains verified for ${fmt(d.chains_verified)} of ${fmt(d.chains_total)} ${d.chains_total === 1 ? "project" : "projects"}`}
        </p>
      </div>
    </section>
  );
}
