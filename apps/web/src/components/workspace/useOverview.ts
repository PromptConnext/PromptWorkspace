import { useCloudGet } from "@/lib/hooks";
import type { WorkspaceOverview } from "@/lib/types";

export function useOverview(workspaceId: string) {
  return useCloudGet<WorkspaceOverview>(`/workspaces/${workspaceId}/overview`);
}
