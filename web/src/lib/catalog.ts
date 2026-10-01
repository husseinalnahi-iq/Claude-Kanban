import { useEffect, useState } from "react";
import type { ModelCatalogResult, Provider } from "../../../server/src/types.ts";
import { api } from "./api.ts";

/** One request per provider list per page load, shared by every picker on the page. */
const catalogs = new Map<string, Promise<ModelCatalogResult>>();

const keyOf = (p: Provider) => `${p.id}|${p.kind}|${p.baseUrl ?? ""}|${p.models.map((m) => m.id).join(",")}`;

function ask(p: Provider): Promise<ModelCatalogResult> {
  const key = keyOf(p);
  if (!catalogs.has(key)) {
    const req = api.providerModels(p.id);
    catalogs.set(key, req);
    req.catch(() => catalogs.delete(key));
  }
  return catalogs.get(key)!;
}

/** Several providers' lists at once (the chat picker and Settings → Model lists), sharing the same requests. */
export function useCatalogs(ps: Provider[]): Map<string, ModelCatalogResult> {
  const key = ps.map(keyOf).join(";");
  const [lists, setLists] = useState<Map<string, ModelCatalogResult>>(new Map());
  useEffect(() => {
    let live = true;
    void Promise.all(
      ps.map((p) =>
        ask(p).then(
          (r): [string, ModelCatalogResult] => [p.id, r],
          (err): [string, ModelCatalogResult] => [p.id, { source: "saved", models: [], error: err instanceof Error ? err.message : String(err) }],
        ),
      ),
    ).then(
      (pairs) => live && setLists(new Map(pairs)),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return lists;
}

/** What a provider can run right now (GET /providers/:id/models); null while it is being asked. */
export function useCatalog(p: Provider | undefined): { result: ModelCatalogResult | null; loading: boolean } {
  const key = p ? `${p.id}|${p.kind}|${p.baseUrl ?? ""}|${p.models.map((m) => m.id).join(",")}` : "";
  const [state, setState] = useState<{ key: string; result: ModelCatalogResult | null }>({ key: "", result: null });
  useEffect(() => {
    if (!p) return;
    let live = true;
    if (!catalogs.has(key)) {
      const req = api.providerModels(p.id);
      catalogs.set(key, req);
      // A failed request is not kept: the next picker to open asks again.
      req.catch(() => catalogs.delete(key));
    }
    catalogs.get(key)!.then(
      (result) => live && setState({ key, result }),
      (err) => live && setState({ key, result: { source: "saved", models: [], error: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return { result: state.key === key ? state.result : null, loading: Boolean(p) && state.key !== key };
}
