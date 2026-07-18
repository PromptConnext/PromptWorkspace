import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";

export default function NotFound() {
  return (
    <Container className="flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      <p className="text-sm font-semibold text-accent">404</p>
      <h1 className="mt-3 text-3xl font-semibold text-text-primary sm:text-4xl">
        Page not found
      </h1>
      <p className="mt-4 max-w-md text-text-secondary">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <div className="mt-8 flex gap-3">
        <Button href="/">Back home</Button>
        <Button href="/product" variant="secondary">
          Explore the product
        </Button>
      </div>
    </Container>
  );
}
