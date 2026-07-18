import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

export type Feature = {
  title: string;
  description: string;
  icon?: string;
};

/** Responsive grid of feature cards. */
export function FeatureGrid({ features, columns = 3 }: { features: Feature[]; columns?: 2 | 3 }) {
  return (
    <div
      className={
        columns === 2
          ? "grid gap-4 sm:grid-cols-2"
          : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      }
    >
      {features.map((feature) => (
        <Card key={feature.title}>
          {feature.icon ? (
            <span aria-hidden className="text-xl">
              {feature.icon}
            </span>
          ) : null}
          <CardTitle className={feature.icon ? "mt-3" : undefined}>{feature.title}</CardTitle>
          <CardDescription>{feature.description}</CardDescription>
        </Card>
      ))}
    </div>
  );
}
