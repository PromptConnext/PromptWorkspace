import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployConnectionsPanel } from "./DeployConnectionsPanel";
import type { DeployConnection, DeploymentTemplateOut } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

function template(over: Partial<DeploymentTemplateOut>): DeploymentTemplateOut {
  return {
    id: "t",
    name: "T",
    description: "",
    stack: "static",
    delivery_kind: "embedded_url",
    provider: "p",
    provider_label: "P",
    provider_is_platform_owned: false,
    provider_project_fields: [],
    embeddable: true,
    required_secrets: [],
    required_vars: [],
    scaffold_paths: [],
    workflow_preview: "",
    ...over,
  };
}

const TEMPLATES: DeploymentTemplateOut[] = [
  template({
    id: "static-r2",
    provider: "platform-r2",
    provider_label: "PromptZone hosting",
    provider_is_platform_owned: true,
  }),
  template({ id: "docker-compose", provider: "ssh-docker", provider_label: "Docker host over SSH" }),
  template({ id: "next-vercel", provider: "vercel", provider_label: "Vercel" }),
];

const VERCEL_DISCONNECTED: DeployConnection = {
  connected: false,
  provider: "vercel",
  label: "Vercel",
  token_label: "Deploy token",
  token_multiline: false,
  fields: [
    { name: "project_id", label: "Vercel project ID", secret: false },
    { name: "org_id", label: "Vercel team or personal account ID", secret: false },
  ],
  values: { project_id: "", org_id: "" },
  connected_at: null,
};

const HOST_DISCONNECTED: DeployConnection = {
  connected: false,
  provider: "ssh-docker",
  label: "Docker host over SSH",
  token_label: "SSH private key",
  token_multiline: true,
  fields: [
    { name: "host", label: "Docker host address", secret: false },
    { name: "ssh_user", label: "SSH user", secret: false },
  ],
  values: { host: "", ssh_user: "" },
  connected_at: null,
};

const sent: { method: string; url: string; body: unknown }[] = [];

function mockFetch(options: { vercel?: DeployConnection; putFailure?: string } = {}) {
  const vercel = options.vercel ?? VERCEL_DISCONNECTED;
  global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = url.toString();
    const method = init?.method ?? "GET";
    if (href.includes("/integrations/deploy/") && method !== "GET") {
      sent.push({
        method,
        url: href,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (options.putFailure) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ detail: options.putFailure }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => vercel });
    }
    if (href.includes("/integrations/deploy/vercel")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => vercel });
    }
    if (href.includes("/integrations/deploy/ssh-docker")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => HOST_DISCONNECTED });
    }
    if (href.includes("/deployment-templates")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => TEMPLATES });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

// Scoped by the provider's own named region rather than by index: every
// provider renders an identically labelled "Deploy token" input, and the
// templates list puts the Docker host before Vercel, so an index would silently drive the
// wrong form.
async function vercelForm() {
  return within(await screen.findByRole("region", { name: "Vercel" }));
}

async function fillVercelAndSubmit(token: string) {
  const form = await vercelForm();
  fireEvent.change(form.getByLabelText("Vercel project ID"), { target: { value: " prj_1 " } });
  fireEvent.change(form.getByLabelText("Vercel team or personal account ID"), {
    target: { value: "team_1" },
  });
  fireEvent.change(form.getByLabelText("Deploy token"), { target: { value: token } });
  fireEvent.click(form.getByRole("button", { name: "Connect" }));
}

describe("DeployConnectionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("offers a form for every provider a template needs", async () => {
    mockFetch();
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    expect(await screen.findByRole("heading", { name: "Vercel" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Docker host over SSH" }),
    ).toBeInTheDocument();
  });

  it("omits the platform-owned provider, which has nothing to connect", async () => {
    mockFetch();
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    await screen.findByRole("heading", { name: "Vercel" });
    expect(
      screen.queryByRole("heading", { name: "PromptZone hosting" }),
    ).not.toBeInTheDocument();
  });

  it("renders one input per field the server declares, so a provider needs no code here", async () => {
    mockFetch();
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    expect(await screen.findByLabelText("Vercel project ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Vercel team or personal account ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Docker host address")).toBeInTheDocument();
  });

  it("names the provider's own secret, and gives a multi-line one room", async () => {
    mockFetch();
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    // A private key pasted into a single-line input loses its newlines, and
    // the failure then surfaces on a deploy rather than in this form.
    const key = await screen.findByLabelText("SSH private key");
    expect(key.tagName).toBe("TEXTAREA");
    // A single-line secret still renders as one, and still says what it is.
    expect(screen.getByLabelText("Deploy token").tagName).toBe("INPUT");
  });

  it("sends the token and the field values on connect", async () => {
    mockFetch();
    render(<DeployConnectionsPanel workspaceId="ws-1" />);
    await screen.findByLabelText("Vercel project ID");

    await fillVercelAndSubmit(" tok ");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].url).toContain("/integrations/deploy/vercel");
    // Trimmed on the way out: a pasted id with trailing whitespace is the
    // single most likely way to produce a "project not found" that is not one.
    expect(sent[0].body).toEqual({
      token: "tok",
      values: { project_id: "prj_1", org_id: "team_1" },
    });
  });

  it("keeps a secret field out of plain text", async () => {
    mockFetch({
      vercel: {
        ...VERCEL_DISCONNECTED,
        fields: [{ name: "secret_thing", label: "Secret thing", secret: true }],
        values: { secret_thing: "" },
      },
    });
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    const input = await screen.findByLabelText("Secret thing");
    expect(input).toHaveAttribute("type", "password");
  });

  it("shows the stored identifiers and a disconnect action once connected", async () => {
    mockFetch({
      vercel: {
        ...VERCEL_DISCONNECTED,
        connected: true,
        values: { project_id: "prj_live", org_id: "team_live" },
        connected_at: "2026-09-06T00:00:00Z",
      },
    });
    render(<DeployConnectionsPanel workspaceId="ws-1" />);

    // Reconnecting to rotate a token must not make the admin retype these.
    // Waited for rather than asserted on the first render that has the input:
    // the stored values arrive from the server and land one effect later, so
    // asserting immediately is a race the test would sometimes lose.
    const projectId = await screen.findByLabelText("Vercel project ID");
    await waitFor(() => expect(projectId).toHaveValue("prj_live"));
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("explains a missing provider project instead of showing the raw error code", async () => {
    mockFetch({ putFailure: "deploy_project_not_found" });
    render(<DeployConnectionsPanel workspaceId="ws-1" />);
    await screen.findByLabelText("Vercel project ID");

    await fillVercelAndSubmit("tok");

    expect(
      await screen.findByText(/Create the project in Vercel first/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/deploy_project_not_found/)).not.toBeInTheDocument();
  });

  it("explains a rejected token in the provider's own name", async () => {
    mockFetch({ putFailure: "deploy_token_rejected" });
    render(<DeployConnectionsPanel workspaceId="ws-1" />);
    await screen.findByLabelText("Vercel project ID");

    await fillVercelAndSubmit("bad");

    expect(await screen.findByText(/Vercel rejected that token/i)).toBeInTheDocument();
  });
});
