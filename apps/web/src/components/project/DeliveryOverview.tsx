"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useCloudGet } from "@/lib/hooks";
import type { DecisionsOut, DeliveryOverview, DeliveryPlan } from "@/lib/types";

/** What a delivery surface reads from the shared overview: the shape of
 *  `useCloudGet`'s answer, for the part of the overview it shows. */
export interface OverviewSlice<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
  retry: () => void;
}

interface Shared {
  overview: DeliveryOverview | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
  retry: () => void;
  /** Apply a decision write's snapshot to the decisions, the states and the
   *  plan's approval, instead of spending a refetch. */
  applyDecisions: (snapshot: DecisionsOut) => void;
  /** Called by each surface as it mounts: the first one starts the request. */
  subscribe: () => void;
}

const OverviewContext = createContext<Shared | null>(null);

/** One `GET /projects/{id}/delivery-overview` for every delivery surface
 *  below it (the plan, the approval controls, the decisions list), so a tab
 *  that shows three of them makes one request instead of one each, and none of
 *  them waits for another to load first. The request starts when the first
 *  surface mounts: a Planner step without an approval control asks for
 *  nothing. */
export function DeliveryOverviewProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [wanted, setWanted] = useState(false);
  const { data, error, loading, refetch, retry, mutate } = useCloudGet<DeliveryOverview>(
    `/projects/${projectId}/delivery-overview`,
    wanted,
  );
  const subscribe = useCallback(() => setWanted(true), []);
  const applyDecisions = useCallback(
    (snapshot: DecisionsOut) => {
      if (!data) {
        refetch();
        return;
      }
      mutate({
        ...data,
        decisions: snapshot.decisions,
        states: snapshot.states,
        plan: { ...data.plan, plan_approval: snapshot.states.plan },
      });
    },
    [data, mutate, refetch],
  );
  const shared = useMemo(
    () => ({
      overview: data,
      // Until the first surface subscribes nothing is loading, but nothing
      // has loaded either: a surface reads that as loading.
      error,
      loading: loading || !wanted,
      refetch,
      retry,
      applyDecisions,
      subscribe,
    }),
    [data, error, loading, wanted, refetch, retry, applyDecisions, subscribe],
  );
  return <OverviewContext.Provider value={shared}>{children}</OverviewContext.Provider>;
}

function useOverview(): Shared {
  const shared = useContext(OverviewContext);
  if (!shared) {
    throw new Error("A delivery surface must be rendered inside <DeliveryOverviewProvider>.");
  }
  const { subscribe } = shared;
  useEffect(() => {
    subscribe();
  }, [subscribe]);
  return shared;
}

/** The delivery plan, as `GET /delivery-plan` answers it. */
export function useDeliveryPlanData(): OverviewSlice<DeliveryPlan> {
  const { overview, error, loading, refetch, retry } = useOverview();
  return { data: overview?.plan ?? null, error, loading, refetch, retry };
}

/** The decisions and approval states, as `GET /decisions` answers them.
 *  `mutate` applies a decision write's snapshot to every surface at once. */
export function useDecisionsData(): OverviewSlice<DecisionsOut> & {
  mutate: (snapshot: DecisionsOut) => void;
} {
  const { overview, error, loading, refetch, retry, applyDecisions } = useOverview();
  return { data: overview, error, loading, refetch, retry, mutate: applyDecisions };
}
