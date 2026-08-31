import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          Discover Aeza — India&apos;s{" "}
          <span className={styles.accentGreen}>AI stylist</span> and
          multi-brand fashion marketplace
        </h1>
        <p className={styles.text}>
          We help your brand grow sales through AI-powered personalization —
          tailored outfit recommendations and virtual try-on that build
          shopper confidence, drive conversion, and reduce returns from
          sizing guesswork.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label} htmlFor="shop">
              Shop domain
            </label>
            <input
              id="shop"
              className={styles.input}
              type="text"
              name="shop"
              placeholder="my-shop-domain.myshopify.com"
            />
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li className={styles.listItem}>
            <strong className={styles.listItemTitle}>AI Stylist</strong>
            Conversational recommendations pulled straight from your
            catalog — more discovery, higher order value.
          </li>
          <li className={styles.listItem}>
            <strong className={styles.listItemTitle}>Virtual Try-On</strong>
            Shoppers see it on themselves before they buy — fewer size
            returns, stronger margins.
          </li>
          <li className={styles.listItem}>
            <strong className={styles.listItemTitle}>Dynamic Sizing</strong>
            Aeza learns your true fit, not a generic chart — fewer
            wrong-size orders, more repeat buyers.
          </li>
        </ul>
      </div>
    </div>
  );
}
