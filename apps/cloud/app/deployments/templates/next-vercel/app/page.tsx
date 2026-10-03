// Replace this page as the project takes shape — the pipeline around it
// (next.config.mjs, .github/workflows/deploy.yml) is what PromptWorkspace seeded,
// and it does not care what this app grows into.
export default function Page() {
  return (
    <main>
      <p className="badge">Live preview</p>
      <h1>This project is deployed.</h1>
      <p>
        Every push to the default branch rebuilds this app and publishes it to
        Vercel. Replace the contents of <code>app/</code> as the project takes
        shape — what you see here is what stakeholders see in PromptWorkspace.
      </p>
      <p className="muted">
        How this repository builds and deploys is documented in{" "}
        <code>docs/deployment.md</code>.
      </p>
    </main>
  );
}
