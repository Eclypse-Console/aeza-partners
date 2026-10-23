import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// Each brand installs its own private Aeza app from a link we send them, so
// there's no public landing page or shop-login form here. Requests from the
// Shopify admin (?shop=...) go straight into the embedded app.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function Index() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Aeza Partner</h1>
      <p>Please open Aeza from your Shopify admin.</p>
    </main>
  );
}
