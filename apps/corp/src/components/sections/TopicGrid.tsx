import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export type Topic = { title: string; description: string };

/**
 * Grid of planned content topics for the SEO pillar hubs (guides, use-cases,
 * compare). As articles are published, swap these into linked cards.
 */
export function TopicGrid({ topics }: { topics: Topic[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {topics.map((topic) => (
        <Card key={topic.title}>
          <Badge className="mb-3">Coming soon</Badge>
          <CardTitle>{topic.title}</CardTitle>
          <CardDescription>{topic.description}</CardDescription>
        </Card>
      ))}
    </div>
  );
}
