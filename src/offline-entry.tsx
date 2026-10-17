import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { CoveProvider, SiteShell } from "./features/fore/App";
import { ReaderPage } from "./features/fore/Reader";
import { DownloadsPage } from "./features/fore/Collections";
import "./styles.css";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <CoveProvider>
        <Outlet />
      </CoveProvider>
    </QueryClientProvider>
  ),
});
const saved = () => (
  <SiteShell active="/downloads" title="Saved books">
    <p role="status">
      You are using Cove’s offline reading app. Saved books remain on this device.
    </p>
    <p>
      <a href="/">Reconnect to online Cove</a>
    </p>
    <DownloadsPage />
  </SiteShell>
);
const read = createRoute({
  getParentRoute: () => root,
  path: "/read/$id",
  component: () => <ReaderPage id={read.useParams().id} />,
});
const home = createRoute({ getParentRoute: () => root, path: "/", component: saved });
const downloads = createRoute({ getParentRoute: () => root, path: "/downloads", component: saved });
const fallback = createRoute({ getParentRoute: () => root, path: "$", component: saved });
const router = createRouter({ routeTree: root.addChildren([home, downloads, read, fallback]) });
createRoot(document.getElementById("cove-offline-root")!).render(
  <RouterProvider router={router} />,
);
